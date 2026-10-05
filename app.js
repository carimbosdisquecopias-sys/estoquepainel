const KEYS = {
  products: "estoque-carimbos-products-v2",
  movements: "estoque-carimbos-movements-v2",
  categories: "estoque-carimbos-categories-v2",
  sellers: "estoque-carimbos-sellers-v2",
};
const PERFORMANCE_MODE_KEY = "estoque-carimbos-performance-mode";

const legacyState = {
  products: load(KEYS.products, []),
  movements: load(KEYS.movements, []),
  categories: load(KEYS.categories, []),
  sellers: load(KEYS.sellers, []),
};
let products = [];
let movements = [];
let categories = [];
let sellers = [];
let revision = 0;
let saveQueue = Promise.resolve();
let pendingSaveCount = 0;
let sharedSyncInProgress = false;
let sharedEventSource = null;
let sharedFallbackTimer = null;
let performanceMode = false;
legacyState.movements = legacyState.movements.map(movement => {
  if (!movement.sellerId || movement.sellerName) return movement;
  const seller = legacyState.sellers.find(item => item.id === movement.sellerId);
  return { ...movement, sellerName: seller?.name || "Atendente excluído" };
});
let editingProductId = null;
let editingCategoryId = null;
let editingSellerId = null;
let reversingMovementId = null;
let adminAuthenticated = false;
let adminSetupMode = false;
let confirmationResolver = null;
let productDraftColors = [];
let movementDraftItems = [];
let movementSelectedVariantIds = new Set();
let rgbPickerState = { h: 218, s: 26, v: 17 };
let rgbPickerChannel = "primary";
let draggedProductId = null;
let draggedProductTargetId = null;
let draggedProductInsertAfter = false;
let draggedProductPointerId = null;
let removeEditingProductImage = false;
let productImageObjectUrl = null;
let editProductImageObjectUrl = null;
let registrationVariantFiles = new Map();
let registrationVariantPreviewUrls = new Map();
let registrationColorProductId = null;
let historyHighlightTimer = null;
let historyDateStart = "";
let historyDateEnd = "";
let historyMonthSelection = "";
let historyRenderSignature = "";
let summaryChartMode = "products";
let summaryMovementType = "saida";
let historyDisplayMode = "table";
let catalogCanvas = null;
let catalogProduct = null;
const migrationDate = new Date().toISOString();
legacyState.products = legacyState.products.map(product => ({ ...product, createdAt: product.createdAt || migrationDate }));

function setSystemStatus(online) {
  const dot = document.querySelector("#systemStatusDot");
  if (!dot) return;
  dot.classList.toggle("online", online);
  dot.classList.toggle("offline", !online);
  const label = online ? "Sistema ativo" : "Sistema inativo";
  dot.setAttribute("aria-label", label);
  dot.title = label;
}

function readPerformanceMode() {
  try {
    return localStorage.getItem(PERFORMANCE_MODE_KEY) === "true";
  } catch {
    return false;
  }
}

function applyPerformanceMode(enabled, announce = false) {
  performanceMode = Boolean(enabled);
  document.body.classList.toggle("performance-mode", performanceMode);
  const button = document.querySelector("#performanceModeButton");
  button.classList.toggle("active", performanceMode);
  button.setAttribute("aria-pressed", String(performanceMode));
  button.setAttribute("aria-label", performanceMode ? "Desativar modo desempenho" : "Ativar modo desempenho");
  try {
    localStorage.setItem(PERFORMANCE_MODE_KEY, String(performanceMode));
  } catch {
    // A preferência continua ativa até a página ser fechada.
  }
  if (announce) toast(`Modo desempenho ${performanceMode ? "ativado" : "desativado"}.`);
}

function load(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function applyState(state) {
  const fallbackDate = state.updatedAt || migrationDate;
  const normalized = normalizeInventory(state.products || [], state.movements || [], fallbackDate);
  products = normalized.products;
  movements = normalized.movements;
  categories = (state.categories || []).map(category => ({
    ...category,
    createdAt: category.createdAt || fallbackDate,
  }));
  sellers = (state.sellers || []).map(seller => ({
    ...seller,
    createdAt: seller.createdAt || fallbackDate,
  }));
  revision = state.revision ?? revision;
}

function normalizeInventory(rawProducts, rawMovements, fallbackDate) {
  const normalizedProducts = [];
  const legacyProductMap = new Map();

  rawProducts.forEach(rawProduct => {
    if (Array.isArray(rawProduct.variants)) {
      const product = {
        ...rawProduct,
        createdAt: rawProduct.createdAt || fallbackDate,
        variants: rawProduct.variants.map(variant => ({
          ...variant,
          id: variant.id || id("VAR"),
          color: variant.color?.trim() || "Sem cor",
          rgb: variant.rgb || colorSwatch(variant.color),
          rgb2: /^#[0-9a-f]{6}$/i.test(variant.rgb2 || "") ? variant.rgb2 : "",
          imageUrl: variant.imageUrl || "",
          stock: Number(variant.stock) || 0,
          createdAt: variant.createdAt || rawProduct.createdAt || fallbackDate,
        })),
      };
      normalizedProducts.push(product);
      legacyProductMap.set(rawProduct.id, {
        productId: product.id,
        variantId: product.variants[0]?.id,
        variantColor: product.variants[0]?.color,
      });
      return;
    }

    const key = [
      rawProduct.categoryId || rawProduct.category,
      rawProduct.name,
      rawProduct.size || "",
    ].map(value => String(value || "").trim().toLowerCase()).join("|");
    let product = normalizedProducts.find(item => item.migrationKey === key);
    if (!product) {
      product = {
        id: rawProduct.id,
        name: rawProduct.name,
        category: rawProduct.category,
        categoryId: rawProduct.categoryId,
        size: rawProduct.size || "",
        createdAt: rawProduct.createdAt || fallbackDate,
        variants: [],
        migrationKey: key,
      };
      normalizedProducts.push(product);
    }
    const variant = {
      id: `VAR-${rawProduct.id}`,
      color: rawProduct.color?.trim() || "Sem cor",
      rgb: rawProduct.rgb || colorSwatch(rawProduct.color),
      rgb2: /^#[0-9a-f]{6}$/i.test(rawProduct.rgb2 || "") ? rawProduct.rgb2 : "",
      stock: Number(rawProduct.stock) || 0,
      createdAt: rawProduct.createdAt || fallbackDate,
    };
    product.variants.push(variant);
    legacyProductMap.set(rawProduct.id, {
      productId: product.id,
      variantId: variant.id,
      variantColor: variant.color,
    });
  });

  normalizedProducts.forEach(product => { delete product.migrationKey; });
  const normalizedMovements = rawMovements.map(movement => {
    if (movement.variantId) return movement;
    const mapping = legacyProductMap.get(movement.productId);
    return mapping ? {
      ...movement,
      productId: mapping.productId,
      variantId: mapping.variantId,
      variantColor: movement.variantColor || mapping.variantColor,
    } : movement;
  }).map(movement => movement.reversedBy && movement.reversed !== true
    ? { ...movement, reversed: true }
    : movement).map(movement => movement.type === "entrada" && movement.stockCorrection
    ? { ...movement, stockCorrection: false }
    : movement);
  return { products: normalizedProducts, movements: normalizedMovements };
}

async function fetchState() {
  const response = await fetch("/api/state", { cache: "no-store" });
  if (!response.ok) throw new Error("Banco de dados indisponível.");
  return response.json();
}

async function fetchAdminStatus() {
  const response = await fetch("/api/admin/status", { cache: "no-store" });
  if (!response.ok) throw new Error("Não foi possível verificar o acesso administrativo.");
  return response.json();
}

function syncHistoryDescription() {
  document.querySelector("#historyDescription").textContent = historyDisplayMode === "summary"
    ? "Resumo visual das movimentações registradas no Histórico."
    : adminAuthenticated
      ? "O histórico registra entradas, saídas, estornos e configurações do painel."
      : "O histórico registra entradas, saídas e estornos.";
}

function applyAdminAccess(authenticated) {
  adminAuthenticated = authenticated;
  document.querySelector("#registrationNavButton").hidden = !authenticated;
  document.querySelector("#clearMovementsButton").hidden = !authenticated;
  document.querySelector(".history-actions").classList.toggle("admin-actions", authenticated);
  const configurationOption = document.querySelector('#historyFilterMenu [data-value="configuracao"]');
  const configurationSelectOption = document.querySelector('#historyFilter option[value="configuracao"]');
  configurationOption.hidden = !authenticated;
  configurationSelectOption.disabled = !authenticated;
  syncHistoryDescription();
  if (!authenticated && document.querySelector("#historyFilter").value === "configuracao") setHistoryFilter("");
  const button = document.querySelector("#adminAccessButton");
  button.classList.toggle("authenticated", authenticated);
  button.dataset.tooltip = authenticated ? "Abrir Cadastro" : "Acesso administrativo";
  button.setAttribute("aria-label", authenticated ? "Abrir Cadastro" : "Acesso administrativo");
  if (performanceMode) renderViewData(activeViewName());
  else {
    renderProducts();
    renderMovements();
    renderDashboard();
  }
  if (!authenticated && document.querySelector("#registrationsView").classList.contains("active")) {
    showView("dashboard");
  }
}

async function initialize() {
  try {
    const [loadedState, adminStatus] = await Promise.all([
      fetchState(),
      fetchAdminStatus().catch(() => ({ configured: false, authenticated: false, canSetup: false })),
    ]);
    let state = loadedState;
    const databaseEmpty = ["products", "movements", "categories", "sellers"]
      .every(key => !state[key]?.length);
    const legacyHasData = Object.values(legacyState).some(items => items.length);
    if (databaseEmpty && legacyHasData) {
      const response = await fetch("/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...legacyState, revision: state.revision }),
      });
      if (response.ok) state = await fetchState();
    }
    const needsCreationDates = [...(state.categories || []), ...(state.sellers || [])]
      .some(item => !item.createdAt);
    const needsVariantMigration =
      (state.products || []).some(product => !Array.isArray(product.variants)) ||
      (state.movements || []).some(movement =>
        ["entrada", "saida", "estorno"].includes(movement.type) &&
        movement.productId &&
        !movement.variantId
      );
    const needsReversalMigration = (state.movements || []).some(movement => movement.reversedBy && movement.reversed !== true);
    const needsEntryCorrectionMigration = (state.movements || [])
      .some(movement => movement.type === "entrada" && movement.stockCorrection);
    applyState(state);
    setSystemStatus(true);
    applyAdminAccess(adminStatus.authenticated);
    renderAll();
    if (needsCreationDates || needsVariantMigration || needsReversalMigration || needsEntryCorrectionMigration) await save();
  } catch {
    setSystemStatus(false);
    renderAll();
    toast("Não foi possível conectar ao banco. Abra o sistema pelo INICIAR-SISTEMA.bat.");
  } finally {
    startSharedSync();
  }
}

function save() {
  const snapshot = JSON.parse(JSON.stringify({ products, movements, categories, sellers }));
  pendingSaveCount += 1;
  saveQueue = saveQueue.then(async () => {
    const response = await fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...snapshot, revision }),
    });
    if (response.status === 409) {
      applyState(await fetchState());
      setSystemStatus(true);
      renderAll();
      toast("Outro computador atualizou o estoque. Os dados foram recarregados; repita sua última ação.");
      return;
    }
    if (!response.ok) throw new Error("Falha ao salvar.");
    revision = (await response.json()).revision;
    setSystemStatus(true);
  }).catch(() => {
    setSystemStatus(false);
    toast("Não foi possível salvar no banco compartilhado.");
  })
    .finally(() => { pendingSaveCount = Math.max(0, pendingSaveCount - 1); });
  return saveQueue;
}

function activeViewName() {
  return document.querySelector(".view.active")?.id.replace(/View$/, "") || "dashboard";
}

function renderViewData(name) {
  if (name === "dashboard") renderDashboard();
  if (name === "products") renderProducts();
  if (name === "movements") {
    if (historyDisplayMode === "summary") renderSummary();
    else renderMovements();
  }
  if (name === "registrations") {
    renderRegistrations();
    renderProductDraftColors();
  }
}

function renderSharedUpdate() {
  const activeForm = document.activeElement?.closest("form");
  const openDialog = document.querySelector("dialog[open]");
  if (!activeForm && !openDialog) refreshSelects();
  renderViewData(activeViewName());
  if (document.querySelector("#zeroStockDialog[open]")) renderZeroStockTable();
}

async function syncSharedState(knownRevision = null) {
  if (sharedSyncInProgress || pendingSaveCount || draggedProductId || document.hidden) return;
  sharedSyncInProgress = true;
  try {
    let remoteRevision = Number(knownRevision);
    if (!Number.isFinite(remoteRevision)) {
      const versionResponse = await fetch("/api/state/version", { cache: "no-store" });
      if (!versionResponse.ok) {
        setSystemStatus(false);
        return;
      }
      const remoteVersion = await versionResponse.json();
      remoteRevision = Number(remoteVersion.revision);
    }
    setSystemStatus(true);
    if (remoteRevision <= revision) return;
    const state = await fetchState();
    if (Number(state.revision) <= revision) return;
    applyState(state);
    renderSharedUpdate();
  } catch {
    setSystemStatus(false);
    // A próxima verificação tentará novamente sem interromper o uso do painel.
  } finally {
    sharedSyncInProgress = false;
  }
}

function startSharedSync() {
  if (sharedEventSource || sharedFallbackTimer) return;
  if ("EventSource" in window) {
    sharedEventSource = new EventSource(`/api/events?revision=${encodeURIComponent(revision)}`);
    sharedEventSource.addEventListener("state", event => {
      try {
        syncSharedState(Number(JSON.parse(event.data).revision));
      } catch {
        syncSharedState();
      }
    });
    sharedEventSource.onopen = () => setSystemStatus(true);
    sharedEventSource.onerror = () => {
      window.setTimeout(() => {
        if (sharedEventSource?.readyState !== EventSource.OPEN) setSystemStatus(false);
      }, 3000);
    };
  }
  sharedFallbackTimer = window.setInterval(syncSharedState, 30000);
  window.addEventListener("focus", syncSharedState);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncSharedState();
  });
}

function id(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, char => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]
  ));
}

function normalizedSearch(value = "") {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
}

function panelTerminology(value = "") {
  return String(value)
    .replace(/Vendedores/g, "Atendentes")
    .replace(/vendedores/g, "atendentes")
    .replace(/Vendedor/g, "Atendente")
    .replace(/vendedor/g, "atendente");
}

function productImageMarkup(product, className = "product-thumbnail") {
  return product?.imageUrl
    ? `<button type="button" class="product-image-button ${className}" data-image-url="${esc(product.imageUrl)}" data-image-title="${esc(product.name)}" data-image-size="${esc(product.size || "")}" aria-label="Ampliar imagem de ${esc(product.name)}"><img src="${esc(product.imageUrl)}" alt="${esc(product.name)}" loading="lazy" decoding="async" /></button>`
    : `<span class="product-image-placeholder ${className}" aria-hidden="true">${icon("package")}</span>`;
}

function linkedVariantImageMarkup(product, variant, className) {
  const imageUrl = variant?.imageUrl || product?.imageUrl || "";
  if (!imageUrl) return `<span class="product-image-placeholder ${className}" aria-hidden="true">${icon("package")}</span>`;
  const hasVariantImage = Boolean(variant?.imageUrl);
  const title = hasVariantImage && variant?.color ? `${product.name} · ${variant.color}` : product.name;
  return `<button type="button" class="product-image-button ${className}" data-image-url="${esc(imageUrl)}" data-image-title="${esc(title)}" data-image-size="${esc(product.size || "")}" aria-label="Ampliar imagem de ${esc(title)}"><img src="${esc(imageUrl)}" alt="${esc(title)}" loading="lazy" decoding="async" /></button>`;
}

function productImageStaticMarkup(product, className) {
  return product?.imageUrl
    ? `<span class="product-image-static ${className}"><img src="${esc(product.imageUrl)}" alt="" loading="lazy" decoding="async" /></span>`
    : `<span class="product-image-placeholder ${className}" aria-hidden="true">${icon("package")}</span>`;
}

function movementVariantVisualMarkup(variant) {
  return variant?.imageUrl
    ? `<span class="movement-variant-image"><img src="${esc(variant.imageUrl)}" alt="" loading="lazy" decoding="async" /></span>`
    : `<span class="color-dot large" style="${swatchStyle(variant)}"></span>`;
}

