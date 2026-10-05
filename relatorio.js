const parameters = new URLSearchParams(window.location.search);
const reportType = parameters.get("tipo") === "historico" ? "historico" : "estoque";
const requestedFilter = ["entrada", "saida", "estorno", "configuracao"].includes(parameters.get("filtro"))
  ? parameters.get("filtro")
  : "";

const typeLabels = {
  entrada: "Entrada",
  saida: "Saída",
  estorno: "Estorno",
  configuracao: "Configuração",
};

const filterLabels = {
  "": "Todos os registros",
  entrada: "Somente entradas de carimbos",
  saida: "Somente saídas de carimbos",
  estorno: "Somente estornos",
  configuracao: "Somente configurações do painel",
};

let loadedState = null;
let adminAuthenticated = false;
let dateRangeStart = null;
let dateRangeEnd = null;

function totalStock(product) {
  return (product.variants || []).reduce((total, variant) => total + (Number(variant.stock) || 0), 0);
}

function validColor(value, fallback = "#20242b") {
  return /^#[0-9a-f]{6}$/i.test(value || "") ? value : fallback;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function localDateParts(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return { date, year, month: `${year}-${month}`, day: `${year}-${month}-${day}` };
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function monthLabel(value) {
  const parts = localDateParts(value);
  return parts ? capitalize(parts.date.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })) : "Data não informada";
}

function selectedPeriodLabel() {
  if (!dateRangeStart || !dateRangeEnd) return "Todo o período";
  return `${dateRangeStart.label} até ${dateRangeEnd.label}`;
}

function parseNativeDate(value, endOfDay = false) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return null;
  return { date, label: `${day}/${month}/${year}` };
}

function appendImage(container, imageUrl, alt, openable = false, measure = "") {
  if (!imageUrl) {
    container.appendChild(createElement("span", "image-fallback", "—"));
    return;
  }
  const image = new Image();
  image.src = imageUrl;
  image.alt = alt;
  image.loading = "eager";
  image.addEventListener("error", () => {
    image.remove();
    container.appendChild(createElement("span", "image-fallback", "—"));
  }, { once: true });
  if (!openable) {
    container.appendChild(image);
    return;
  }
  const button = createElement("button", "report-image-button");
  button.type = "button";
  button.setAttribute("aria-label", `Abrir imagem de ${alt}`);
  button.dataset.imageUrl = imageUrl;
  button.dataset.imageTitle = alt;
  button.dataset.imageMeasure = measure;
  button.appendChild(image);
  container.appendChild(button);
}

function renderSummary(items) {
  const summary = document.querySelector("#summaryGrid");
  summary.replaceChildren(...items.map(item => {
    const card = createElement("article", `summary-card ${item.tone || ""}`.trim());
    card.append(createElement("strong", "", item.value), createElement("span", "", item.label));
    return card;
  }));
}

function stockVariantRow(variant) {
  const row = createElement("div", "variant-row");
  const name = createElement("div", "variant-name");
  const swatch = createElement("span", "color-swatch");
  const primary = validColor(variant.rgb);
  const secondary = validColor(variant.rgb2, primary);
  swatch.style.background = secondary === primary
    ? primary
    : `linear-gradient(90deg, ${primary} 0 50%, ${secondary} 50% 100%)`;
  name.append(swatch, createElement("span", "", variant.color || "Sem cor"));
  const stock = Number(variant.stock) || 0;
  const quantity = createElement("span", `variant-stock${stock <= 0 ? " zero" : ""}`, stock);
  const status = createElement("span", `status-pill${stock <= 0 ? " zero" : ""}`, stock > 0 ? "Disponível" : "Zerado");
  row.append(name, quantity, status);
  return row;
}

