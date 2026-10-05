import json
import hashlib
import hmac
import os
import secrets
import socket
import sqlite3
import threading
import time
from http.cookies import SimpleCookie
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "estoque.db"
PRODUCT_IMAGES_DIR = DATA_DIR / "product-images"
HOST = "0.0.0.0"
PORT = 8090
EMPTY_STATE = {"products": [], "movements": [], "categories": [], "sellers": []}
SESSION_TTL = 8 * 60 * 60
ADMIN_SESSIONS = {}
SESSION_LOCK = threading.Lock()
STATE_CHANGE = threading.Condition()


def connect():
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=10000")
    return connection


def initialize_database():
    DATA_DIR.mkdir(exist_ok=True)
    PRODUCT_IMAGES_DIR.mkdir(exist_ok=True)
    with connect() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS app_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                revision INTEGER NOT NULL,
                data_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            INSERT OR IGNORE INTO app_state (id, revision, data_json, updated_at)
            VALUES (1, 0, ?, ?)
            """,
            (json.dumps(EMPTY_STATE, ensure_ascii=False), datetime.now(timezone.utc).isoformat()),
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS admin_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )


def password_hash(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 210_000).hex()


def admin_configured():
    with connect() as connection:
        return connection.execute("SELECT 1 FROM admin_config WHERE id = 1").fetchone() is not None


def verify_admin_password(password):
    with connect() as connection:
        row = connection.execute("SELECT salt, password_hash FROM admin_config WHERE id = 1").fetchone()
    return bool(row) and hmac.compare_digest(password_hash(password, row[0]), row[1])


def read_state(connection):
    row = connection.execute(
        "SELECT revision, data_json, updated_at FROM app_state WHERE id = 1"
    ).fetchone()
    state = json.loads(row[1])
    state["revision"] = row[0]
    state["updatedAt"] = row[2]
    return state


def referenced_product_image_names(state):
    names = set()
    for product in state.get("products", []):
        urls = [product.get("imageUrl", "")]
        urls.extend(variant.get("imageUrl", "") for variant in product.get("variants", []))
        for image_url in urls:
            if not isinstance(image_url, str) or not image_url.startswith("/product-images/"):
                continue
            file_name = Path(image_url).name
            if file_name == image_url.removeprefix("/product-images/"):
                names.add(file_name)
    return names


def cleanup_orphan_product_images(state, minimum_age_seconds=300):
    referenced = referenced_product_image_names(state)
    removed = 0
    now = time.time()
    for file_path in PRODUCT_IMAGES_DIR.iterdir():
        if not file_path.is_file() or file_path.suffix.lower() not in {".webp", ".jpg", ".png"}:
            continue
        if file_path.name in referenced:
            continue
        try:
            if minimum_age_seconds and now - file_path.stat().st_mtime < minimum_age_seconds:
                continue
            file_path.unlink()
            removed += 1
        except OSError:
            pass
    return removed


class InventoryHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        path = urlparse(self.path).path
        if path.startswith("/product-images/"):
            self.send_header("Cache-Control", "public, max-age=604800, immutable")
        else:
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def send_json(self, status, payload, headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 5_000_000:
            raise ValueError("Conteúdo inválido.")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def read_binary_body(self, max_size=3_000_000):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > max_size:
            raise ValueError("A imagem deve ter no máximo 3 MB.")
        return self.rfile.read(length)

    def send_image_file(self, file_path, content_type):
        try:
            body = file_path.read_bytes()
        except OSError:
            return self.send_error(404)
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def stream_state_events(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        raw_revision = self.headers.get("Last-Event-ID") or query.get("revision", ["-1"])[0]
        try:
            last_revision = int(raw_revision)
        except (TypeError, ValueError):
            last_revision = -1

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        try:
            while True:
                with STATE_CHANGE:
                    with connect() as connection:
                        current_revision = connection.execute(
                            "SELECT revision FROM app_state WHERE id = 1"
                        ).fetchone()[0]
                    if current_revision <= last_revision:
                        changed = STATE_CHANGE.wait(timeout=20)
                    else:
                        changed = True
                if current_revision > last_revision:
                    payload = json.dumps({"revision": current_revision}, separators=(",", ":"))
                    self.wfile.write(
                        f"id: {current_revision}\nevent: state\ndata: {payload}\n\n".encode("utf-8")
                    )
                    self.wfile.flush()
                    last_revision = current_revision
                if not changed:
                    self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return
        finally:
            self.close_connection = True

    def session_token(self):
        cookie = SimpleCookie()
        cookie.load(self.headers.get("Cookie", ""))
        morsel = cookie.get("estoque_admin")
        return morsel.value if morsel else None

    def admin_authenticated(self):
        token = self.session_token()
        if not token:
            return False
        now = time.time()
        with SESSION_LOCK:
            expires_at = ADMIN_SESSIONS.get(token, 0)
            if expires_at <= now:
                ADMIN_SESSIONS.pop(token, None)
                return False
            ADMIN_SESSIONS[token] = now + SESSION_TTL
        return True

    def is_local_request(self):
        return self.client_address[0] in {"127.0.0.1", "::1", local_ip()}

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            return self.send_json(200, {"ok": True})
        if path == "/api/admin/status":
            return self.send_json(200, {
                "configured": admin_configured(),
                "authenticated": self.admin_authenticated(),
                "canSetup": self.is_local_request(),
            })
        if path == "/api/state/version":
            with connect() as connection:
                revision, updated_at = connection.execute(
                    "SELECT revision, updated_at FROM app_state WHERE id = 1"
                ).fetchone()
            return self.send_json(200, {"revision": revision, "updatedAt": updated_at})
        if path == "/api/events":
            return self.stream_state_events()
        if path == "/api/state":
            with connect() as connection:
                return self.send_json(200, read_state(connection))
        if path.startswith("/product-images/"):
            file_name = Path(path).name
            if file_name != path.removeprefix("/product-images/"):
                return self.send_error(404)
            extension = Path(file_name).suffix.lower()
            content_type = {".webp": "image/webp", ".jpg": "image/jpeg", ".png": "image/png"}.get(extension)
            if not content_type:
                return self.send_error(404)
            return self.send_image_file(PRODUCT_IMAGES_DIR / file_name, content_type)
        if path.startswith("/data/"):
            return self.send_error(404)
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/admin/setup":
            if admin_configured():
                return self.send_json(409, {"error": "A senha administrativa já foi configurada."})
            if not self.is_local_request():
                return self.send_json(403, {"error": "Configure a senha neste computador usando http://localhost:8090/."})
            try:
                password = str(self.read_json_body().get("password", ""))
                if len(password) < 4:
                    return self.send_json(400, {"error": "A senha deve ter pelo menos 4 caracteres."})
                salt = secrets.token_hex(16)
                with connect() as connection:
                    connection.execute(
                        "INSERT INTO admin_config (id, salt, password_hash, created_at) VALUES (1, ?, ?, ?)",
                        (salt, password_hash(password, salt), datetime.now(timezone.utc).isoformat()),
                    )
                return self.create_admin_session()
            except (ValueError, json.JSONDecodeError):
                return self.send_json(400, {"error": "Não foi possível interpretar os dados."})
        if path == "/api/admin/login":
            try:
                password = str(self.read_json_body().get("password", ""))
                if not verify_admin_password(password):
                    return self.send_json(401, {"error": "Senha incorreta."})
                return self.create_admin_session()
            except (ValueError, json.JSONDecodeError):
                return self.send_json(400, {"error": "Não foi possível interpretar os dados."})
        if path == "/api/admin/logout":
            token = self.session_token()
            with SESSION_LOCK:
                ADMIN_SESSIONS.pop(token, None)
            return self.send_json(200, {"ok": True}, {
                "Set-Cookie": "estoque_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
            })
        if path == "/api/product-image":
            if not self.admin_authenticated():
                return self.send_json(403, {"error": "Acesso administrativo necessário."})
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].lower()
            extension = {"image/webp": ".webp", "image/jpeg": ".jpg", "image/png": ".png"}.get(content_type)
            if not extension:
                return self.send_json(415, {"error": "Use uma imagem JPG, PNG ou WebP."})
            try:
                body = self.read_binary_body()
                valid = (
                    extension == ".webp" and body[:4] == b"RIFF" and body[8:12] == b"WEBP"
                    or extension == ".jpg" and body[:3] == b"\xff\xd8\xff"
                    or extension == ".png" and body[:8] == b"\x89PNG\r\n\x1a\n"
                )
                if not valid:
                    return self.send_json(400, {"error": "O arquivo enviado não é uma imagem válida."})
                file_name = f"product-{secrets.token_hex(16)}{extension}"
                (PRODUCT_IMAGES_DIR / file_name).write_bytes(body)
                return self.send_json(201, {"ok": True, "url": f"/product-images/{file_name}"})
            except ValueError as error:
                return self.send_json(400, {"error": str(error)})
            except OSError:
                return self.send_json(500, {"error": "Não foi possível salvar a imagem."})
        if path == "/api/product-image/delete":
            if not self.admin_authenticated():
                return self.send_json(403, {"error": "Acesso administrativo necessário."})
            try:
                image_url = str(self.read_json_body().get("url", ""))
                prefix = "/product-images/"
                file_name = Path(image_url).name
                if not image_url.startswith(prefix) or file_name != image_url.removeprefix(prefix):
                    return self.send_json(400, {"error": "Endereço de imagem inválido."})
                file_path = PRODUCT_IMAGES_DIR / file_name
                if file_path.exists():
                    file_path.unlink()
                return self.send_json(200, {"ok": True})
            except (ValueError, json.JSONDecodeError):
                return self.send_json(400, {"error": "Não foi possível interpretar os dados."})
        if path != "/api/state":
            return self.send_json(404, {"error": "Rota não encontrada."})
        try:
            payload = self.read_json_body()
            expected_revision = int(payload.get("revision", -1))
            state = {key: payload.get(key, []) for key in ("products", "movements", "categories", "sellers")}
            if not all(isinstance(value, list) for value in state.values()):
                return self.send_json(400, {"error": "Estrutura de dados inválida."})

            with connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                current_revision = connection.execute(
                    "SELECT revision FROM app_state WHERE id = 1"
                ).fetchone()[0]
                if current_revision != expected_revision:
                    connection.rollback()
                    return self.send_json(
                        409,
                        {"error": "Os dados foram alterados em outro computador.", "currentRevision": current_revision},
                    )
                new_revision = current_revision + 1
                updated_at = datetime.now(timezone.utc).isoformat()
                connection.execute(
                    "UPDATE app_state SET revision = ?, data_json = ?, updated_at = ? WHERE id = 1",
                    (new_revision, json.dumps(state, ensure_ascii=False, separators=(",", ":")), updated_at),
                )
                connection.commit()
            with STATE_CHANGE:
                STATE_CHANGE.notify_all()
            cleanup_orphan_product_images(state)
            return self.send_json(200, {"ok": True, "revision": new_revision, "updatedAt": updated_at})
        except (ValueError, json.JSONDecodeError):
            return self.send_json(400, {"error": "Não foi possível interpretar os dados."})
        except Exception as error:
            return self.send_json(500, {"error": f"Falha interna: {error}"})

    def create_admin_session(self):
        token = secrets.token_urlsafe(32)
        with SESSION_LOCK:
            ADMIN_SESSIONS[token] = time.time() + SESSION_TTL
        return self.send_json(200, {"ok": True, "authenticated": True}, {
            "Set-Cookie": f"estoque_admin={token}; Path=/; HttpOnly; SameSite=Strict",
        })

    def log_message(self, format_string, *args):
        print(f"[{self.log_date_time_string()}] {format_string % args}")


def local_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(1)
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return "IP-DESTE-COMPUTADOR"


if __name__ == "__main__":
    os.chdir(ROOT)
    initialize_database()
    with connect() as connection:
        removed_images = cleanup_orphan_product_images(read_state(connection), minimum_age_seconds=0)
    print("Sistema de Estoque - Disque Cópias")
    if removed_images:
        print(f"Limpeza de imagens: {removed_images} arquivo(s) sem vínculo removido(s).")
    print(f"Acesso neste computador: http://localhost:{PORT}/")
    print(f"Acesso nos outros computadores: http://{local_ip()}:{PORT}/")
    print("Mantenha esta janela aberta enquanto o sistema estiver em uso.")
    ThreadingHTTPServer((HOST, PORT), InventoryHandler).serve_forever()