function replacePreviewObjectUrl(currentUrl, file) {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  return file ? URL.createObjectURL(file) : null;
}

function renderImagePreview(container, source, title = "Prévia do produto") {
  container.innerHTML = source
    ? `<img src="${esc(source)}" alt="${esc(title)}" />`
    : `${icon("package")}`;
  container.classList.toggle("has-image", Boolean(source));
}

async function optimizeProductImage(file) {
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Escolha uma imagem JPG, PNG ou WebP.");
  }
  if (file.size > 8_000_000) throw new Error("A imagem original deve ter no máximo 8 MB.");
  const bitmap = await createImageBitmap(file);
  const size = 500;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size, size);
  const scale = Math.min(size / bitmap.width, size / bitmap.height);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  context.drawImage(bitmap, Math.round((size - width) / 2), Math.round((size - height) / 2), width, height);
  bitmap.close?.();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/webp", .84));
  if (!blob) throw new Error("Não foi possível preparar a imagem.");
  return blob;
}

async function uploadProductImage(file) {
  const blob = await optimizeProductImage(file);
  const response = await fetch("/api/product-image", { method: "POST", headers: { "Content-Type": "image/webp" }, body: blob });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Não foi possível enviar a imagem.");
  return result.url;
}

async function deleteProductImage(imageUrl) {
  if (!imageUrl) return;
  await fetch("/api/product-image/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: imageUrl }),
  }).catch(() => {});
}

function icon(name) {
  return `<span class="ui-icon icon-${name}" aria-hidden="true"></span>`;
}

function empty(text) {
  return `<div class="empty">${text}</div>`;
}

function statusOf(product) {
  return totalStock(product) > 0
    ? { key: "ok", label: "Disponível" }
    : { key: "zero", label: "Zerado" };
}

function totalStock(product) {
  return (product.variants || []).reduce((total, variant) => total + Number(variant.stock || 0), 0);
}

function findVariant(product, variantId) {
  return product?.variants?.find(variant => variant.id === variantId);
}