function stockProductCard(product) {
  const card = createElement("article", "stock-product");
  const header = createElement("header", "stock-product-header");
  const thumb = createElement("div", "product-thumb");
  appendImage(thumb, product.imageUrl, product.name || "Produto", true, product.size || "");

  const heading = createElement("div", "product-heading");
  const meta = createElement("div", "product-meta");
  meta.append(
    createElement("span", "product-category", product.category || "Sem categoria"),
    createElement("span", "product-measure", product.size || "Medida não informada"),
  );
  heading.append(createElement("strong", "", product.name || "Produto sem nome"), meta);

  const total = totalStock(product);
  const totalBox = createElement("div", `product-total${total <= 0 ? " zero" : ""}`);
  totalBox.append(createElement("small", "", "SALDO TOTAL"), createElement("strong", "", total));
  header.append(thumb, heading, totalBox);

  const columns = createElement("div", "variant-heading");
  columns.append(createElement("span", "", "COR / VARIAÇÃO"), createElement("span", "", "QTD."), createElement("span", "", "SITUAÇÃO"));
  card.append(header, columns, ...(product.variants || []).map(stockVariantRow));
  return card;
}

function renderStock(state) {
  const products = state.products || [];
  const units = products.reduce((total, product) => total + totalStock(product), 0);
  const variants = products.reduce((total, product) => total + (product.variants || []).length, 0);
  document.title = "Estoque atual | Disque Cópias";
  document.querySelector("#reportTitle").textContent = "Estoque atual";
  document.querySelector("#reportSubtitle").textContent = "Posição por modelo e por cor, seguindo a ordem do painel.";
  renderSummary([
    { label: "Modelos", value: products.length, tone: "blue" },
    { label: "Cores cadastradas", value: variants, tone: "purple" },
    { label: "Unidades em estoque", value: units, tone: "green" },
    { label: "Produtos zerados", value: products.filter(product => totalStock(product) === 0).length, tone: "red" },
  ]);

  const content = document.querySelector("#reportContent");
  if (!products.length) {
    const empty = createElement("div", "empty-report");
    empty.append(createElement("strong", "", "Nenhum produto cadastrado"), document.createTextNode("O estoque ainda não possui itens para exibir."));
    content.replaceChildren(empty);
    return;
  }
  const grid = createElement("div", "stock-grid");
  grid.append(...products.map(stockProductCard));
  content.replaceChildren(grid);
}

function movementSellerName(movement, sellers) {
  if (!movement.sellerId) return "—";
  const name = movement.sellerName || sellers.find(seller => seller.id === movement.sellerId)?.name || "Atendente excluído";
  return String(name).replace(/Vendedor/g, "Atendente").replace(/vendedor/g, "atendente");
}

function historyQuantity(movement) {
  if (movement.type === "configuracao") return "—";
  if (movement.type === "estorno") return `↶${Number(movement.quantity) || 0}`;
  return `${movement.type === "saida" ? "−" : "+"}${Number(movement.quantity) || 0}`;
}

function historyRecordCell(movement, product) {
  const cell = createElement("td", "record-column");
  const wrapper = createElement("div", "record-cell");
  const thumb = createElement("div", "record-thumb");
  const variant = (product?.variants || []).find(item => item.id === movement.variantId);
  appendImage(thumb, variant?.imageUrl || product?.imageUrl, product?.name || movement.productName || "Registro");
  const copy = createElement("div", "record-copy");
  const recordName = product?.name || movement.productName || (movement.type === "configuracao" ? "Configuração do painel" : "Produto excluído");
  const details = movement.type === "configuracao"
    ? "Configuração do painel"
    : [movement.variantColor ? `Cor: ${movement.variantColor}` : "", product?.size ? `Medida: ${product.size}` : "", movement.reversedBy ? "Estornado" : movement.reversalOf ? "Estorno confirmado" : ""].filter(Boolean).join(" · ");
  copy.append(createElement("strong", "", recordName), createElement("span", "", details || "—"));
  wrapper.append(thumb, copy);
  cell.appendChild(wrapper);
  return cell;
}