function colorSwatch(color = "", rgb = "") {
  if (/^#[0-9a-f]{6}$/i.test(rgb)) return rgb;
  const normalized = color.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const palette = {
    preto: "#20242b", azul: "#3167c6", vermelho: "#d83a32", verde: "#319467",
    amarelo: "#edc949", laranja: "#ed7a2d", rosa: "#df6e9e", roxo: "#7a55b6",
    cinza: "#87918d", branco: "#ffffff", marrom: "#855a3b",
  };
  const key = Object.keys(palette).find(name => normalized.includes(name));
  return palette[key] || "#8a94a8";
}

function swatchStyle(variant = {}) {
  const primary = colorSwatch(variant.color, variant.rgb);
  const secondary = /^#[0-9a-f]{6}$/i.test(variant.rgb2 || "") ? variant.rgb2 : primary;
  return `--swatch:${primary};--swatch-2:${secondary}`;
}

function colorRgbLabel(variant = {}) {
  const primary = colorSwatch(variant.color, variant.rgb).toUpperCase();
  return variant.rgb2 ? `${primary} + ${variant.rgb2.toUpperCase()}` : primary;
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return { r: parseInt(value.slice(0, 2), 16), g: parseInt(value.slice(2, 4), 16), b: parseInt(value.slice(4, 6), 16) };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map(value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")).join("")}`;
}

function rgbToHsv({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let h = 0;
  if (delta) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max ? (delta / max) * 100 : 0, v: max * 100 };
}

function hsvToRgb({ h, s, v }) {
  s /= 100; v /= 100;
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let values = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (values[0] + m) * 255, g: (values[1] + m) * 255, b: (values[2] + m) * 255 };
}

function syncRgbPicker(rgb, updateState = true) {
  const normalized = rgbToHex(rgb);
  if (updateState) rgbPickerState = rgbToHsv(rgb);
  const target = rgbPickerChannel === "secondary" ? "#productColorRgb2" : "#productColorRgb";
  document.querySelector(target).value = normalized;
  refreshRgbBuilder();
  document.querySelector("#rgbPreview").style.setProperty("--swatch", normalized);
  document.querySelector("#rgbHue").value = Math.round(rgbPickerState.h);
  document.querySelector("#rgbSaturation").style.setProperty("--hue", `hsl(${rgbPickerState.h} 100% 50%)`);
  document.querySelector("#rgbSaturationCursor").style.left = `${rgbPickerState.s}%`;
  document.querySelector("#rgbSaturationCursor").style.top = `${100 - rgbPickerState.v}%`;
  document.querySelector("#rgbRed").value = Math.round(rgb.r);
  document.querySelector("#rgbGreen").value = Math.round(rgb.g);
  document.querySelector("#rgbBlue").value = Math.round(rgb.b);
}

function refreshRgbBuilder() {
  const primary = document.querySelector("#productColorRgb").value || "#20242b";
  const secondary = document.querySelector("#productColorRgb2").value;
  const swatch = document.querySelector("#rgbTriggerSwatch");
  swatch.style.setProperty("--swatch", primary);
  swatch.style.setProperty("--swatch-2", secondary || primary);
  document.querySelector("#productColorHex").value = secondary
    ? `${primary.toUpperCase()} + ${secondary.toUpperCase()}`
    : primary.toUpperCase();
  document.querySelector("#secondaryRgbTab").hidden = !secondary;
  document.querySelector("#removeSecondRgb").hidden = !secondary;
  document.querySelector("#addSecondRgb").classList.toggle("active", Boolean(secondary));
}

function selectRgbChannel(channel) {
  const secondary = document.querySelector("#productColorRgb2").value;
  rgbPickerChannel = channel === "secondary" && secondary ? "secondary" : "primary";
  document.querySelectorAll("[data-rgb-channel]").forEach(button => button.classList.toggle("active", button.dataset.rgbChannel === rgbPickerChannel));
  const hex = rgbPickerChannel === "secondary" ? secondary : document.querySelector("#productColorRgb").value;
  syncRgbPicker(hexToRgb(hex || "#20242b"));
}

function typeLabel(type) {
  return {
    entrada: "Entrada",
    saida: "Saída",
    estorno: "Estorno",
    configuracao: "Configuração",
  }[type] || type;
}

function movementIsReversed(movement) {
  return Boolean(movement?.reversed || movement?.reversedBy);
}

function removeMovementRecord(movementId, sourceMovements = movements) {
  const movement = sourceMovements.find(item => item.id === movementId);
  if (!movement) return sourceMovements;
  if (movement.reversalOf) {
    const original = sourceMovements.find(item => item.id === movement.reversalOf);
    if (original) original.reversed = true;
  }
  return sourceMovements.filter(item => item.id !== movementId);
}

function linkedReversibleMovements(movement) {
  if (!movement?.batchId) return [];
  return movements.filter(item =>
    item.id !== movement.id &&
    item.batchId === movement.batchId &&
    !movementIsReversed(item) &&
    ["entrada", "saida"].includes(item.type) &&
    products.some(product => product.id === item.productId && findVariant(product, item.variantId))
  );
}

function syncLinkedReversalOption(movement) {
  const linked = linkedReversibleMovements(movement);
  const option = document.querySelector("#reversalLinkedOption");
  const checkbox = document.querySelector("#reversalIncludeLinked");
  checkbox.checked = false;
  option.hidden = !linked.length;
  if (!linked.length) return;
  const count = linked.length;
  document.querySelector("#reversalLinkedTitle").textContent =
    `Estornar também ${count} ${count === 1 ? "item vinculado" : "itens vinculados"}`;
  document.querySelector("#reversalLinkedDescription").textContent =
    count === 1
      ? "Este item foi lançado na mesma comanda e será estornado junto."
      : "Estes itens foram lançados na mesma comanda e serão estornados juntos.";
}

function formatDate(value) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function localDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function movementMonthKey(value) {
  return localDateKey(value).slice(0, 7) || "sem-data";
}

function movementMonthLabel(key) {
  if (!/^\d{4}-\d{2}$/.test(key)) return "Data não informada";
  const [year, month] = key.split("-").map(Number);
  const label = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" })
    .format(new Date(year, month - 1, 1));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function movementMatchesHistoryPeriod(movement) {
  if (!historyDateStart || !historyDateEnd) return true;
  const key = localDateKey(movement.date);
  return Boolean(key) && key >= historyDateStart && key <= historyDateEnd;
}

function syncHistoryPeriodUI() {
  const active = Boolean(historyDateStart && historyDateEnd);
  document.querySelector("#historyPeriodFilter").classList.toggle("active", active);
  document.querySelector("#clearHistoryPeriod").hidden = !active;
}

function clearHistoryPeriod(render = true) {
  historyDateStart = "";
  historyDateEnd = "";
  historyMonthSelection = "";
  document.querySelector("#historyStartDate").value = "";
  document.querySelector("#historyEndDate").value = "";
  syncHistoryPeriodUI();
  if (render) renderMovements();
}

function applyHistoryPeriod() {
  const start = document.querySelector("#historyStartDate").value;
  const end = document.querySelector("#historyEndDate").value;
  if (!start && !end) {
    clearHistoryPeriod();
    return toast("Filtro de período removido.");
  }
  if (!start || !end) return toast("Selecione a data inicial e a data final.");
  if (start > end) return toast("A data inicial deve ser anterior à data final.");
  historyDateStart = start;
  historyDateEnd = end;
  historyMonthSelection = "all";
  syncHistoryPeriodUI();
  renderMovements();
  toast("Período aplicado ao Histórico.");
}

function movementSellerName(movement) {
  return panelTerminology(movement.sellerName
    || sellers.find(seller => seller.id === movement.sellerId)?.name
    || "Atendente excluído");
}

function reportDate() {
  return new Date().toISOString().slice(0, 10);
}

function safeFilename(value) {
  return String(value || "catalogo").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

function loadCatalogImage(source) {
  return new Promise(resolve => {
    if (!source) return resolve(null);
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = source;
  });
}

function drawContainedImage(context, image, x, y, width, height) {
  const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

const catalogImageBounds = new WeakMap();
function drawTrimmedCatalogImage(context, image, x, y, width, height) {
  let bounds = catalogImageBounds.get(image);
  if (!bounds) {
    const sample = document.createElement("canvas");
    const maxSample = 420;
    const scale = Math.min(1, maxSample / Math.max(image.naturalWidth, image.naturalHeight));
    sample.width = Math.max(1, Math.round(image.naturalWidth * scale));
    sample.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const sampleContext = sample.getContext("2d", { willReadFrequently: true });
    sampleContext.drawImage(image, 0, 0, sample.width, sample.height);
    const pixels = sampleContext.getImageData(0, 0, sample.width, sample.height).data;
    let left = sample.width, top = sample.height, right = 0, bottom = 0;
    for (let py = 0; py < sample.height; py += 1) {
      for (let px = 0; px < sample.width; px += 1) {
        const offset = (py * sample.width + px) * 4;
        if (pixels[offset + 3] > 20 && Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 245) {
          left = Math.min(left, px); top = Math.min(top, py); right = Math.max(right, px); bottom = Math.max(bottom, py);
        }
      }
    }
    bounds = right > left && bottom > top
      ? { x: left / scale, y: top / scale, width: (right - left + 1) / scale, height: (bottom - top + 1) / scale }
      : { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight };
    catalogImageBounds.set(image, bounds);
  }
  const scale = Math.min(width / bounds.width, height / bounds.height);
  const drawWidth = bounds.width * scale;
  const drawHeight = bounds.height * scale;
  context.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function drawTransparentCatalogLogo(context, image, x, y, width, height) {
  const source = document.createElement("canvas");
  source.width = image.naturalWidth;
  source.height = image.naturalHeight;
  const sourceContext = source.getContext("2d", { willReadFrequently: true });
  sourceContext.drawImage(image, 0, 0);
  const imageData = sourceContext.getImageData(0, 0, source.width, source.height);
  const pixels = imageData.data;
  let left = source.width, top = source.height, right = 0, bottom = 0;
  for (let py = 0; py < source.height; py += 1) {
    for (let px = 0; px < source.width; px += 1) {
      const offset = (py * source.width + px) * 4;
      const minimum = Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      if (minimum > 242) pixels[offset + 3] = Math.max(0, Math.round((255 - minimum) * 19.6));
      if (pixels[offset + 3] > 24) {
        left = Math.min(left, px); top = Math.min(top, py); right = Math.max(right, px); bottom = Math.max(bottom, py);
      }
    }
  }
  sourceContext.putImageData(imageData, 0, 0);
  if (right <= left || bottom <= top) return;
  const cropWidth = right - left + 1;
  const cropHeight = bottom - top + 1;
  const scale = Math.min(width / cropWidth, height / cropHeight);
  const drawWidth = cropWidth * scale;
  const drawHeight = cropHeight * scale;
  context.drawImage(source, left, top, cropWidth, cropHeight, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

async function buildCatalog(product) {
  const available = product.variants.filter(variant => variant.stock > 0);
  if (!available.length) throw new Error("Este produto não possui cores disponíveis em estoque.");
  const canvas = document.createElement("canvas");
  canvas.width = 1240;
  canvas.height = 1754;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#151a3b";
  context.fillRect(0, 0, canvas.width, 16);
  context.fillStyle = "#ef5b13";
  context.fillRect(0, 16, canvas.width, 7);
  context.textAlign = "center";
  context.fillStyle = "#151a3b";
  context.font = "700 52px Arial, sans-serif";
  context.fillText("Cores Disponíveis", canvas.width / 2, 102);
  context.fillStyle = "#111a17";
  context.font = "700 62px Arial, sans-serif";
  context.fillText(product.name, canvas.width / 2, 178);
  context.fillStyle = "#ef5b13";
  context.font = "700 29px Arial, sans-serif";
  context.fillText(product.size ? `Medida ${product.size}` : "", canvas.width / 2, 226);
  context.strokeStyle = "#e7ebe9";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(64, 258);
  context.lineTo(canvas.width - 64, 258);
  context.stroke();

  const columns = available.length <= 3 ? available.length : available.length <= 6 ? 3 : available.length <= 12 ? 4 : 5;
  const rows = Math.ceil(available.length / columns);
  const gapX = 22;
  const gapY = 18;
  const gridX = 52;
  const gridY = 286;
  const gridWidth = canvas.width - 104;
  const gridHeight = 1180;
  const cellWidth = (gridWidth - gapX * (columns - 1)) / columns;
  const cellHeight = Math.min(465, (gridHeight - gapY * (rows - 1)) / rows);
  const imageHeight = cellHeight - 48;
  const images = await Promise.all(available.map(variant => loadCatalogImage(variant.imageUrl)));
  available.forEach((variant, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const rowCount = Math.min(columns, available.length - row * columns);
    const centeredOffset = rowCount < columns ? ((columns - rowCount) * (cellWidth + gapX)) / 2 : 0;
    const x = gridX + centeredOffset + column * (cellWidth + gapX);
    const y = gridY + row * (cellHeight + gapY);
    const image = images[index];
    if (image) {
      drawTrimmedCatalogImage(context, image, x + 3, y, cellWidth - 6, imageHeight);
    } else {
      const gradient = context.createLinearGradient(x + 28, 0, x + cellWidth - 28, 0);
      gradient.addColorStop(0, colorSwatch(variant.color, variant.rgb));
      gradient.addColorStop(.5, colorSwatch(variant.color, variant.rgb));
      gradient.addColorStop(.5, variant.rgb2 || colorSwatch(variant.color, variant.rgb));
      gradient.addColorStop(1, variant.rgb2 || colorSwatch(variant.color, variant.rgb));
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(x + cellWidth / 2, y + imageHeight / 2, Math.min(88, cellWidth * .3), 0, Math.PI * 2);
      context.fill();
    }
    context.fillStyle = "#111a17";
    context.font = `700 ${columns === 5 ? 22 : 27}px Arial, sans-serif`;
    context.fillText(variant.color.toUpperCase(), x + cellWidth / 2, y + imageHeight + 31, cellWidth - 10);
    const underline = context.createLinearGradient(x + cellWidth / 2 - 24, 0, x + cellWidth / 2 + 24, 0);
    underline.addColorStop(0, colorSwatch(variant.color, variant.rgb));
    underline.addColorStop(.5, colorSwatch(variant.color, variant.rgb));
    underline.addColorStop(.5, variant.rgb2 || colorSwatch(variant.color, variant.rgb));
    underline.addColorStop(1, variant.rgb2 || colorSwatch(variant.color, variant.rgb));
    context.fillStyle = underline;
    context.beginPath();
    context.roundRect(x + cellWidth / 2 - 24, y + imageHeight + 40, 48, 4, 2);
    context.fill();
  });

  context.fillStyle = "#f7f8f8";
  context.fillRect(0, 1506, canvas.width, 248);
  context.fillStyle = "#ef5b13";
  context.fillRect(0, 1506, canvas.width, 6);
  const logo = await loadCatalogImage("public/logo-disque-copias.png");
  if (logo) drawTransparentCatalogLogo(context, logo, 38, 1525, 420, 210);
  context.textAlign = "left";
  context.fillStyle = "#ef2f1c";
  context.font = "700 25px Arial, sans-serif";
  context.fillText("Aviso:", 505, 1602);
  context.fillStyle = "#111a17";
  context.font = "600 23px Arial, sans-serif";
  context.fillText("imagens ilustrativas; pode haver", 595, 1602);
  context.fillText("variação de cor.", 505, 1637);
  context.fillStyle = "#64706c";
  context.font = "500 17px Arial, sans-serif";
  context.fillText(`Atualizado em ${new Date().toLocaleString("pt-BR")}`, 505, 1691);
  return canvas;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function jpegPagesPdfBlob(pages) {
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [0];
  let length = 0;
  const append = value => {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    chunks.push(bytes); length += bytes.length;
  };
  append("%PDF-1.4\n");
  const object = (number, body) => { offsets[number] = length; append(`${number} 0 obj\n${body}\nendobj\n`); };
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  const pageObjects = pages.map((_, index) => 3 + index * 3);
  object(2, `<< /Type /Pages /Kids [${pageObjects.map(number => `${number} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  pages.forEach((page, index) => {
    const pageObject = pageObjects[index];
    const contentObject = pageObject + 1;
    const imageObject = pageObject + 2;
    const landscape = page.width > page.height;
    const pdfWidth = landscape ? 842 : 595;
    const pdfHeight = landscape ? 595 : 842;
    object(pageObject, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfWidth} ${pdfHeight}] /Resources << /XObject << /Im0 ${imageObject} 0 R >> >> /Contents ${contentObject} 0 R >>`);
    const content = `q ${pdfWidth} 0 0 ${pdfHeight} 0 0 cm /Im0 Do Q`;
    object(contentObject, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    offsets[imageObject] = length;
    append(`${imageObject} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`);
    append(page.bytes);
    append("\nendstream\nendobj\n");
  });
  const objectCount = 2 + pages.length * 3;
  const xref = length;
  append(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`);
  for (let index = 1; index <= objectCount; index += 1) append(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`);
  append(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  const output = new Uint8Array(length);
  let position = 0;
  chunks.forEach(chunk => { output.set(chunk, position); position += chunk.length; });
  return new Blob([output], { type: "application/pdf" });
}

function jpegPdfBlob(jpegBytes, pixelWidth, pixelHeight) {
  return jpegPagesPdfBlob([{ bytes: jpegBytes, width: pixelWidth, height: pixelHeight }]);
}

async function openCatalog(product) {
  try {
    catalogCanvas = await buildCatalog(product);
    catalogProduct = product;
    document.querySelector("#catalogTitle").textContent = `${product.name} · Cores Disponíveis`;
    document.querySelector("#catalogPreview").src = catalogCanvas.toDataURL("image/png");
    document.querySelector("#catalogDialog").showModal();
  } catch (error) {
    toast(error.message || "Não foi possível gerar o catálogo.");
  }
}

function syncMovementNoteRequirement() {
  const type = document.querySelector("#movementType").value;
  const note = document.querySelector("#movementNote");
  const isExit = type === "saida";
  note.required = isExit;
  note.placeholder = isExit ? "Informe o nome do cliente/empresa" : "Observação opcional";
}

function syncMovementTypeControls() {
  const type = document.querySelector("#movementType").value;
  const option = document.querySelector("#movementStockCorrectionOption");
  const input = document.querySelector("#movementStockCorrection");
  const isExit = type === "saida";
  option.hidden = !isExit;
  input.disabled = !isExit;
  if (!isExit) input.checked = false;
  syncMovementNoteRequirement();
}

function toast(message) {
  const element = document.querySelector("#toast");
  const openDialog = document.querySelector("dialog[open]");
  if (openDialog) openDialog.appendChild(element);
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.classList.remove("show");
    document.body.appendChild(element);
  }, 2800);
}

function askConfirmation({ title, message, confirmText = "Confirmar" }) {
  const dialog = document.querySelector("#confirmDialog");
  document.querySelector("#confirmTitle").textContent = title;
  document.querySelector("#confirmMessage").textContent = message;
  document.querySelector("#confirmAccept").textContent = confirmText;
  dialog.showModal();
  return new Promise(resolve => { confirmationResolver = resolve; });
}

function finishConfirmation(result) {
  document.querySelector("#confirmDialog").close();
  confirmationResolver?.(result);
  confirmationResolver = null;
}

function addConfigurationRecord(title, note) {
  movements.unshift({
    id: id("HIST"),
    type: "configuracao",
    productName: title,
    quantity: null,
    note,
    date: new Date().toISOString(),
  });
}

function getZeroStockAlerts() {
  const zeroProducts = products.filter(product => totalStock(product) === 0);
  const alerts = products.flatMap(product => {
    if (totalStock(product) === 0) return [{ kind: "product", product }];
    return product.variants
      .filter(variant => variant.stock === 0)
      .map(variant => ({ kind: "color", product, variant }));
  });
  return {
    zeroProducts,
    alerts,
  };
}

function renderZeroStockTable() {
  const { alerts } = getZeroStockAlerts();
  document.querySelector("#zeroStockTable").innerHTML = alerts.length
    ? alerts.map(alert => {
      const imageVariant = alert.kind === "color"
        ? alert.variant
        : alert.product.variants.find(variant => variant.imageUrl) || alert.product.variants[0];
      return `<tr>
      <td><div class="zero-stock-product-cell">${linkedVariantImageMarkup(alert.product, imageVariant, "zero-stock-product-image")}<strong>${esc(alert.product.name)}</strong></div></td>
      <td>${alert.kind === "color"
        ? `<span class="variant-chip zero"><span class="color-dot" style="${swatchStyle(alert.variant)}"></span>${esc(alert.variant.color)}</span>`
        : alert.product.variants.length === 1 ? "—" : "Todas as cores"}</td>
      <td>${esc(alert.product.category || "—")}</td>
      <td>${esc(alert.product.size || "—")}</td>
      <td><span class="badge zero">${alert.kind === "color" ? "Cor zerada" : "Produto zerado"}</span></td>
    </tr>`;
    }).join("")
    : `<tr><td colspan="5">${empty(products.length ? "Nenhum produto ou cor sem estoque." : "Cadastre produtos para começar.")}</td></tr>`;
}

function renderDashboard() {
  const units = products.reduce((total, item) => total + totalStock(item), 0);
  const { zeroProducts, alerts: stockAlerts } = getZeroStockAlerts();
  document.querySelector("#metricProducts").textContent = products.length;
  document.querySelector("#metricUnits").textContent = units.toLocaleString("pt-BR");
  document.querySelector("#metricSellers").textContent = sellers.length;
  document.querySelector("#metricZero").textContent = zeroProducts.length;

  document.querySelector("#lowStockList").innerHTML = stockAlerts.length
    ? stockAlerts.slice(0, 7).map(alert => `
      <div class="stock-row">
        <div><strong>${esc(alert.product.name)}</strong><small>${alert.kind === "color"
          ? `Cor ${esc(alert.variant.color)}${alert.product.size ? ` · ${esc(alert.product.size)}` : ""}`
          : esc([alert.product.category, alert.product.size].filter(Boolean).join(" · "))}</small></div>
        <div class="stock-qty"><strong>0</strong><small>unidades</small></div>
        <span class="badge zero">${alert.kind === "color" ? "Cor zerada" : "Produto zerado"}</span>
      </div>`).join("")
    : empty(products.length ? "Nenhum produto ou cor sem estoque." : "Cadastre produtos para começar.");

  const visibleRecentMovements = movements.filter(movement => adminAuthenticated || movement.type !== "configuracao");
  document.querySelector("#recentMovements").innerHTML = visibleRecentMovements.length
    ? visibleRecentMovements.slice(0, 5).map(movement => {
      const product = products.find(item => item.id === movement.productId);
      const movementIcon = movement.type === "entrada"
        ? "import"
        : movement.type === "saida"
          ? "export"
          : movement.type === "configuracao"
            ? "settings"
            : "reverse";
      return `<div class="movement-row">
        <span class="movement-symbol ${movement.type}">${icon(movementIcon)}</span>
        <div><strong>${esc(product?.name || movement.productName || "Produto excluído")}</strong>
        <small>${movement.variantColor ? `${esc(movement.variantColor)} · ` : ""}${formatDate(movement.date)} · ${movement.sellerId ? esc(movementSellerName(movement)) : "Configuração do painel"}</small></div>
        <span class="badge ${movement.type}">${movement.type === "configuracao" ? "Config." : movement.type === "estorno" ? `↺${movement.quantity}` : `${movement.type === "saida" ? "−" : "+"}${movement.quantity}`}</span>
      </div>`;
    }).join("")
    : empty("As movimentações aparecerão aqui.");

  const groups = Object.entries(products.reduce((acc, item) => {
    acc[item.category] = (acc[item.category] || 0) + totalStock(item);
    return acc;
  }, {})).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...groups.map(([, value]) => value), 1);
  document.querySelector("#categoryBars").innerHTML = groups.length
    ? groups.map(([name, value]) => `
      <div><div class="bar-head"><strong>${esc(name)}</strong><span>${value} un.</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(3, value / max * 100)}%"></div></div></div>`).join("")
    : empty("Nenhuma categoria possui produtos.");
}

function summaryValidMovements(type = "") {
  return movements.filter(movement =>
    ["entrada", "saida"].includes(movement.type) &&
    !movementIsReversed(movement) &&
    (movement.type === "entrada" || !movement.stockCorrection) &&
    (!type || movement.type === type) &&
    Number(movement.quantity) > 0
  );
}

function productMovementRanking() {
  const ranking = new Map();
  summaryValidMovements(summaryMovementType).forEach(movement => {
    const product = products.find(item => item.id === movement.productId);
    const variant = findVariant(product, movement.variantId);
    const productKey = movement.productId || `deleted:${movement.productName || "Produto excluído"}`;
    if (!ranking.has(productKey)) {
      ranking.set(productKey, {
        product,
        name: product?.name || movement.productName || "Produto excluído",
        size: product?.size || "",
        total: 0,
        colors: new Map(),
      });
    }
    const record = ranking.get(productKey);
    const quantity = Math.abs(Number(movement.quantity) || 0);
    const colorName = movement.variantColor || variant?.color || "Sem cor";
    const colorKey = movement.variantId || colorName.toLowerCase();
    if (!record.colors.has(colorKey)) {
      record.colors.set(colorKey, {
        name: colorName,
        quantity: 0,
        rgb: colorSwatch(colorName, variant?.rgb),
        rgb2: variant?.rgb2 || "",
      });
    }
    record.total += quantity;
    record.colors.get(colorKey).quantity += quantity;
  });
  return [...ranking.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "pt-BR")).slice(0, 8);
}

function attendantMovementRanking() {
  const ranking = new Map();
  summaryValidMovements("saida").forEach(movement => {
    const name = movementSellerName(movement);
    ranking.set(name, (ranking.get(name) || 0) + Math.abs(Number(movement.quantity) || 0));
  });
  return [...ranking.entries()]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "pt-BR"))
    .slice(0, 8);
}

function renderSummary() {
  const chart = document.querySelector("#summaryChart");
  if (!chart) return;
  const productMode = summaryChartMode === "products";
  const typeSwitch = document.querySelector("#summaryTypeSwitch");
  typeSwitch.hidden = !productMode;
  typeSwitch.querySelectorAll("button").forEach(button => { button.disabled = !productMode; });
  document.querySelectorAll("[data-summary-mode]").forEach(button => {
    const selected = button.dataset.summaryMode === summaryChartMode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  document.querySelectorAll("[data-summary-type]").forEach(button => {
    const selected = button.dataset.summaryType === summaryMovementType;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  const isExit = productMode ? summaryMovementType === "saida" : true;

  if (productMode) {
    const ranking = productMovementRanking();
    const total = ranking.reduce((sum, item) => sum + item.total, 0);
    const max = Math.max(...ranking.map(item => item.total), 1);
    document.querySelector("#summaryChartEyebrow").textContent = isExit ? "RANKING DE SAÍDAS" : "RANKING DE ENTRADAS";
    document.querySelector("#summaryChartTitle").textContent = "Produtos mais movimentados";
    document.querySelector("#summaryChartTotal").textContent = total.toLocaleString("pt-BR");
    document.querySelector("#summaryChartUnit").textContent = isExit ? "unidades baixadas" : "unidades adicionadas";
    document.querySelector("#summaryChartNote").textContent = isExit
      ? "Somente saídas válidas; estornos e correções de estoque não entram no cálculo."
      : "Somente entradas válidas; estornos não entram no cálculo.";
    chart.innerHTML = ranking.length ? ranking.map((item, index) => {
      const colors = [...item.colors.values()].sort((a, b) => b.quantity - a.quantity);
      const bars = colors.map(color => {
        const secondary = /^#[0-9a-f]{6}$/i.test(color.rgb2) ? color.rgb2 : color.rgb;
        return `<span class="summary-bar product-color" style="width:${Math.max(.8, color.quantity / max * 100)}%;--bar-color:${color.rgb};--bar-color-2:${secondary}" title="${esc(color.name)}: ${color.quantity}"></span>`;
      }).join("");
      const breakdown = colors.map(color => `<span class="summary-color-item"><span class="color-dot" style="--swatch:${color.rgb};--swatch-2:${color.rgb2 || color.rgb}"></span>${esc(color.name)} <strong>${color.quantity}</strong></span>`).join("");
      return `<div class="summary-chart-row">
        <span class="summary-rank">${String(index + 1).padStart(2, "0")}</span>
        <div class="summary-entity">${productImageStaticMarkup(item.product, "summary-product-image")}<div class="summary-entity-copy"><strong>${esc(item.name)}</strong><small>${esc(item.size || "Medida não informada")}</small></div></div>
        <div class="summary-bar-area"><div class="summary-bar-track">${bars}</div><div class="summary-color-breakdown">${breakdown}</div></div>
        <span class="summary-value">${item.total}<small>unidades</small></span>
      </div>`;
    }).join("") : `<div class="summary-empty">${icon("chart")}<strong>Ainda não há movimentações para comparar.</strong><span>O gráfico será preenchido após as primeiras entradas ou saídas.</span></div>`;
    return;
  }

  const ranking = attendantMovementRanking();
  const total = ranking.reduce((sum, item) => sum + item.total, 0);
  const max = Math.max(...ranking.map(item => item.total), 1);
  document.querySelector("#summaryChartEyebrow").textContent = "RANKING DE BAIXAS";
  document.querySelector("#summaryChartTitle").textContent = "Atendentes com mais baixas";
  document.querySelector("#summaryChartTotal").textContent = total.toLocaleString("pt-BR");
  document.querySelector("#summaryChartUnit").textContent = "unidades baixadas";
  document.querySelector("#summaryChartNote").textContent = "Somente saídas válidas; estornos e correções de estoque não entram no cálculo.";
  chart.innerHTML = ranking.length ? ranking.map((item, index) => `
    <div class="summary-chart-row seller-row">
      <span class="summary-rank">${String(index + 1).padStart(2, "0")}</span>
      <div class="summary-entity"><span class="summary-entity-icon">${icon("users")}</span><div class="summary-entity-copy"><strong>${esc(item.name)}</strong><small>${item.total} ${item.total === 1 ? "unidade baixada" : "unidades baixadas"}</small></div></div>
      <div class="summary-bar-area"><div class="summary-bar-track"><span class="summary-bar seller-bar" style="width:${Math.max(1.5, item.total / max * 100)}%"></span></div></div>
      <span class="summary-value">${item.total}<small>baixas</small></span>
    </div>`).join("") : `<div class="summary-empty">${icon("users")}<strong>Ainda não há baixas registradas.</strong><span>O ranking será exibido após as primeiras saídas.</span></div>`;
}

function renderProducts() {
  const search = document.querySelector("#productSearch").value.trim().toLowerCase();
  const category = document.querySelector("#categoryFilter").value;
  const filtered = products.filter(product => {
    const text = [product.name, product.category, product.size, ...product.variants.map(variant => variant.color)].join(" ").toLowerCase();
    return (!search || text.includes(search)) && (!category || product.category === category);
  });

  document.querySelector("#productsTable").innerHTML = filtered.length
    ? filtered.map(product => {
      const status = statusOf(product);
      const variantChips = product.variants.map(variant => {
        const content = `<span class="color-dot" style="${swatchStyle(variant)}"></span>${esc(variant.color)} <strong>${variant.stock}</strong>`;
        return variant.imageUrl
          ? `<button type="button" class="variant-chip variant-chip-button${variant.stock === 0 ? " zero" : ""}" data-image-url="${esc(variant.imageUrl)}" data-image-title="${esc(`${product.name} · ${variant.color}`)}" data-image-size="${esc(product.size || "")}" aria-label="Abrir imagem de ${esc(product.name)}, cor ${esc(variant.color)}">${content}</button>`
          : `<span class="variant-chip${variant.stock === 0 ? " zero" : ""}">${content}</span>`;
      }).join("");
      return `<tr data-product-id="${product.id}" class="${adminAuthenticated ? "reorder-enabled" : ""}">
        <td class="order-cell">${adminAuthenticated ? `<span class="drag-handle" aria-label="Arrastar para reordenar" title="Arraste para mudar a ordem">⋮⋮</span>` : ""}</td>
        <td><div class="product-name-cell">${productImageMarkup(product)}<div><strong>${esc(product.name)}</strong><small>Criado em ${formatDate(product.createdAt || new Date().toISOString())}</small></div></div></td>
        <td>${esc(product.category)}</td><td><div class="variant-chips">${variantChips}</div></td><td>${esc(product.size || "—")}</td>
        <td><strong>${totalStock(product)}</strong></td><td><span class="badge ${status.key}">${status.label}</span></td>
        <td><div class="table-actions product-actions">
          ${product.variants.length > 1 ? `<button class="icon-button generate-catalog" data-id="${product.id}" aria-label="Gerar catálogo">${icon("download")}<span class="action-label">Catálogo</span></button>` : ""}
          ${adminAuthenticated ? `
          <button class="icon-button edit-product" data-id="${product.id}" aria-label="Editar produto" data-tooltip="Editar produto">${icon("pencil")}<span class="action-label">Editar</span></button>
          <button class="icon-button delete-product" data-id="${product.id}" aria-label="Excluir produto">${icon("trash")}</button>
          ` : ""}</div></td>
      </tr>`;
    }).join("")
    : `<tr><td colspan="8">${empty("Nenhum produto encontrado.")}</td></tr>`;
}

function renderMovements() {
  const filter = document.querySelector("#historyFilter").value;
  const search = normalizedSearch(document.querySelector("#historySearch").value.trim());
  const signature = JSON.stringify([filter, search, historyDateStart, historyDateEnd, adminAuthenticated]);
  if (signature !== historyRenderSignature) {
    historyRenderSignature = signature;
    if (!historyDateStart || !historyDateEnd) historyMonthSelection = "";
  }
  const filtered = movements.filter(movement =>
    (adminAuthenticated || movement.type !== "configuracao") &&
    (!filter || movement.type === filter) &&
    movementMatchesHistoryPeriod(movement) &&
    (!search || (() => {
      const product = products.find(item => item.id === movement.productId);
      const variant = findVariant(product, movement.variantId);
      return [
        product?.name,
        movement.productName,
        movement.variantColor,
        variant?.color,
        movement.sellerId ? movementSellerName(movement) : "",
        typeLabel(movement.type),
        movement.type === "configuracao" ? panelTerminology(movement.note) : movement.note,
        movement.stockCorrection ? "correção de estoque" : "",
        formatDate(movement.date),
      ].filter(Boolean).map(normalizedSearch).join(" ").includes(search);
    })())
  ).map((movement, index) => ({ movement, index }))
    .sort((a, b) => {
      const difference = new Date(b.movement.date).getTime() - new Date(a.movement.date).getTime();
      return (Number.isFinite(difference) ? difference : 0) || a.index - b.index;
    })
    .map(item => item.movement);
  const monthGroups = [];
  filtered.forEach(movement => {
    const key = movementMonthKey(movement.date);
    let group = monthGroups.at(-1);
    if (!group || group.key !== key) {
      group = { key, movements: [] };
      monthGroups.push(group);
    }
    group.movements.push(movement);
  });
  const selectedMonthExists = monthGroups.some(group => group.key === historyMonthSelection);
  if (historyMonthSelection && historyMonthSelection !== "all" && !selectedMonthExists) {
    historyMonthSelection = "";
  }
  const visibleMonthGroups = historyMonthSelection === "all"
    ? monthGroups
    : historyMonthSelection
      ? monthGroups.filter(group => group.key === historyMonthSelection)
      : monthGroups.slice(0, 1);
  const visibleMovements = visibleMonthGroups.flatMap(group => group.movements);
  const visibleMovementIndexes = new Map(visibleMovements.map((movement, index) => [movement.id, index]));
  const batchCounts = visibleMovements.reduce((counts, movement) => {
    if (movement.batchId) counts.set(movement.batchId, (counts.get(movement.batchId) || 0) + 1);
    return counts;
  }, new Map());
  document.querySelector("#movementsTable").innerHTML = filtered.length
    ? visibleMonthGroups.map(group => {
      const monthHeading = `<tr class="history-month-row"><td colspan="7"><div class="history-month-heading">${icon("history")}<strong>${esc(movementMonthLabel(group.key))}</strong><small>${group.movements.length} ${group.movements.length === 1 ? "registro" : "registros"}</small></div></td></tr>`;
      const rows = group.movements.map(movement => {
      const index = visibleMovementIndexes.get(movement.id) ?? 0;
      const product = products.find(item => item.id === movement.productId);
      const variant = findVariant(product, movement.variantId);
      const grouped = movement.batchId && batchCounts.get(movement.batchId) > 1;
      const previousSame = grouped && visibleMovements[index - 1]?.batchId === movement.batchId;
      const nextSame = grouped && visibleMovements[index + 1]?.batchId === movement.batchId;
      const groupClass = !grouped ? "" : previousSame ? (nextSame ? " batch-middle" : " batch-end") : (nextSame ? " batch-start" : "");
      const reversalRecordExists = movement.reversedBy && movements.some(item => item.id === movement.reversedBy);
      const originalRecordExists = movement.reversalOf && movements.some(item => item.id === movement.reversalOf);
      const movementAction = [
        ["entrada", "saida"].includes(movement.type) && !movementIsReversed(movement) && product && variant
          ? `<button class="icon-button reverse-movement" data-id="${movement.id}" aria-label="Estornar movimentação">${icon("reverse")}<span class="action-label">Estornar</span></button>`
          : movementIsReversed(movement)
            ? reversalRecordExists
              ? `<button type="button" class="badge estorno movement-origin-button" data-highlight-movement-id="${movement.reversedBy}" aria-label="Destacar registro de estorno">${icon("reverse")}Estornado</button>`
              : `<span class="badge estorno">${icon("reverse")}Estornado</span>`
            : "",
        adminAuthenticated
          ? `<button class="icon-button delete-movement" data-id="${movement.id}" aria-label="Excluir registro">${icon("trash")}</button>`
          : "",
      ].join("");
      const typeBadge = movement.type === "estorno" && originalRecordExists
        ? `<button type="button" class="badge estorno movement-origin-button" data-highlight-movement-id="${movement.reversalOf}" aria-label="Destacar movimentação original">${typeLabel(movement.type)}</button>`
        : `<span class="badge ${movement.type}">${typeLabel(movement.type)}</span>`;
      return `<tr class="${grouped ? `history-batch${groupClass}` : ""}" data-movement-id="${movement.id}">
        <td>${formatDate(movement.date)}</td>
        <td><div class="history-product-cell">${linkedVariantImageMarkup(product, variant, "history-product-image")}<div><strong>${esc(product?.name || movement.productName || "Produto excluído")}</strong>${movement.variantColor || variant?.color ? `<small>Cor: ${esc(movement.variantColor || variant.color)}</small>` : ""}${product?.size ? `<small>Medida: ${esc(product.size)}</small>` : ""}${movement.stockCorrection ? `<span class="history-stock-correction">Correção de estoque</span>` : ""}</div></div></td>
        <td>${movement.sellerId ? esc(movementSellerName(movement)) : "—"}</td>
        <td>${typeBadge}</td>
        <td><strong>${movement.type === "configuracao" ? "—" : movement.type === "estorno" ? `↺${movement.quantity}` : `${movement.type === "saida" ? "−" : "+"}${movement.quantity}`}</strong></td>
        <td>${esc(movement.type === "configuracao" ? panelTerminology(movement.note || "—") : movement.note || "—")}</td>
        <td><div class="table-actions history-row-actions">${movementAction}</div></td>
      </tr>`;
      }).join("");
      return monthHeading + rows;
    }).join("")
    : `<tr><td colspan="7">${empty(filter || historyDateStart || search ? "Nenhum registro encontrado nos filtros selecionados." : "Nenhum registro no histórico.")}</td></tr>`;
  const hasOlderMonths = monthGroups.length > 1;
  const loadMore = document.querySelector("#historyLoadMore");
  loadMore.hidden = !hasOlderMonths;
  document.querySelector("#historyLoadProgress").textContent = !hasOlderMonths
    ? ""
    : historyMonthSelection === "all"
      ? `Exibindo todos os ${monthGroups.length} meses disponíveis`
      : historyMonthSelection
        ? `Exibindo ${movementMonthLabel(historyMonthSelection)} — ${visibleMovements.length} ${visibleMovements.length === 1 ? "registro" : "registros"}`
        : `${monthGroups.length - 1} ${monthGroups.length === 2 ? "mês anterior disponível" : "meses anteriores disponíveis"}`;
  const monthSelect = document.querySelector("#historyMonthSelect");
  monthSelect.innerHTML = [
    `<option value="">${esc(`Mais recente: ${movementMonthLabel(monthGroups[0]?.key || "")}`)}</option>`,
    ...monthGroups.map(group => `<option value="${esc(group.key)}">${esc(movementMonthLabel(group.key))} (${group.movements.length})</option>`),
    `<option value="all">Abrir todos os meses</option>`,
  ].join("");
  monthSelect.value = historyMonthSelection;
}

function renderRegistrations() {
  document.querySelector("#categoryList").innerHTML = categories.length
    ? categories.map(category => `
      <div class="simple-row"><div class="simple-row-copy"><strong>${esc(category.name)}</strong><small>Criada em ${formatDate(category.createdAt)}</small></div>
      <div class="table-actions">
        <button class="icon-button edit-category" data-id="${category.id}" aria-label="Editar categoria" data-tooltip="Editar categoria">${icon("pencil")}<span class="action-label">Editar</span></button>
        <button class="icon-button delete-category" data-id="${category.id}" aria-label="Excluir categoria" data-tooltip="Excluir categoria">${icon("trash")}<span class="action-label">Excluir</span></button>
      </div></div>`).join("")
    : empty("Nenhuma categoria cadastrada.");
  document.querySelector("#sellerList").innerHTML = sellers.length
    ? sellers.map(seller => `
      <div class="simple-row"><div class="simple-row-copy"><strong>${esc(seller.name)}</strong><small>Cadastrado em ${formatDate(seller.createdAt)}</small></div>
      <div class="table-actions">
        <button class="icon-button edit-seller" data-id="${seller.id}" aria-label="Editar atendente" data-tooltip="Editar atendente">${icon("pencil")}<span class="action-label">Editar</span></button>
        <button class="icon-button delete-seller" data-id="${seller.id}" aria-label="Excluir atendente" data-tooltip="Excluir atendente">${icon("trash")}<span class="action-label">Excluir</span></button>
      </div></div>`).join("")
    : empty("Nenhum atendente cadastrado.");
}

function selectOptions(items, placeholder) {
  return `<option value="">${placeholder}</option>${items
    .slice().sort((a, b) => a.name.localeCompare(b.name))
    .map(item => `<option value="${item.id}">${esc(item.name)}</option>`).join("")}`;
}

function refreshSelects() {
  const filter = document.querySelector("#categoryFilter");
  const selected = filter.value;
  filter.innerHTML = `<option value="">Todas as categorias</option>${categories
    .slice().sort((a, b) => a.name.localeCompare(b.name))
    .map(category => `<option value="${esc(category.name)}">${esc(category.name)}</option>`).join("")}`;
  filter.value = selected;
  renderCategoryFilterOptions(filter.value);

  document.querySelector("#productCategory").innerHTML = selectOptions(categories, "Selecione uma categoria");
  document.querySelector("#editProductCategory").innerHTML = selectOptions(categories, "Selecione uma categoria");
  document.querySelector("#movementSeller").innerHTML = selectOptions(sellers, "Selecione um atendente");
  document.querySelector("#reversalSeller").innerHTML = selectOptions(sellers, "Selecione um atendente");
  renderMovementProducts();
}

function renderMovementProducts() {
  const input = document.querySelector("#movementProduct");
  if (!products.some(product => product.id === input.value)) input.value = "";
  document.querySelector("#movementProductPicker").innerHTML = products.length
    ? products.map(product => {
      const stock = totalStock(product);
      return `<button type="button" class="movement-product-option${product.id === input.value ? " selected" : ""}" data-product-id="${product.id}" role="option" aria-selected="${product.id === input.value}">
        ${productImageStaticMarkup(product, "movement-option-image")}
        <span class="movement-option-copy"><span class="movement-option-title"><strong>${esc(product.name)}</strong><span class="movement-option-size">${esc(product.size || "Medida não informada")}</span></span></span>
        <span class="movement-option-stock ${stock > 0 ? "positive" : "depleted"}"><strong>${stock}</strong><small>em estoque</small></span>
      </button>`;
    }).join("")
    : `<span class="variant-picker-empty">Nenhum produto cadastrado.</span>`;
}

function renderMovementVariants() {
  const product = products.find(item => item.id === document.querySelector("#movementProduct").value);
  const type = document.querySelector("#movementType").value;
  const grid = document.querySelector("#movementVariantGrid");
  if (!product) {
    movementSelectedVariantIds.clear();
    grid.innerHTML = `<span class="variant-picker-empty">Selecione primeiro um produto.</span>`;
    return;
  }
  const validIds = new Set(product.variants
    .filter(variant => !(type === "saida" && variant.stock <= 0))
    .map(variant => variant.id));
  movementSelectedVariantIds = new Set([...movementSelectedVariantIds].filter(variantId => validIds.has(variantId)));
  grid.innerHTML = product.variants.map(variant => {
    const disabled = type === "saida" && variant.stock <= 0;
    const selected = movementSelectedVariantIds.has(variant.id);
    return `<div class="variant-choice${selected ? " selected" : ""}">
      ${movementVariantVisualMarkup(variant)}
      <span class="variant-choice-copy"><strong>${esc(variant.color)}</strong><small>${variant.stock} em estoque</small></span>
      <button type="button" class="select-variant-button" data-variant-id="${variant.id}" aria-pressed="${selected}" ${disabled ? "disabled" : ""}>
        ${selected ? `${icon("check")} Selecionada` : `${icon("plus")} Selecionar`}
      </button>
    </div>`;
  }).join("");
}

function renderMovementCommand() {
  const container = document.querySelector("#movementCommandList");
  container.innerHTML = movementDraftItems.length
    ? `<div class="command-heading"><strong>Itens da movimentação</strong><span>${movementDraftItems.length} ${movementDraftItems.length === 1 ? "item" : "itens"}</span></div>
      ${movementDraftItems.map(item => {
        const product = products.find(product => product.id === item.productId);
        const variant = findVariant(product, item.variantId);
        return `<div class="command-item" data-command-key="${item.productId}|${item.variantId}">
          <span class="color-dot large" style="${swatchStyle(variant)}"></span>
          <div><strong>${esc(product?.name || "Produto excluído")}</strong><small>${esc(variant?.color || "Cor excluída")}</small></div>
          <span class="command-quantity">${item.quantity} un.</span>
          <button type="button" class="remove-command-item" aria-label="Remover ${esc(product?.name || "item")} da comanda" data-tooltip="Remover item">${icon("trash")}</button>
        </div>`;
      }).join("")}`
    : `<div class="command-empty">Adicione um ou mais produtos para montar a comanda.</div>`;
}

function addMovementItem() {
  const product = products.find(item => item.id === document.querySelector("#movementProduct").value);
  const selectedVariants = product?.variants.filter(variant => movementSelectedVariantIds.has(variant.id)) || [];
  const quantity = Number(document.querySelector("#movementForm").elements.quantity.value);
  const type = document.querySelector("#movementType").value;
  if (!product || !selectedVariants.length || !Number.isFinite(quantity) || quantity <= 0) {
    return toast("Selecione o produto, uma ou mais cores e uma quantidade válida.");
  }
  const insufficient = type === "saida" && selectedVariants.find(variant => {
    const existing = movementDraftItems.find(item => item.productId === product.id && item.variantId === variant.id);
    return quantity + (existing?.quantity || 0) > variant.stock;
  });
  if (insufficient) {
    return toast(`A comanda ultrapassa o saldo disponível da cor ${insufficient.color} (${insufficient.stock}).`);
  }
  selectedVariants.forEach(variant => {
    const existing = movementDraftItems.find(item => item.productId === product.id && item.variantId === variant.id);
    if (existing) existing.quantity += quantity;
    else movementDraftItems.push({ productId: product.id, variantId: variant.id, quantity });
  });
  document.querySelector("#movementForm").elements.quantity.value = "1";
  syncMovementQuantityStepper();
  movementSelectedVariantIds.clear();
  renderMovementVariants();
  renderMovementCommand();
  toast(selectedVariants.length === 1 ? "Item adicionado." : `${selectedVariants.length} itens adicionados.`);
}

function syncMovementQuantityStepper() {
  const input = document.querySelector('#movementForm [name="quantity"]');
  const quantity = Math.max(1, Number.parseInt(input.value, 10) || 1);
  input.value = String(quantity);
  document.querySelector("#decreaseMovementQuantity").disabled = quantity <= 1;
}

function changeMovementQuantity(amount) {
  const input = document.querySelector('#movementForm [name="quantity"]');
  input.value = String(Math.max(1, (Number.parseInt(input.value, 10) || 1) + amount));
  syncMovementQuantityStepper();
}

function renderAll() {
  refreshSelects();
  if (performanceMode) {
    renderViewData(activeViewName());
    if (document.querySelector("#zeroStockDialog[open]")) renderZeroStockTable();
    return;
  }
  renderDashboard();
  renderSummary();
  renderProducts();
  renderMovements();
  renderRegistrations();
  renderProductDraftColors();
  renderZeroStockTable();
}

function renderProductDraftColors() {
  const list = document.querySelector("#productColorList");
  list.innerHTML = productDraftColors.length
    ? productDraftColors.map((variant, index) => `
      <div class="draft-color-row" data-draft-color-id="${variant.id}">
        <span class="color-dot large" style="${swatchStyle(variant)}"></span>
        <div class="draft-color-name"><strong>${esc(variant.color)}</strong><small>${colorRgbLabel(variant)} · ${variant.imageFile ? esc(variant.imageFile.name) : "sem imagem"}</small></div>
        <label>Saldo inicial<input class="draft-color-stock" data-index="${index}" type="number" min="0" value="${variant.stock}" /></label>
        <button type="button" class="remove-draft-color" aria-label="Remover cor ${esc(variant.color)}">${icon("x")}</button>
      </div>`).join("")
    : `<div class="draft-colors-empty">Nenhuma cor adicionada. Preencha a cor e clique em <strong>+ Adicionar cor</strong>.</div>`;
}

function addProductDraftColor() {
  const nameInput = document.querySelector("#productColorName");
  const rgbInput = document.querySelector("#productColorRgb");
  const rgb2Input = document.querySelector("#productColorRgb2");
  const stockInput = document.querySelector("#productColorStock");
  const imageInput = document.querySelector("#productColorImage");
  const color = nameInput.value.trim();
  const rgb = rgbInput.value;
  const rgb2 = rgb2Input.value;
  const stock = Number(stockInput.value);
  if (!color) {
    toast("Informe o nome da cor antes de adicioná-la.");
    nameInput.focus();
    return false;
  }
  if (!Number.isFinite(stock) || stock < 0) {
    toast("Informe um saldo inicial válido para esta cor.");
    stockInput.focus();
    return false;
  }
  if (productDraftColors.some(variant => variant.color.toLowerCase() === color.toLowerCase())) {
    toast("Essa cor já está na lista.");
    return false;
  }
  productDraftColors.push({ id: id("DRAFT"), color, rgb, rgb2, stock, imageFile: imageInput.files[0] || null });
  nameInput.value = "";
  stockInput.value = "0";
  imageInput.value = "";
  document.querySelector("#productColorImageName").textContent = "Nenhuma imagem selecionada";
  rgb2Input.value = "";
  rgbPickerChannel = "primary";
  refreshRgbBuilder();
  nameInput.focus();
  renderProductDraftColors();
  return true;
}

function hideProductNameSuggestions() {
  const input = document.querySelector("#productName");
  const suggestions = document.querySelector("#productNameSuggestions");
  suggestions.hidden = true;
  suggestions.innerHTML = "";
  input.setAttribute("aria-expanded", "false");
}

function renderProductNameSuggestions() {
  const input = document.querySelector("#productName");
  const suggestions = document.querySelector("#productNameSuggestions");
  const query = input.value.trim().toLocaleLowerCase("pt-BR");
  const matches = products
    .filter(product => !query || product.name.toLocaleLowerCase("pt-BR").includes(query));
  if (!matches.length || document.activeElement !== input) {
    hideProductNameSuggestions();
    return;
  }
  suggestions.innerHTML = matches.map(product => `
    <button type="button" class="product-name-suggestion" role="option" data-product-name="${esc(product.name)}">
      ${productImageStaticMarkup(product, "suggestion-image")}
      <span><strong>${esc(product.name)}</strong><small>${esc([product.category, product.size].filter(Boolean).join(" · "))}</small></span>
      <span class="suggestion-stock">${totalStock(product)} un.</span>
    </button>`).join("");
  suggestions.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

function syncProductIdentityFields() {
  const name = document.querySelector("#productName").value.trim().toLowerCase();
  const existing = products.find(product => product.name.toLowerCase() === name);
  const categoryField = document.querySelector("#productCategoryField");
  const sizeField = document.querySelector("#productSizeField");
  const categorySelect = document.querySelector("#productCategory");
  const sizeInput = document.querySelector("#productSize");
  const note = document.querySelector("#existingProductNote");
  categoryField.hidden = Boolean(existing);
  sizeField.hidden = Boolean(existing);
  categorySelect.disabled = Boolean(existing);
  categorySelect.required = !existing;
  sizeInput.disabled = Boolean(existing);
  note.hidden = !existing;
  note.textContent = existing
    ? `Produto já cadastrado em ${existing.category}${existing.size ? ` · ${existing.size}` : ""}. As novas cores serão adicionadas a ele.`
    : "";
  if (registrationColorProductId !== (existing?.id || null)) {
    registrationVariantFiles.clear();
    clearRegistrationPreviewUrls();
  }
  registrationColorProductId = existing?.id || null;
  renderRegisteredColors(existing);
  if (!document.querySelector("#productImageInput").files[0]) {
    renderImagePreview(document.querySelector("#productImagePreview"), existing?.imageUrl || "", existing?.name);
  }
  return existing;
}

function renderRegisteredColors(product) {
  const manager = document.querySelector("#registeredColorsManager");
  manager.hidden = !product;
  if (!product) {
    document.querySelector("#registeredColorList").innerHTML = "";
    return;
  }
  document.querySelector("#registeredColorList").innerHTML = product.variants.map(variant => `
    <div class="registered-color-row${variant.rgb2 ? " two-tone" : ""}" data-registered-variant-id="${variant.id}">
      <div class="registered-color-preview"><span>Prévia</span><span class="registered-color-preview-slot">${registeredColorImageMarkup(product, variant)}</span></div>
      <label>Nome da cor<input class="registered-color-name" value="${esc(variant.color)}" /></label>
      <label class="registered-color-picker">Cor 1<input class="registered-color-rgb" type="color" value="${colorSwatch(variant.color, variant.rgb)}" /></label>
      ${variant.rgb2 ? `<label class="registered-color-picker">Cor 2<input class="registered-color-rgb2" type="color" value="${variant.rgb2}" /></label>` : ""}
      <div class="registered-color-upload"><span>Imagem</span><label class="file-picker-button"><span class="ui-icon icon-import"></span><span class="registered-file-name">Selecionar imagem</span><input class="registered-color-file" type="file" accept="image/jpeg,image/png,image/webp" /></label></div>
      <div class="registered-color-action"><span aria-hidden="true"></span><button type="button" class="remove-registered-color" aria-label="Excluir cor ${esc(variant.color)}">${icon("trash")}</button></div>
    </div>`).join("");
}

function registeredColorImageMarkup(product, variant, source = variant.imageUrl, title = variant.color) {
  return source
    ? `<button type="button" class="product-image-button registered-color-image" data-image-url="${esc(source)}" data-image-title="${esc(`${product.name} · ${title}`)}" data-image-size="${esc(product.size || "")}" aria-label="Abrir imagem de ${esc(title)}"><img src="${esc(source)}" alt="${esc(title)}" loading="lazy" decoding="async" /></button>`
    : `<span class="registered-color-image registered-color-image-placeholder" aria-label="Cor sem imagem vinculada">${icon("package")}</span>`;
}

function clearRegistrationPreviewUrls(variantId = "") {
  if (variantId) {
    const url = registrationVariantPreviewUrls.get(variantId);
    if (url) URL.revokeObjectURL(url);
    registrationVariantPreviewUrls.delete(variantId);
    return;
  }
  registrationVariantPreviewUrls.forEach(url => URL.revokeObjectURL(url));
  registrationVariantPreviewUrls.clear();
}

function showView(name) {
  const changingView = activeViewName() !== name;
  const titles = {
    dashboard: "Visão geral do estoque",
    products: "Produtos cadastrados",
    movements: "Histórico",
    registrations: "Cadastro",
  };
  document.querySelectorAll(".view").forEach(view => view.classList.toggle("active", view.id === `${name}View`));
  document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === name));
  document.querySelector("#pageTitle").textContent = titles[name];
  document.querySelector(".sidebar").classList.remove("open");
  renderViewData(name);
  if (changingView) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
}

function setHistoryDisplay(mode) {
  historyDisplayMode = mode === "summary" ? "summary" : "table";
  const showSummary = historyDisplayMode === "summary";
  document.querySelectorAll("[data-history-display]").forEach(button => {
    const selected = button.dataset.historyDisplay === historyDisplayMode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  document.querySelector(".history-actions").hidden = showSummary;
  document.querySelector("#historyTablePanel").hidden = showSummary;
  document.querySelector("#historySummaryPanel").hidden = !showSummary;
  if (showSummary) {
    const searchPanel = document.querySelector("#historySearchPanel");
    searchPanel.hidden = true;
    document.querySelector("#historySearchButton").classList.remove("active");
    document.querySelector("#historySearchButton").setAttribute("aria-expanded", "false");
    document.querySelector("#historySearch").value = "";
    if (!performanceMode) renderMovements();
    renderSummary();
  } else renderMovements();
  syncHistoryDescription();
}

function openMovementDialog() {
  if (!products.length || !sellers.length) {
    toast("É necessário ter um produto e um atendente cadastrados.");
    return;
  }
  refreshSelects();
  movementDraftItems = [];
  movementSelectedVariantIds.clear();
  document.querySelector("#movementForm").reset();
  document.querySelector("#movementType").value = "saida";
  syncMovementQuantityStepper();
  renderMovementProducts();
  syncMovementTypeControls();
  renderMovementVariants();
  renderMovementCommand();
  document.querySelector("#movementDialog").showModal();
}

function setHistoryFilter(value, focusTrigger = false) {
  if (value === "configuracao" && !adminAuthenticated) value = "";
  const dropdown = document.querySelector("#historyFilterDropdown");
  const select = document.querySelector("#historyFilter");
  const options = [...dropdown.querySelectorAll(".filter-option:not([hidden])")];
  const selectedOption = options.find(option => option.dataset.value === value) || options[0];
  select.value = selectedOption.dataset.value;
  document.querySelector("#historyFilterLabel").textContent = selectedOption.querySelector("strong").textContent;
  options.forEach(option => {
    const selected = option === selectedOption;
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-selected", String(selected));
  });
  dropdown.classList.remove("open");
  document.querySelector("#historyFilterTrigger").setAttribute("aria-expanded", "false");
  renderMovements();
  if (focusTrigger) document.querySelector("#historyFilterTrigger").focus();
}

function highlightRelatedMovement(movementId) {
  let row = [...document.querySelectorAll("#movementsTable tr[data-movement-id]")]
    .find(item => item.dataset.movementId === movementId);
  if (!row && (document.querySelector("#historyFilter").value || historyDateStart)) {
    clearHistoryPeriod(false);
    setHistoryFilter("");
    row = [...document.querySelectorAll("#movementsTable tr[data-movement-id]")]
      .find(item => item.dataset.movementId === movementId);
  }
  if (!row && movements.some(item => item.id === movementId)) {
    const relatedMovement = movements.find(item => item.id === movementId);
    historyMonthSelection = movementMonthKey(relatedMovement.date);
    renderMovements();
    row = [...document.querySelectorAll("#movementsTable tr[data-movement-id]")]
      .find(item => item.dataset.movementId === movementId);
  }
  if (!row) return toast("O registro relacionado não está mais disponível no Histórico.");
  clearTimeout(historyHighlightTimer);
  document.querySelectorAll("#movementsTable tr.movement-origin-highlight")
    .forEach(item => item.classList.remove("movement-origin-highlight"));
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  void row.offsetWidth;
  row.classList.add("movement-origin-highlight");
  historyHighlightTimer = window.setTimeout(() => row.classList.remove("movement-origin-highlight"), 2600);
}

function openHistoryFilter(focusSelected = false) {
  const dropdown = document.querySelector("#historyFilterDropdown");
  document.querySelector("#categoryFilterDropdown").classList.remove("open");
  document.querySelector("#categoryFilterTrigger").setAttribute("aria-expanded", "false");
  dropdown.classList.add("open");
  document.querySelector("#historyFilterTrigger").setAttribute("aria-expanded", "true");
  if (focusSelected) dropdown.querySelector(".filter-option.selected:not([hidden])")?.focus();
}

function renderCategoryFilterOptions(selectedValue = "") {
  const menu = document.querySelector("#categoryFilterMenu");
  const items = [
    { value: "", name: "Todas as categorias", count: products.length },
    ...categories.slice().sort((a, b) => a.name.localeCompare(b.name)).map(category => ({
      value: category.name,
      name: category.name,
      count: products.filter(product => product.categoryId === category.id || product.category === category.name).length,
    })),
  ];
  menu.innerHTML = items.map((item, index) => {
    const selected = item.value === selectedValue;
    return `<button class="filter-option${selected ? " selected" : ""}" type="button" role="option"
      aria-selected="${selected}" data-category-value="${esc(item.value)}">
      <span class="filter-option-icon">${icon(index === 0 ? "packages" : "category")}</span>
      <span><strong>${esc(item.name)}</strong><small>${item.count} ${item.count === 1 ? "produto cadastrado" : "produtos cadastrados"}</small></span>
      <span class="filter-check">${icon("check")}</span>
    </button>`;
  }).join("");
  const selectedItem = items.find(item => item.value === selectedValue) || items[0];
  document.querySelector("#categoryFilterLabel").textContent = selectedItem.name;
}

function setCategoryFilter(value, focusTrigger = false) {
  const dropdown = document.querySelector("#categoryFilterDropdown");
  const select = document.querySelector("#categoryFilter");
  select.value = value;
  renderCategoryFilterOptions(select.value);
  dropdown.classList.remove("open");
  document.querySelector("#categoryFilterTrigger").setAttribute("aria-expanded", "false");
  renderProducts();
  if (focusTrigger) document.querySelector("#categoryFilterTrigger").focus();
}

function openCategoryFilter(focusSelected = false) {
  const dropdown = document.querySelector("#categoryFilterDropdown");
  document.querySelector("#historyFilterDropdown").classList.remove("open");
  document.querySelector("#historyFilterTrigger").setAttribute("aria-expanded", "false");
  dropdown.classList.add("open");
  document.querySelector("#categoryFilterTrigger").setAttribute("aria-expanded", "true");
  if (focusSelected) dropdown.querySelector(".filter-option.selected")?.focus();
}

async function openAdminAccess() {
  try {
    const status = await fetchAdminStatus();
    if (status.authenticated) {
      applyAdminAccess(true);
      showView("registrations");
      return;
    }
    if (!status.configured && !status.canSetup) {
      toast("Defina a senha neste computador acessando http://localhost:8090/.");
      return;
    }

    adminSetupMode = !status.configured;
    const form = document.querySelector("#adminAccessForm");
    form.reset();
    document.querySelector("#adminError").textContent = "";
    document.querySelector("#adminDialogTitle").textContent =
      adminSetupMode ? "Criar senha administrativa" : "Cadastramento";
    document.querySelector("#adminDialogMessage").textContent = adminSetupMode
      ? "Defina a senha que será usada para liberar a aba Cadastro."
      : "Informe a senha.";
    document.querySelector("#adminPasswordConfirmField").hidden = !adminSetupMode;
    document.querySelector("#adminPasswordConfirm").required = adminSetupMode;
    document.querySelector("#adminPassword").autocomplete = adminSetupMode ? "new-password" : "current-password";
    document.querySelector("#adminSubmitButton").lastChild.textContent =
      adminSetupMode ? "Criar senha e liberar" : "Liberar Cadastro";
    document.querySelector("#adminAccessDialog").showModal();
    document.querySelector("#adminPassword").focus();
  } catch {
    toast("Não foi possível abrir o acesso administrativo.");
  }
}

const currentDateText = new Intl.DateTimeFormat("pt-BR", { dateStyle: "full" }).format(new Date());
document.querySelector("#dateLine").textContent = currentDateText.charAt(0).toUpperCase() + currentDateText.slice(1);
document.querySelectorAll(".nav-item").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
document.querySelectorAll("[data-go]").forEach(button => button.addEventListener("click", () => showView(button.dataset.go)));
document.querySelector("#menuButton").addEventListener("click", () => document.querySelector(".sidebar").classList.toggle("open"));
document.querySelector("#performanceModeButton").addEventListener("click", () => applyPerformanceMode(!performanceMode, true));
document.querySelector("#newMovementButton").addEventListener("click", openMovementDialog);
document.querySelector("#openZeroStockButton").addEventListener("click", () => {
  renderZeroStockTable();
  document.querySelector("#zeroStockDialog").showModal();
});
document.querySelector("#adminAccessButton").addEventListener("click", openAdminAccess);
document.addEventListener("click", event => {
  const imageButton = event.target.closest(".product-image-button, .variant-chip-button");
  if (!imageButton) return;
  document.querySelector("#imagePreviewLarge").src = imageButton.dataset.imageUrl;
  document.querySelector("#imagePreviewTitle").textContent = imageButton.dataset.imageTitle;
  const imageSize = imageButton.dataset.imageSize;
  document.querySelector("#imagePreviewSize").textContent = imageSize || "Medida não informada";
  document.querySelector("#imagePreviewDialog").showModal();
});
document.addEventListener("click", event => {
  const originButton = event.target.closest("[data-highlight-movement-id]");
  if (originButton) highlightRelatedMovement(originButton.dataset.highlightMovementId);
});
document.querySelector("#productSearch").addEventListener("input", renderProducts);
document.querySelector("#categoryFilter").addEventListener("change", renderProducts);
document.querySelectorAll("[data-summary-mode]").forEach(button => button.addEventListener("click", () => {
  summaryChartMode = button.dataset.summaryMode;
  renderSummary();
}));
document.querySelectorAll("[data-summary-type]").forEach(button => button.addEventListener("click", () => {
  summaryMovementType = button.dataset.summaryType;
  renderSummary();
}));
document.querySelectorAll("[data-history-display]").forEach(button => button.addEventListener("click", () => {
  setHistoryDisplay(button.dataset.historyDisplay);
}));
function setHistorySearchOpen(open) {
  const panel = document.querySelector("#historySearchPanel");
  const button = document.querySelector("#historySearchButton");
  panel.hidden = !open;
  button.classList.toggle("active", open);
  button.setAttribute("aria-expanded", String(open));
  if (open) {
    document.querySelector("#historySearch").focus();
  } else {
    document.querySelector("#historySearch").value = "";
    renderMovements();
  }
}
document.querySelector("#historySearchButton").addEventListener("click", () => {
  setHistorySearchOpen(document.querySelector("#historySearchPanel").hidden);
});
document.querySelector("#closeHistorySearch").addEventListener("click", () => setHistorySearchOpen(false));
document.querySelector("#historySearch").addEventListener("input", renderMovements);
document.querySelector("#historySearch").addEventListener("keydown", event => {
  if (event.key === "Escape") {
    event.preventDefault();
    setHistorySearchOpen(false);
    document.querySelector("#historySearchButton").focus();
  }
});
document.querySelector("#historyMonthSelect").addEventListener("change", event => {
  historyMonthSelection = event.target.value;
  renderMovements();
});
function finishProductReorder(targetId, insertAfter) {
  if (!adminAuthenticated || !draggedProductId || !targetId || targetId === draggedProductId) return false;
  const originalOrder = products.map(product => product.id);
  const fromIndex = products.findIndex(product => product.id === draggedProductId);
  let targetIndex = products.findIndex(product => product.id === targetId);
  if (fromIndex < 0 || targetIndex < 0) return false;
  const [moved] = products.splice(fromIndex, 1);
  targetIndex = products.findIndex(product => product.id === targetId);
  products.splice(targetIndex + (insertAfter ? 1 : 0), 0, moved);
  const orderChanged = products.some((product, index) => product.id !== originalOrder[index]);
  if (!orderChanged) return false;
  addConfigurationRecord("Ordem dos produtos", `${moved.name} reposicionado na lista.`);
  save();
  renderAll();
  toast("Ordem dos produtos atualizada.");
  return true;
}
document.querySelector("#productsTable").addEventListener("pointerdown", event => {
  const handle = event.target.closest(".drag-handle");
  const row = handle?.closest("tr[data-product-id]");
  if (!adminAuthenticated || !handle || !row) return;
  event.preventDefault();
  draggedProductId = row.dataset.productId;
  draggedProductPointerId = event.pointerId;
  draggedProductTargetId = null;
  row.classList.add("dragging");
  handle.setPointerCapture?.(event.pointerId);
});
document.querySelector("#productsTable").addEventListener("pointermove", event => {
  if (event.pointerId !== draggedProductPointerId || !draggedProductId) return;
  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest("tr[data-product-id]");
  if (!row || row.dataset.productId === draggedProductId) return;
  document.querySelectorAll("#productsTable tr").forEach(item => item.classList.remove("drag-before", "drag-after"));
  const rect = row.getBoundingClientRect();
  draggedProductTargetId = row.dataset.productId;
  draggedProductInsertAfter = event.clientY >= rect.top + rect.height / 2;
  row.classList.add(draggedProductInsertAfter ? "drag-after" : "drag-before");
});
document.querySelector("#productsTable").addEventListener("pointerup", event => {
  if (event.pointerId !== draggedProductPointerId) return;
  finishProductReorder(draggedProductTargetId, draggedProductInsertAfter);
  draggedProductId = null;
  draggedProductTargetId = null;
  draggedProductPointerId = null;
  document.querySelectorAll("#productsTable tr").forEach(row => row.classList.remove("dragging", "drag-before", "drag-after"));
});
document.querySelector("#productsTable").addEventListener("dragstart", event => {
  const row = event.target.closest("tr[data-product-id]");
  if (!adminAuthenticated || !row) {
    event.preventDefault();
    return;
  }
  draggedProductId = row.dataset.productId;
  row.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedProductId);
});
document.querySelector("#productsTable").addEventListener("dragover", event => {
  const row = event.target.closest("tr[data-product-id]");
  if (!adminAuthenticated || !draggedProductId || !row || row.dataset.productId === draggedProductId) return;
  event.preventDefault();
  document.querySelectorAll("#productsTable tr").forEach(item => item.classList.remove("drag-before", "drag-after"));
  const before = event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
  row.classList.add(before ? "drag-before" : "drag-after");
});
document.querySelector("#productsTable").addEventListener("drop", event => {
  const row = event.target.closest("tr[data-product-id]");
  if (!adminAuthenticated || !draggedProductId || !row || row.dataset.productId === draggedProductId) return;
  event.preventDefault();
  const insertAfter = row.classList.contains("drag-after");
  finishProductReorder(row.dataset.productId, insertAfter);
  draggedProductId = null;
});
document.querySelector("#productsTable").addEventListener("dragend", () => {
  draggedProductId = null;
  document.querySelectorAll("#productsTable tr").forEach(row => row.classList.remove("dragging", "drag-before", "drag-after"));
});
document.querySelector("#historyFilter").addEventListener("change", renderMovements);
document.querySelector("#applyHistoryPeriod").addEventListener("click", applyHistoryPeriod);
document.querySelector("#clearHistoryPeriod").addEventListener("click", () => {
  clearHistoryPeriod();
  toast("Filtro de período removido.");
});
document.querySelectorAll("#historyStartDate, #historyEndDate").forEach(input => {
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyHistoryPeriod();
    }
  });
});
document.querySelector("#historyFilterTrigger").addEventListener("click", () => {
  const dropdown = document.querySelector("#historyFilterDropdown");
  if (dropdown.classList.contains("open")) {
    dropdown.classList.remove("open");
    document.querySelector("#historyFilterTrigger").setAttribute("aria-expanded", "false");
  } else {
    openHistoryFilter();
  }
});
document.querySelector("#historyFilterTrigger").addEventListener("keydown", event => {
  if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    openHistoryFilter(true);
  }
});
document.querySelector("#categoryFilterTrigger").addEventListener("click", () => {
  const dropdown = document.querySelector("#categoryFilterDropdown");
  if (dropdown.classList.contains("open")) {
    dropdown.classList.remove("open");
    document.querySelector("#categoryFilterTrigger").setAttribute("aria-expanded", "false");
  } else {
    openCategoryFilter();
  }
});
document.querySelector("#categoryFilterTrigger").addEventListener("keydown", event => {
  if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    openCategoryFilter(true);
  }
});
document.querySelector("#categoryFilterMenu").addEventListener("click", event => {
  const option = event.target.closest(".filter-option");
  if (option) setCategoryFilter(option.dataset.categoryValue, true);
});
document.querySelector("#categoryFilterMenu").addEventListener("keydown", event => {
  const option = event.target.closest(".filter-option");
  if (!option) return;
  const options = [...document.querySelectorAll("#categoryFilterMenu .filter-option")];
  const index = options.indexOf(option);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    options[(index + step + options.length) % options.length].focus();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    setCategoryFilter(document.querySelector("#categoryFilter").value, true);
  }
});
document.querySelectorAll("#historyFilterMenu .filter-option").forEach(option => {
  option.addEventListener("click", () => setHistoryFilter(option.dataset.value, true));
  option.addEventListener("keydown", event => {
    const options = [...document.querySelectorAll("#historyFilterMenu .filter-option:not([hidden])")];
    const index = options.indexOf(option);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      options[(index + step + options.length) % options.length].focus();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setHistoryFilter(document.querySelector("#historyFilter").value, true);
    }
  });
});
document.addEventListener("click", event => {
  const historyDropdown = document.querySelector("#historyFilterDropdown");
  const categoryDropdown = document.querySelector("#categoryFilterDropdown");
  if (!historyDropdown.contains(event.target)) {
    historyDropdown.classList.remove("open");
    document.querySelector("#historyFilterTrigger").setAttribute("aria-expanded", "false");
  }
  if (!categoryDropdown.contains(event.target)) {
    categoryDropdown.classList.remove("open");
    document.querySelector("#categoryFilterTrigger").setAttribute("aria-expanded", "false");
  }
});
document.querySelector("#movementProductPicker").addEventListener("click", event => {
  const option = event.target.closest(".movement-product-option");
  if (!option) return;
  document.querySelector("#movementProduct").value = option.dataset.productId;
  movementSelectedVariantIds.clear();
  renderMovementProducts();
  renderMovementVariants();
});
document.querySelector("#productImageInput").addEventListener("change", event => {
  const file = event.target.files[0];
  productImageObjectUrl = replacePreviewObjectUrl(productImageObjectUrl, file);
  renderImagePreview(document.querySelector("#productImagePreview"), productImageObjectUrl, "Prévia da nova imagem");
});
document.querySelector("#productColorImage").addEventListener("change", event => {
  document.querySelector("#productColorImageName").textContent = event.target.files[0]?.name || "Nenhuma imagem selecionada";
});
document.querySelector("#editProductImageInput").addEventListener("change", event => {
  const file = event.target.files[0];
  editProductImageObjectUrl = replacePreviewObjectUrl(editProductImageObjectUrl, file);
  removeEditingProductImage = false;
  const product = products.find(item => item.id === editingProductId);
  renderImagePreview(document.querySelector("#editProductImagePreview"), editProductImageObjectUrl || product?.imageUrl, product?.name);
  document.querySelector("#removeProductImageButton").disabled = false;
});
document.querySelector("#removeProductImageButton").addEventListener("click", () => {
  removeEditingProductImage = true;
  document.querySelector("#editProductImageInput").value = "";
  editProductImageObjectUrl = replacePreviewObjectUrl(editProductImageObjectUrl, null);
  renderImagePreview(document.querySelector("#editProductImagePreview"), "");
  document.querySelector("#removeProductImageButton").disabled = true;
});
document.querySelector("#movementType").addEventListener("change", () => {
  syncMovementTypeControls();
  renderMovementVariants();
});
document.querySelector("#movementVariantGrid").addEventListener("click", event => {
  const choice = event.target.closest(".select-variant-button");
  if (!choice || choice.disabled) return;
  if (movementSelectedVariantIds.has(choice.dataset.variantId)) movementSelectedVariantIds.delete(choice.dataset.variantId);
  else movementSelectedVariantIds.add(choice.dataset.variantId);
  renderMovementVariants();
});
document.querySelector("#addMovementItem").addEventListener("click", addMovementItem);
document.querySelector("#decreaseMovementQuantity").addEventListener("click", () => changeMovementQuantity(-1));
document.querySelector("#increaseMovementQuantity").addEventListener("click", () => changeMovementQuantity(1));
document.querySelector('#movementForm [name="quantity"]').addEventListener("input", syncMovementQuantityStepper);
document.querySelector("#movementCommandList").addEventListener("click", event => {
  const button = event.target.closest(".remove-command-item");
  if (!button) return;
  const [productId, variantId] = button.closest("[data-command-key]").dataset.commandKey.split("|");
  movementDraftItems = movementDraftItems.filter(item => item.productId !== productId || item.variantId !== variantId);
  renderMovementCommand();
});
document.querySelector("#rgbPickerTrigger").addEventListener("click", () => {
  selectRgbChannel("primary");
  document.querySelector("#rgbPickerPanel").classList.remove("closed");
  document.querySelector("#rgbPickerTrigger").setAttribute("aria-expanded", "true");
});
document.querySelector("#addSecondRgb").addEventListener("click", () => {
  const input = document.querySelector("#productColorRgb2");
  if (!input.value) input.value = "#ffffff";
  refreshRgbBuilder();
  selectRgbChannel("secondary");
  document.querySelector("#rgbPickerPanel").classList.remove("closed");
  document.querySelector("#rgbPickerTrigger").setAttribute("aria-expanded", "true");
});
document.querySelector("#rgbPickerPanel").addEventListener("click", event => {
  const channelButton = event.target.closest("[data-rgb-channel]");
  if (channelButton) selectRgbChannel(channelButton.dataset.rgbChannel);
});
document.querySelector("#removeSecondRgb").addEventListener("click", () => {
  document.querySelector("#productColorRgb2").value = "";
  selectRgbChannel("primary");
  refreshRgbBuilder();
});
document.querySelector("#closeRgbPicker").addEventListener("click", () => {
  document.querySelector("#rgbPickerPanel").classList.add("closed");
  document.querySelector("#rgbPickerTrigger").setAttribute("aria-expanded", "false");
});
function updateSaturationFromPointer(event) {
  const area = document.querySelector("#rgbSaturation");
  const rect = area.getBoundingClientRect();
  rgbPickerState.s = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
  rgbPickerState.v = 100 - Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));
  syncRgbPicker(hsvToRgb(rgbPickerState), false);
}
document.querySelector("#rgbSaturation").addEventListener("pointerdown", event => {
  event.currentTarget.setPointerCapture(event.pointerId);
  updateSaturationFromPointer(event);
});
document.querySelector("#rgbSaturation").addEventListener("pointermove", event => {
  if (event.currentTarget.hasPointerCapture(event.pointerId)) updateSaturationFromPointer(event);
});
document.querySelector("#rgbHue").addEventListener("input", event => {
  rgbPickerState.h = Number(event.currentTarget.value);
  syncRgbPicker(hsvToRgb(rgbPickerState), false);
});
document.querySelector("#rgbPickerPanel").addEventListener("input", event => {
  if (!["rgbRed", "rgbGreen", "rgbBlue"].includes(event.target.id)) return;
  const rgb = {
    r: Number(document.querySelector("#rgbRed").value),
    g: Number(document.querySelector("#rgbGreen").value),
    b: Number(document.querySelector("#rgbBlue").value),
  };
  if (Object.values(rgb).every(value => Number.isFinite(value) && value >= 0 && value <= 255)) syncRgbPicker(rgb);
});
document.querySelector("#addProductColorButton").addEventListener("click", addProductDraftColor);
document.querySelector("#productName").addEventListener("input", () => {
  syncProductIdentityFields();
  renderProductNameSuggestions();
});
document.querySelector("#productName").addEventListener("focus", renderProductNameSuggestions);
document.querySelector("#productName").addEventListener("keydown", event => {
  if (event.key === "Escape") {
    hideProductNameSuggestions();
    return;
  }
  if (event.key !== "ArrowDown") return;
  const options = [...document.querySelectorAll("#productNameSuggestions .product-name-suggestion")];
  if (!options.length) return;
  event.preventDefault();
  options[0].focus();
});
document.querySelector("#productNameSuggestions").addEventListener("click", event => {
  const option = event.target.closest(".product-name-suggestion");
  if (!option) return;
  const input = document.querySelector("#productName");
  input.value = option.dataset.productName;
  syncProductIdentityFields();
  hideProductNameSuggestions();
  input.focus();
});
document.querySelector("#productNameSuggestions").addEventListener("keydown", event => {
  const option = event.target.closest(".product-name-suggestion");
  if (!option) return;
  const options = [...document.querySelectorAll("#productNameSuggestions .product-name-suggestion")];
  const index = options.indexOf(option);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length].focus();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    hideProductNameSuggestions();
    document.querySelector("#productName").focus();
  }
});
document.addEventListener("click", event => {
  if (!event.target.closest(".product-name-autocomplete")) hideProductNameSuggestions();
});
document.querySelector("#productColorList").addEventListener("input", event => {
  if (!event.target.classList.contains("draft-color-stock")) return;
  const variant = productDraftColors[Number(event.target.dataset.index)];
  const stock = Number(event.target.value);
  if (variant && Number.isFinite(stock) && stock >= 0) variant.stock = stock;
});
document.querySelector("#productColorList").addEventListener("click", event => {
  const button = event.target.closest(".remove-draft-color");
  if (!button) return;
  const row = button.closest("[data-draft-color-id]");
  productDraftColors = productDraftColors.filter(variant => variant.id !== row.dataset.draftColorId);
  renderProductDraftColors();
});
document.querySelector("#registeredColorList").addEventListener("change", event => {
  if (!event.target.classList.contains("registered-color-file")) return;
  const row = event.target.closest("[data-registered-variant-id]");
  const file = event.target.files[0] || null;
  const product = products.find(item => item.id === registrationColorProductId);
  const variant = findVariant(product, row.dataset.registeredVariantId);
  if (!product || !variant) return;
  if (file) registrationVariantFiles.set(row.dataset.registeredVariantId, file);
  else registrationVariantFiles.delete(row.dataset.registeredVariantId);
  clearRegistrationPreviewUrls(variant.id);
  const previewSlot = row.querySelector(".registered-color-preview-slot");
  row.querySelector(".registered-file-name").textContent = file?.name || "Selecionar imagem";
  const previewUrl = file ? URL.createObjectURL(file) : "";
  if (previewUrl) registrationVariantPreviewUrls.set(variant.id, previewUrl);
  previewSlot.innerHTML = registeredColorImageMarkup(
    product,
    { ...variant, color: row.querySelector(".registered-color-name").value.trim() || variant.color },
    previewUrl || variant.imageUrl,
    file?.name || variant.color,
  );
});
document.querySelector("#registeredColorList").addEventListener("click", async event => {
  const button = event.target.closest(".remove-registered-color");
  if (!button) return;
  const product = products.find(item => item.id === registrationColorProductId);
  const row = button.closest("[data-registered-variant-id]");
  const variant = findVariant(product, row?.dataset.registeredVariantId);
  if (!product || !variant) return toast("Cor não encontrada.");
  const remainingRows = document.querySelectorAll("#registeredColorList [data-registered-variant-id]").length;
  if (remainingRows === 1 && !productDraftColors.length) return toast("O produto precisa manter pelo menos uma cor.");
  if (!await askConfirmation({
    title: `Excluir a cor ${variant.color}?`,
    message: variant.stock > 0
      ? `Esta cor possui saldo ${variant.stock}. A exclusão só será confirmada ao clicar em Salvar produto.`
      : "A exclusão só será confirmada ao clicar em Salvar produto.",
    confirmText: "Marcar para excluir",
  })) return;
  registrationVariantFiles.delete(variant.id);
  clearRegistrationPreviewUrls(variant.id);
  row.remove();
  toast("Cor marcada para exclusão. Clique em Salvar produto para confirmar.");
});
document.querySelector("#confirmCancel").addEventListener("click", () => finishConfirmation(false));
document.querySelector("#confirmAccept").addEventListener("click", () => finishConfirmation(true));
document.querySelector("#confirmDialog").addEventListener("cancel", event => {
  event.preventDefault();
  finishConfirmation(false);
});
document.querySelectorAll(".dialog-cancel").forEach(button => button.addEventListener("click", () => {
  const dialog = button.closest("dialog");
  dialog.querySelector("form")?.reset();
  if (dialog.id === "movementDialog") {
    movementDraftItems = [];
    movementSelectedVariantIds.clear();
    renderMovementCommand();
  }
  dialog.close();
  const notification = document.querySelector("#toast");
  notification.classList.remove("show");
  document.body.appendChild(notification);
}));

document.addEventListener("keydown", event => {
  if (event.key !== "Enter" || event.isComposing) return;
  const dialog = document.querySelector("dialog[open]");
  if (!dialog) return;
  if (event.target.closest("button")) return;
  if (event.target.matches("textarea") && event.shiftKey) return;
  if (event.target.matches("select")) return;

  event.preventDefault();
  if (dialog.id === "confirmDialog") {
    document.querySelector("#confirmAccept").click();
    return;
  }
  dialog.querySelector("form")?.requestSubmit();
});

document.querySelector("#adminAccessForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const password = String(data.get("password") || "");
  const confirmation = String(data.get("passwordConfirm") || "");
  const error = document.querySelector("#adminError");
  error.textContent = "";
  if (password.length < 4) {
    error.textContent = "A senha deve ter pelo menos 4 caracteres.";
    return;
  }
  if (adminSetupMode && password !== confirmation) {
    error.textContent = "As senhas não coincidem.";
    return;
  }

  const submitButton = document.querySelector("#adminSubmitButton");
  submitButton.disabled = true;
  try {
    const response = await fetch(adminSetupMode ? "/api/admin/setup" : "/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const result = await response.json();
    if (!response.ok) {
      error.textContent = result.error || "Não foi possível liberar o acesso.";
      return;
    }
    applyAdminAccess(true);
    form.reset();
    document.querySelector("#adminAccessDialog").close();
    showView("registrations");
    toast(adminSetupMode ? "Senha criada e Cadastro liberado." : "Cadastro liberado.");
  } catch {
    error.textContent = "Não foi possível conectar ao servidor.";
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#categoryForm").addEventListener("submit", event => {
  event.preventDefault();
  const name = new FormData(event.currentTarget).get("name").trim();
  if (categories.some(item => item.name.toLowerCase() === name.toLowerCase())) return toast("Essa categoria já existe.");
  categories.push({ id: id("CAT"), name, createdAt: new Date().toISOString() });
  addConfigurationRecord(name, "Categoria criada.");
  save(); event.currentTarget.reset(); renderAll(); showView("registrations"); toast("Categoria cadastrada.");
});

document.querySelector("#sellerForm").addEventListener("submit", event => {
  event.preventDefault();
  const name = new FormData(event.currentTarget).get("name").trim();
  if (sellers.some(item => item.name.toLowerCase() === name.toLowerCase())) return toast("Esse atendente já existe.");
  sellers.push({ id: id("VEN"), name, createdAt: new Date().toISOString() });
  addConfigurationRecord(name, "Atendente criado.");
  save(); event.currentTarget.reset(); renderAll(); showView("registrations"); toast("Atendente cadastrado.");
});

document.querySelector("#productForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const name = data.get("name").trim();
  if (!name) return toast("Informe o nome/modelo do produto.");
  const existingProduct = products.find(product => product.name.toLowerCase() === name.toLowerCase());
  const category = existingProduct
    ? categories.find(item => item.id === existingProduct.categoryId)
    : categories.find(item => item.id === data.get("category"));
  const size = existingProduct ? (existingProduct.size || "") : data.get("size").trim();
  if (!existingProduct && !category) return toast("Selecione uma categoria.");
  if (data.get("colorName").trim() && !addProductDraftColor()) return;
  const registeredRows = existingProduct
    ? [...document.querySelectorAll("#registeredColorList [data-registered-variant-id]")]
    : [];
  if (!registeredRows.length && !productDraftColors.length) return toast("Adicione pelo menos uma cor ao produto.");
  if (productDraftColors.some(variant => !Number.isFinite(variant.stock) || variant.stock < 0)) {
    return toast("Confira o saldo inicial de cada cor.");
  }
  if (existingProduct) {
    const registeredNames = registeredRows.map(row => row.querySelector(".registered-color-name").value.trim());
    if (registeredNames.some(color => !color)) return toast("As cores cadastradas não podem ficar sem nome.");
    const finalNames = [...registeredNames, ...productDraftColors.map(variant => variant.color)];
    if (new Set(finalNames.map(color => color.toLocaleLowerCase("pt-BR"))).size !== finalNames.length) {
      return toast("Não é possível repetir a mesma cor neste produto.");
    }
  }
  const imageFile = document.querySelector("#productImageInput").files[0];
  let uploadedImageUrl = "";
  if (imageFile) {
    try {
      uploadedImageUrl = await uploadProductImage(imageFile);
    } catch (error) {
      return toast(error.message);
    }
  }
  const previousVariants = existingProduct?.variants.map(variant => ({ ...variant })) || [];
  const uploadedVariantUrls = [];
  const registeredVariants = [];
  try {
    for (const row of registeredRows) {
      const previousVariant = findVariant(existingProduct, row.dataset.registeredVariantId);
      if (!previousVariant) throw new Error("Uma cor cadastrada não está mais disponível.");
      const file = registrationVariantFiles.get(previousVariant.id);
      const newImageUrl = file ? await uploadProductImage(file) : previousVariant.imageUrl;
      if (file) uploadedVariantUrls.push(newImageUrl);
      const rgb = row.querySelector(".registered-color-rgb").value;
      const selectedRgb2 = row.querySelector(".registered-color-rgb2")?.value || "";
      registeredVariants.push({
        ...previousVariant,
        color: row.querySelector(".registered-color-name").value.trim(),
        rgb,
        rgb2: selectedRgb2 && selectedRgb2 !== rgb ? selectedRgb2 : "",
        imageUrl: newImageUrl || "",
      });
    }
    for (const draft of productDraftColors) {
      draft.imageUrl = draft.imageFile ? await uploadProductImage(draft.imageFile) : "";
      if (draft.imageUrl) uploadedVariantUrls.push(draft.imageUrl);
    }
  } catch (error) {
    uploadedVariantUrls.forEach(deleteProductImage);
    if (uploadedImageUrl) deleteProductImage(uploadedImageUrl);
    return toast(error.message);
  }
  const previousImageUrl = existingProduct?.imageUrl || "";
  if (existingProduct) {
    const registeredChanged = previousVariants.length !== registeredVariants.length || registeredVariants.some(variant => {
      const previous = previousVariants.find(item => item.id === variant.id);
      return !previous || variant.color !== previous.color || variant.rgb !== previous.rgb ||
        variant.rgb2 !== previous.rgb2 || variant.imageUrl !== previous.imageUrl;
    });
    const productImageChanged = Boolean(uploadedImageUrl && uploadedImageUrl !== previousImageUrl);
    if (!registeredChanged && !productDraftColors.length && !productImageChanged) {
      uploadedVariantUrls.forEach(deleteProductImage);
      if (uploadedImageUrl) deleteProductImage(uploadedImageUrl);
      return toast("Nenhuma alteração foi realizada no produto.");
    }
    const createdAt = new Date().toISOString();
    existingProduct.variants = [...registeredVariants, ...productDraftColors.map(variant => ({
      id: id("VAR"),
      color: variant.color,
      rgb: variant.rgb,
      rgb2: variant.rgb2 || "",
      imageUrl: variant.imageUrl || "",
      stock: variant.stock,
      createdAt,
    }))];
    if (uploadedImageUrl) existingProduct.imageUrl = uploadedImageUrl;
    const changes = [];
    previousVariants.forEach(previous => {
      const current = registeredVariants.find(variant => variant.id === previous.id);
      if (!current) changes.push(`cor ${previous.color} excluída (saldo ${previous.stock})`);
      else {
        if (current.color !== previous.color) changes.push(`cor “${previous.color}” renomeada para “${current.color}”`);
        if (current.rgb !== previous.rgb || current.rgb2 !== previous.rgb2) changes.push(`tons de ${current.color} alterados`);
        if (current.imageUrl !== previous.imageUrl) changes.push(`imagem de ${current.color} alterada`);
      }
    });
    if (productDraftColors.length) {
      changes.push(`cores adicionadas: ${productDraftColors.map(variant => `${variant.color} (saldo ${variant.stock})`).join(", ")}`);
    }
    if (productImageChanged) changes.push("imagem do produto alterada");
    addConfigurationRecord(existingProduct.name, `Produto atualizado pelo Cadastro. ${changes.join("; ")}.`);
  } else {
    const createdAt = new Date().toISOString();
    const product = {
      id: id("PROD"),
      name,
      category: category.name,
      categoryId: category.id,
      size,
      imageUrl: uploadedImageUrl,
      createdAt,
      variants: productDraftColors.map(variant => ({
        id: id("VAR"),
        color: variant.color,
        rgb: variant.rgb,
        rgb2: variant.rgb2 || "",
        imageUrl: variant.imageUrl || "",
        stock: variant.stock,
        createdAt,
      })),
    };
    products.push(product);
    addConfigurationRecord(product.name, `Produto criado na categoria ${category.name}, com as cores: ${productDraftColors.map(variant => variant.color).join(", ")}.`);
  }
  const addedCount = productDraftColors.length;
  productDraftColors = [];
  await save();
  if (uploadedImageUrl && previousImageUrl && previousImageUrl !== uploadedImageUrl) await deleteProductImage(previousImageUrl);
  if (existingProduct) {
    const currentVariants = new Map(existingProduct.variants.map(variant => [variant.id, variant]));
    await Promise.all(previousVariants.map(previous => {
      const current = currentVariants.get(previous.id);
      return previous.imageUrl && previous.imageUrl !== current?.imageUrl
        ? deleteProductImage(previous.imageUrl)
        : Promise.resolve();
    }));
  }
  registrationVariantFiles.clear();
  clearRegistrationPreviewUrls();
  renderAll(); showView("registrations"); form.reset(); hideProductNameSuggestions();
  productImageObjectUrl = replacePreviewObjectUrl(productImageObjectUrl, null);
  renderImagePreview(document.querySelector("#productImagePreview"), "");
  syncProductIdentityFields();
  document.querySelector("#productColorRgb2").value = "";
  rgbPickerChannel = "primary";
  syncRgbPicker(hexToRgb("#20242b"));
  document.querySelector("#rgbPickerPanel").classList.add("closed");
  document.querySelector("#rgbPickerTrigger").setAttribute("aria-expanded", "false");
  toast(existingProduct
    ? (addedCount ? "Produto e cores atualizados com sucesso." : "Produto atualizado com sucesso.")
    : "Produto cadastrado com sucesso.");
});