function historyRow(movement, products, sellers) {
  const row = document.createElement("tr");
  const product = products.find(item => item.id === movement.productId);
  const date = createElement("td", "date-column", formatDate(movement.date));
  const seller = createElement("td", "seller-column", movementSellerName(movement, sellers));
  const type = createElement("td", "type-column");
  type.appendChild(createElement("span", `type-pill ${movement.type || ""}`.trim(), typeLabels[movement.type] || "Registro"));
  const quantity = createElement("td", `quantity-column ${movement.type || ""}`.trim(), historyQuantity(movement));
  const noteText = movement.type === "configuracao"
    ? String(movement.note || "—").replace(/Vendedores/g, "Atendentes").replace(/vendedores/g, "atendentes").replace(/Vendedor/g, "Atendente").replace(/vendedor/g, "atendente")
    : movement.note || "—";
  const note = createElement("td", "note-cell", noteText);
  row.append(date, historyRecordCell(movement, product), seller, type, quantity, note);
  return row;
}

function createHistoryTable(movements, products, sellers) {
  const wrap = createElement("div", "history-table-wrap");
  const table = createElement("table", "history-table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  [
    ["Data e hora", "date-column"],
    ["Registro", "record-column"],
    ["Atendente", "seller-column"],
    ["Tipo", "type-column"],
    ["Quantidade", "quantity-column"],
    ["Observação", "note-column"],
  ].forEach(([label, className]) => headRow.appendChild(createElement("th", className, label)));
  head.appendChild(headRow);
  const body = document.createElement("tbody");
  body.append(...movements.map(movement => historyRow(movement, products, sellers)));
  table.append(head, body);
  wrap.appendChild(table);
  return wrap;
}

function applyDateFilter(movements) {
  if (!dateRangeStart || !dateRangeEnd) return movements;
  return movements.filter(movement => {
    const date = new Date(movement.date);
    return !Number.isNaN(date.getTime()) && date >= dateRangeStart.date && date <= dateRangeEnd.date;
  });
}

function renderHistory(state, authenticated) {
  const products = state.products || [];
  const sellers = state.sellers || [];
  const permittedFilter = requestedFilter === "configuracao" && !authenticated ? "" : requestedFilter;
  const accessible = (state.movements || [])
    .filter(movement => authenticated || movement.type !== "configuracao")
    .sort((first, second) => new Date(second.date) - new Date(first.date));
  const byType = permittedFilter ? accessible.filter(movement => movement.type === permittedFilter) : accessible;
  const movements = applyDateFilter(byType);
  document.querySelector("#historyDateFilters").hidden = false;
  document.querySelector("#historyPeriodLabel").textContent = selectedPeriodLabel();
  document.title = "Histórico | Disque Cópias";
  document.querySelector("#reportTitle").textContent = "Histórico de movimentações";
  document.querySelector("#reportSubtitle").textContent = `${filterLabels[permittedFilter]} · ${selectedPeriodLabel()}`;
  renderSummary([
    { label: "Registros exibidos", value: movements.length, tone: "blue" },
    { label: "Entradas", value: movements.filter(item => item.type === "entrada").length, tone: "green" },
    { label: "Saídas", value: movements.filter(item => item.type === "saida").length, tone: "red" },
    { label: "Estornos", value: movements.filter(item => item.type === "estorno").length, tone: "purple" },
  ]);

  const content = document.querySelector("#reportContent");
  if (!movements.length) {
    const empty = createElement("div", "empty-report");
    empty.append(createElement("strong", "", "Nenhum registro encontrado"), document.createTextNode("Não existem movimentações para o filtro selecionado."));
    content.replaceChildren(empty);
    return;
  }

  const groups = new Map();
  movements.forEach(movement => {
    const key = localDateParts(movement.date)?.month || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(movement);
  });
  const sections = [...groups.values()].map(group => {
    const section = createElement("section", "history-month");
    const heading = createElement("header", "history-month-heading");
    heading.append(
      createElement("h2", "", monthLabel(group[0]?.date)),
      createElement("span", "", `${group.length} ${group.length === 1 ? "registro" : "registros"}`),
    );
    section.append(heading, createHistoryTable(group, products, sellers));
    return section;
  });
  content.replaceChildren(...sections);
}