document.querySelector("#movementForm").addEventListener("submit", event => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const type = data.get("type");
  const stockCorrection = type === "saida" && data.get("stockCorrection") === "on";
  const note = data.get("note").trim();
  const seller = sellers.find(item => item.id === data.get("sellerId"));
  if (!seller) return toast("Selecione o atendente responsável.");
  if (!movementDraftItems.length) return toast("Adicione pelo menos um item à comanda.");
  if (type === "saida" && !note) return toast("Informe o motivo da saída.");
  const resolvedItems = movementDraftItems.map(item => {
    const product = products.find(product => product.id === item.productId);
    return { ...item, product, variant: findVariant(product, item.variantId) };
  });
  if (resolvedItems.some(item => !item.product || !item.variant)) return toast("Um item da comanda não está mais disponível.");
  const insufficient = type === "saida" && resolvedItems.find(item => item.quantity > item.variant.stock);
  if (insufficient) return toast(`Saldo insuficiente para ${insufficient.product.name}, cor ${insufficient.variant.color} (${insufficient.variant.stock}).`);
  const date = new Date().toISOString();
  const batchId = id("CMD");
  const records = resolvedItems.map(item => {
    if (type === "entrada") item.variant.stock += item.quantity;
    if (type === "saida") item.variant.stock -= item.quantity;
    return {
      id: id("MOV"), batchId, productId: item.product.id, productName: item.product.name,
      variantId: item.variant.id, variantColor: item.variant.color,
      sellerId: seller.id, sellerName: seller.name,
      type, quantity: item.quantity, note, date, stockCorrection,
    };
  });
  movements.unshift(...records);
  const itemCount = records.length;
  movementDraftItems = [];
  movementSelectedVariantIds.clear();
  save(); renderAll(); event.currentTarget.reset(); document.querySelector("#movementDialog").close();
  toast(`Comanda registrada com ${itemCount} ${itemCount === 1 ? "item" : "itens"}.`);
});

document.querySelector("#reversalForm").addEventListener("submit", event => {
  event.preventDefault();
  const original = movements.find(item => item.id === reversingMovementId);
  const data = new FormData(event.currentTarget);
  const seller = sellers.find(item => item.id === data.get("sellerId"));
  const reason = data.get("reason").trim();
  const selectedMovements = original
    ? [original, ...(data.get("includeLinked") ? linkedReversibleMovements(original) : [])]
    : [];
  const resolvedMovements = selectedMovements.map(movement => {
    const product = products.find(item => item.id === movement.productId);
    return { movement, product, variant: findVariant(product, movement.variantId) };
  });
  if (!original || movementIsReversed(original) || !resolvedMovements.length || resolvedMovements.some(item => !item.product || !item.variant)) {
    return toast("Esta movimentação não pode mais ser estornada.");
  }
  if (!seller || !reason) return toast("Qual o motivo do estorno?");

  const stockRemovals = new Map();
  resolvedMovements.filter(item => item.movement.type === "entrada").forEach(item => {
    const key = `${item.product.id}:${item.variant.id}`;
    const current = stockRemovals.get(key) || { ...item, quantity: 0 };
    current.quantity += item.movement.quantity;
    stockRemovals.set(key, current);
  });
  const insufficient = [...stockRemovals.values()].find(item => item.variant.stock < item.quantity);
  if (insufficient) {
    return toast(`Não há saldo suficiente para estornar esta entrada. Saldo atual de ${insufficient.product.name}, cor ${insufficient.variant.color}: ${insufficient.variant.stock}.`);
  }

  const reversalDate = new Date().toISOString();
  const reversalBatchId = resolvedMovements.length > 1 ? id("ESTCMD") : "";
  const reversalRecords = resolvedMovements.map(({ movement, product, variant }) => {
    if (movement.type === "entrada") variant.stock -= movement.quantity;
    if (movement.type === "saida") variant.stock += movement.quantity;
    const reversalId = id("EST");
    movement.reversed = true;
    movement.reversedBy = reversalId;
    return {
      id: reversalId,
      ...(reversalBatchId ? { batchId: reversalBatchId } : {}),
      type: "estorno",
      productId: movement.productId,
      productName: movement.productName || product.name,
      variantId: variant.id,
      variantColor: movement.variantColor || variant.color,
      sellerId: seller.id,
      sellerName: seller.name,
      quantity: movement.quantity,
      note: `Estorno de ${typeLabel(movement.type).toLowerCase()}: ${reason}`,
      date: reversalDate,
      reversalOf: movement.id,
      effect: movement.type === "entrada" ? "saida" : "entrada",
    };
  });
  movements.unshift(...reversalRecords);
  reversingMovementId = null;
  save();
  renderAll();
  event.currentTarget.reset();
  document.querySelector("#reversalDialog").close();
  toast(reversalRecords.length === 1
    ? "Movimentação estornada com sucesso."
    : `${reversalRecords.length} movimentações estornadas com sucesso.`);
});