function applyHistoryDateRange() {
  const startInput = document.querySelector("#historyStartDate");
  const endInput = document.querySelector("#historyEndDate");
  const error = document.querySelector("#periodFilterError");
  startInput.classList.remove("invalid");
  endInput.classList.remove("invalid");
  error.textContent = "";
  if (!startInput.value && !endInput.value) {
    dateRangeStart = null;
    dateRangeEnd = null;
    if (loadedState) renderHistory(loadedState, adminAuthenticated);
    return;
  }
  const start = parseNativeDate(startInput.value);
  const end = parseNativeDate(endInput.value, true);
  if (!start || !end) {
    if (!start) startInput.classList.add("invalid");
    if (!end) endInput.classList.add("invalid");
    error.textContent = "Selecione a data inicial e a data final.";
    return;
  }
  if (start.date > end.date) {
    startInput.classList.add("invalid");
    endInput.classList.add("invalid");
    error.textContent = "A data inicial deve ser anterior à data final.";
    return;
  }
  dateRangeStart = start;
  dateRangeEnd = end;
  if (loadedState) renderHistory(loadedState, adminAuthenticated);
}

async function initializeReport() {
  document.querySelector("#generatedAt").textContent = new Date().toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  try {
    const [stateResponse, adminResponse] = await Promise.all([
      fetch("/api/state", { cache: "no-store" }),
      fetch("/api/admin/status", { cache: "no-store" }).catch(() => null),
    ]);
    if (!stateResponse.ok) throw new Error("Não foi possível acessar o estoque.");
    const state = await stateResponse.json();
    const adminStatus = adminResponse?.ok ? await adminResponse.json() : { authenticated: false };
    loadedState = state;
    adminAuthenticated = Boolean(adminStatus.authenticated);
    if (reportType === "historico") renderHistory(state, adminAuthenticated);
    else renderStock(state);
  } catch (error) {
    document.querySelector("#summaryGrid").replaceChildren();
    const state = createElement("div", "report-state");
    state.append(createElement("strong", "", "Relatório indisponível"), createElement("span", "", error.message || "Não foi possível carregar as informações."));
    document.querySelector("#reportContent").replaceChildren(state);
    document.querySelector("#reportTitle").textContent = "Não foi possível abrir o relatório";
    document.querySelector("#reportSubtitle").textContent = "Volte ao painel e tente novamente.";
  }
}

document.querySelector("#printButton").addEventListener("click", () => window.print());
document.querySelector("#backButton").addEventListener("click", () => {
  if (window.history.length > 1) window.history.back();
  else window.location.assign("/");
});

document.addEventListener("click", event => {
  const button = event.target.closest(".report-image-button");
  if (!button) return;
  const title = button.dataset.imageTitle || "Imagem do produto";
  const measure = button.dataset.imageMeasure || "";
  const image = document.querySelector("#reportImagePreview");
  document.querySelector("#reportImageTitle").textContent = title;
  document.querySelector("#reportImageMeasure").textContent = measure || "Medida não informada";
  image.src = button.dataset.imageUrl;
  image.alt = title;
  document.querySelector("#reportImageDialog").showModal();
});

document.querySelector("#closeReportImage").addEventListener("click", () => document.querySelector("#reportImageDialog").close());
document.querySelector("#reportImageDialog").addEventListener("click", event => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});

document.querySelectorAll("#historyStartDate, #historyEndDate").forEach(input => {
  input.addEventListener("input", () => {
    input.classList.remove("invalid");
    document.querySelector("#periodFilterError").textContent = "";
  });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyHistoryDateRange();
    }
  });
});
document.querySelector("#applyHistoryPeriod").addEventListener("click", applyHistoryDateRange);

initializeReport();