document.querySelector("#editProductForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const product = products.find(item => item.id === editingProductId);
  const data = new FormData(form);
  const category = categories.find(item => item.id === data.get("category"));
  if (!product || !category) return toast("Não foi possível salvar a edição.");
  const before = {
    name: product.name,
    category: product.category,
    size: product.size || "",
    imageUrl: product.imageUrl || "",
  };
  const newName = data.get("name").trim();
  const newSize = data.get("size").trim();
  if (!newName) return toast("Informe o nome/modelo do produto.");
  if (products.some(item =>
    item.id !== product.id &&
    item.name.toLowerCase() === newName.toLowerCase()
  )) return toast("Já existe outro produto com esse nome/modelo.");
  const imageFile = document.querySelector("#editProductImageInput").files[0];
  let uploadedImageUrl = "";
  if (imageFile) {
    try {
      uploadedImageUrl = await uploadProductImage(imageFile);
    } catch (error) {
      return toast(error.message);
    }
  }
  product.name = newName;
  product.category = category.name;
  product.categoryId = category.id;
  product.size = newSize;
  product.imageUrl = uploadedImageUrl || (removeEditingProductImage ? "" : before.imageUrl);
  const changes = [
    ["Nome", before.name, product.name],
    ["Categoria", before.category, product.category],
    ["Medida", before.size, product.size],
    ["Imagem", before.imageUrl ? "imagem anterior" : "sem imagem", product.imageUrl === before.imageUrl
      ? (before.imageUrl ? "imagem anterior" : "sem imagem")
      : (product.imageUrl ? "nova imagem" : "sem imagem")],
  ].filter(([, oldValue, newValue]) => oldValue !== newValue)
    .map(([label, oldValue, newValue]) => `${label}: “${oldValue || "não informado"}” → “${newValue || "não informado"}”`);
  if (changes.length) addConfigurationRecord(product.name, `Produto editado. ${changes.join("; ")}.`);
  editingProductId = null;
  await save();
  if (before.imageUrl && before.imageUrl !== product.imageUrl) await deleteProductImage(before.imageUrl);
  editProductImageObjectUrl = replacePreviewObjectUrl(editProductImageObjectUrl, null);
  removeEditingProductImage = false;
  renderAll(); form.reset(); document.querySelector("#editProductDialog").close();
  toast(changes.length ? "Produto atualizado com sucesso." : "Nenhuma alteração foi realizada.");
});

document.querySelector("#editCategoryForm").addEventListener("submit", event => {
  event.preventDefault();
  const category = categories.find(item => item.id === editingCategoryId);
  const name = new FormData(event.currentTarget).get("name").trim();
  if (!category) return toast("Categoria não encontrada.");
  if (categories.some(item => item.id !== category.id && item.name.toLowerCase() === name.toLowerCase())) return toast("Essa categoria já existe.");
  const previousName = category.name;
  category.name = name;
  products.filter(product => product.categoryId === category.id).forEach(product => { product.category = name; });
  if (previousName !== name) addConfigurationRecord(name, `Categoria editada. Nome: “${previousName}” → “${name}”.`);
  editingCategoryId = null;
  save(); renderAll(); event.currentTarget.reset(); document.querySelector("#editCategoryDialog").close();
  toast(previousName !== name ? "Categoria atualizada." : "Nenhuma alteração foi realizada.");
});

document.querySelector("#editSellerForm").addEventListener("submit", event => {
  event.preventDefault();
  const seller = sellers.find(item => item.id === editingSellerId);
  const name = new FormData(event.currentTarget).get("name").trim();
  if (!seller) return toast("Atendente não encontrado.");
  if (sellers.some(item => item.id !== seller.id && item.name.toLowerCase() === name.toLowerCase())) return toast("Esse atendente já existe.");
  const previousName = seller.name;
  seller.name = name;
  if (previousName !== name) addConfigurationRecord(name, `Atendente editado. Nome: “${previousName}” → “${name}”.`);
  editingSellerId = null;
  save(); renderAll(); event.currentTarget.reset(); document.querySelector("#editSellerDialog").close();
  toast(previousName !== name ? "Atendente atualizado." : "Nenhuma alteração foi realizada.");
});

document.addEventListener("click", async event => {
  const button = event.target.closest("button[data-id]");
  if (!button) return;
  const targetId = button.dataset.id;
  if (!adminAuthenticated && (button.classList.contains("edit-product") || button.classList.contains("delete-product"))) {
    toast("Libere o acesso administrativo pela engrenagem.");
    return;
  }
  if (button.classList.contains("generate-catalog")) {
    const product = products.find(item => item.id === targetId);
    if (!product || product.variants.length <= 1) return toast("O catálogo está disponível apenas para produtos com mais de uma cor.");
    await openCatalog(product);
    return;
  }
  if (button.classList.contains("delete-movement")) {
    if (!adminAuthenticated) return toast("Libere o acesso administrativo para excluir registros.");
    const movement = movements.find(item => item.id === targetId);
    if (!movement) return toast("Registro não encontrado.");
    if (!await askConfirmation({
      title: "Excluir este registro?",
      message: movement.type === "estorno"
        ? "Somente esta linha será removida. O lançamento original continuará marcado como estornado e o saldo não será alterado."
        : "Somente esta linha será removida do Histórico. O saldo atual dos produtos não será alterado.",
      confirmText: "Excluir registro",
    })) return;
    movements = removeMovementRecord(movement.id);
    await save();
    renderAll();
    toast("Registro excluído do Histórico.");
    return;
  }
  if (button.classList.contains("reverse-movement")) {
    const movement = movements.find(item => item.id === targetId);
    const product = products.find(item => item.id === movement?.productId);
    const variant = findVariant(product, movement?.variantId);
    if (!movement || !product || !variant || movementIsReversed(movement) || !["entrada", "saida"].includes(movement.type)) {
      return toast("Esta movimentação não pode ser estornada.");
    }
    if (!sellers.length) return toast("Cadastre um atendente para registrar o estorno.");
    reversingMovementId = movement.id;
    refreshSelects();
    syncLinkedReversalOption(movement);
    document.querySelector("#reversalDescription").textContent =
      `${typeLabel(movement.type)} de ${movement.quantity} unidade(s) de ${product.name}, cor ${movement.variantColor || variant.color}, realizada em ${formatDate(movement.date)}.`;
    document.querySelector("#reversalDialog").showModal();
    return;
  }
  if (button.classList.contains("edit-category")) {
    const category = categories.find(item => item.id === targetId);
    if (!category) return;
    editingCategoryId = category.id;
    document.querySelector("#editCategoryForm").elements.name.value = category.name;
    document.querySelector("#editCategoryDialog").showModal();
    return;
  }
  if (button.classList.contains("edit-seller")) {
    const seller = sellers.find(item => item.id === targetId);
    if (!seller) return;
    editingSellerId = seller.id;
    document.querySelector("#editSellerForm").elements.name.value = seller.name;
    document.querySelector("#editSellerDialog").showModal();
    return;
  }
  if (button.classList.contains("edit-product")) {
    const product = products.find(item => item.id === targetId);
    if (!product) return;
    editingProductId = product.id;
    refreshSelects();
    const form = document.querySelector("#editProductForm");
    form.elements.name.value = product.name;
    form.elements.category.value = product.categoryId;
    form.elements.size.value = product.size || "";
    document.querySelector("#editProductImageInput").value = "";
    editProductImageObjectUrl = replacePreviewObjectUrl(editProductImageObjectUrl, null);
    removeEditingProductImage = false;
    renderImagePreview(document.querySelector("#editProductImagePreview"), product.imageUrl || "", product.name);
    document.querySelector("#removeProductImageButton").disabled = !product.imageUrl;
    document.querySelector("#editProductDialog").showModal();
    return;
  }
  if (button.classList.contains("delete-product")) {
    if (!await askConfirmation({
      title: "Excluir produto?",
      message: "O produto será removido da lista, mas os registros anteriores continuarão disponíveis no Histórico.",
      confirmText: "Excluir produto",
    })) return;
    const product = products.find(item => item.id === targetId);
    products = products.filter(item => item.id !== targetId);
    if (product) {
      addConfigurationRecord(product.name, "Produto excluído.");
      await save();
      await Promise.all([product.imageUrl, ...product.variants.map(variant => variant.imageUrl)].filter(Boolean).map(deleteProductImage));
    }
    renderAll();
    toast("Produto excluído.");
    return;
  }
  if (button.classList.contains("delete-category")) {
    if (products.some(item => item.categoryId === targetId)) return toast("Esta categoria está sendo usada por um produto.");
    if (!await askConfirmation({
      title: "Excluir categoria?",
      message: "Esta categoria será removida definitivamente do cadastro.",
      confirmText: "Excluir categoria",
    })) return;
    const category = categories.find(item => item.id === targetId);
    categories = categories.filter(item => item.id !== targetId);
    if (category) addConfigurationRecord(category.name, "Categoria excluída.");
    await save();
    renderAll();
    toast("Categoria excluída.");
    return;
  }
  if (button.classList.contains("delete-seller")) {
    if (!await askConfirmation({
      title: "Excluir atendente?",
      message: "O atendente deixará de aparecer em novas movimentações. O nome continuará preservado nos registros anteriores do Histórico.",
      confirmText: "Excluir atendente",
    })) return;
    const seller = sellers.find(item => item.id === targetId);
    movements = movements.map(movement =>
      movement.sellerId === targetId && !movement.sellerName
        ? { ...movement, sellerName: seller?.name || "Atendente excluído" }
        : movement
    );
    sellers = sellers.filter(item => item.id !== targetId);
    if (seller) addConfigurationRecord(seller.name, "Atendente excluído.");
    await save();
    renderAll();
    toast("Atendente excluído. O Histórico foi preservado.");
    return;
  }
  save(); renderAll();
});

document.querySelector("#downloadCatalogPng").addEventListener("click", () => {
  if (!catalogCanvas || !catalogProduct) return;
  catalogCanvas.toBlob(blob => {
    if (blob) downloadBlob(blob, `cores-${safeFilename(catalogProduct.name)}-${reportDate()}.png`);
  }, "image/png");
});
document.querySelector("#downloadCatalogPdf").addEventListener("click", () => {
  if (!catalogCanvas || !catalogProduct) return;
  catalogCanvas.toBlob(async blob => {
    if (!blob) return toast("Não foi possível preparar o PDF.");
    const jpeg = new Uint8Array(await blob.arrayBuffer());
    downloadBlob(jpegPdfBlob(jpeg, catalogCanvas.width, catalogCanvas.height), `cores-${safeFilename(catalogProduct.name)}-${reportDate()}.pdf`);
  }, "image/jpeg", .92);
});

document.querySelector("#clearMovementsButton").addEventListener("click", async () => {
  if (!adminAuthenticated) return toast("Libere o acesso administrativo para excluir o histórico.");
  if (!movements.length) return toast("O histórico já está vazio.");
  if (await askConfirmation({
    title: "Excluir todo o histórico?",
    message: "Todos os registros de entradas, saídas e configurações serão apagados. Os saldos atuais dos produtos não serão alterados.",
    confirmText: "Excluir histórico",
  })) {
    movements = [];
    save(); renderAll(); toast("Histórico excluído.");
  }
});

function openReport(type) {
  const parameters = new URLSearchParams({ tipo: type });
  window.location.assign(`/relatorio.html?${parameters}`);
}

document.querySelector("#exportStockButton").addEventListener("click", () => {
  if (!products.length) return toast("Não há produtos para visualizar.");
  openReport("estoque");
});

applyPerformanceMode(readPerformanceMode());
initialize();
