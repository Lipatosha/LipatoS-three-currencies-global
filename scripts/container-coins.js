const MODULE_ID = "lipatos-three-currencies-global";
const COINS = Object.freeze({
  cp: {
    name: "Медь",
    img: "modules/lipatos-three-currencies-global/assets/coins/copper-v2.webp",
    description: "Медная монета повседневного обращения. Используется для оплаты еды, дешёвых товаров и мелких услуг."
  },
  sp: {
    name: "Серебро",
    img: "modules/lipatos-three-currencies-global/assets/coins/silver.webp",
    description: "Серебряная монета повседневного обращения. Ею расплачиваются за обычные товары, услуги, ночлег и снаряжение."
  },
  gp: {
    name: "Золото",
    img: "modules/lipatos-three-currencies-global/assets/coins/gold.webp",
    description: "Распространённая монета для крупных покупок и торговли. Золотом оплачивают хорошее снаряжение, дорогие услуги и ценные товары."
  }
});

const actorQueues = new Map();
const wiredActorRoots = new WeakSet();
const wiredCurrencyIcons = new WeakSet();
const wiredContainerRoots = new WeakSet();
const CURRENCY_DRAG_TYPE = "LipatoSCurrency";
let activeCurrencyDrag = null;
let globalCurrencyDragBound = false;
let currencyTooltipObserver = null;
let amountPresetBound = false;
const inventoryHeaderObservers = new WeakMap();

function isDnd5e() {
  return game.system?.id === "dnd5e";
}

function getRoot(html, app) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  if (html?.element instanceof HTMLElement) return html.element;
  if (app?.element instanceof HTMLElement) return app.element;
  return null;
}

function getDocument(app) {
  return app?.document ?? app?.item ?? app?.actor ?? app?.object ?? null;
}

function coinDenomination(itemOrData) {
  const direct = itemOrData?.getFlag?.(MODULE_ID, "coin");
  const nested = foundry.utils.getProperty(itemOrData, "flags." + MODULE_ID + ".coin");
  const value = direct ?? nested;
  return Object.prototype.hasOwnProperty.call(COINS, value) ? value : null;
}

function isManagedTemplate(itemOrData) {
  return itemOrData?.getFlag?.(MODULE_ID, "managedCoinTemplate") === true
    || foundry.utils.getProperty(itemOrData, "flags." + MODULE_ID + ".managedCoinTemplate") === true;
}

function coinQuantity(itemOrData) {
  const value = Number(itemOrData?.system?.quantity ?? 1);
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function coinData(denomination, quantity=1, options={}) {
  const coin = COINS[denomination];
  if (!coin) throw new Error("Unknown coin denomination: " + denomination);
  const template = options.template === true;
  return {
    name: coin.name,
    type: "loot",
    img: coin.img,
    folder: options.folder ?? null,
    ownership: template ? { default: 0 } : undefined,
    system: {
      description: {
        value: "<p>" + coin.description + "</p>"
      },
      quantity: Math.max(1, Math.floor(Number(quantity) || 1)),
      weight: { value: 0.02, units: "lb" },
      price: { value: 1, denomination },
      type: { value: "" },
      properties: [],
      container: options.container ?? null
    },
    flags: {
      [MODULE_ID]: {
        coin: denomination,
        managedCoinTemplate: template
      }
    }
  };
}

function denominationLabel(denomination) {
  return COINS[denomination]?.name ?? denomination.toUpperCase();
}


function reorderInventoryColumns(root) {
  if (!(root instanceof Element || root instanceof DocumentFragment)) return;
  const order = ["quantity", "weight", "price"];

  const reorder = parent => {
    const children = Array.from(parent.children);
    const targets = order
      .map(id => children.find(child => child.dataset?.columnId === id))
      .filter(Boolean);
    if (targets.length < 2) return;

    const firstIndex = Math.min(...targets.map(node => children.indexOf(node)));
    const marker = document.createComment("lipatos-column-order");
    parent.insertBefore(marker, children[firstIndex]);
    for (const id of order) {
      const node = targets.find(target => target.dataset.columnId === id);
      if (node) parent.insertBefore(node, marker);
    }
    marker.remove();
  };

  for (const header of root.querySelectorAll(".items-header")) reorder(header);
  for (const row of root.querySelectorAll(".item-row")) reorder(row);
}


function wrapDirectValueText(cell) {
  let value = cell.querySelector(":scope > .lps-value-text");
  if (value) return value;

  const nodes = Array.from(cell.childNodes)
    .filter(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
  if (!nodes.length) return null;

  value = document.createElement("span");
  value.className = "lps-value-text";
  value.textContent = nodes.map(node => node.textContent.trim()).join(" ");
  for (const node of nodes) node.remove();
  cell.prepend(value);
  return value;
}

function prepareWeightValue(cell) {
  const value = wrapDirectValueText(cell);
  const icon = cell.querySelector(":scope > i.fa-weight-hanging");
  if (value && icon) {
    value.after(icon);
    icon.classList.add("lps-weight-after");
  }
  return value;
}

function primaryValueElement(cell, id) {
  if (id === "quantity") return cell.querySelector(":scope > input, :scope > .value");
  if (id === "weight") return prepareWeightValue(cell);
  if (id === "price") return wrapDirectValueText(cell);
  if (id === "roll") return cell.querySelector(".stacked > .value, :scope > .value") ?? wrapDirectValueText(cell);
  if (id === "formula") return cell.querySelector(":scope > .row > .formula");
  if (id === "uses" || id === "charges") return cell;
  return null;
}

function alignInventoryHeadersToValues(root) {
  if (!(root instanceof Element)) return;

  for (const section of root.querySelectorAll(".items-section")) {
    const header = section.querySelector(":scope > .items-header");
    if (!header) continue;

    for (const id of ["quantity", "weight", "price", "roll", "formula", "uses", "charges"]) {
      const headerCell = header.querySelector(":scope > [data-column-id='" + id + "']");
      if (!headerCell) continue;
      headerCell.style.transform = "";

      // Price is normalized by CSS below. Never move its header toward D&D5e's native
      // right-aligned price content, otherwise the Weight → Price gap becomes larger.
      if (id === "price" || id === "uses" || id === "charges") {
        if (id === "price") {
          for (const cell of section.querySelectorAll(".item-detail[data-column-id='price']")) {
            primaryValueElement(cell, "price");
          }
        }
        continue;
      }

      const rows = Array.from(section.querySelectorAll(".item-detail[data-column-id='" + id + "']"))
        .filter(cell => !cell.classList.contains("hidden-width") && !cell.classList.contains("hidden-column"));

      // Normalize every row first (not just the first one). In particular this moves
      // every weight icon after its numeric value.
      const primaries = rows.map(cell => primaryValueElement(cell, id));
      const primary = primaries.find(value => value?.getBoundingClientRect().width);
      if (!primary) continue;

      const h = headerCell.getBoundingClientRect();
      const v = primary.getBoundingClientRect();
      if (!h.width || !v.width) continue;

      const delta = (v.left + v.width / 2) - (h.left + h.width / 2);
      headerCell.style.transform = "translateX(" + delta.toFixed(2) + "px)";
    }
  }
}

function scheduleInventoryHeaderAlignment(root) {
  if (!(root instanceof Element)) return;
  const run = () => alignInventoryHeadersToValues(root);
  requestAnimationFrame(() => requestAnimationFrame(run));

  if (!inventoryHeaderObservers.has(root)) {
    const observer = new ResizeObserver(() => requestAnimationFrame(run));
    observer.observe(root);
    inventoryHeaderObservers.set(root, observer);
  }
}

function inventoryItemById(app, itemId) {
  if (!itemId) return null;
  const actor = actorFromApp(app);
  if (actor?.items?.get) {
    const item = actor.items.get(itemId);
    if (item) return item;
  }

  const document = getDocument(app);
  if (document?.documentName === "Item" && document.type === "container") {
    const item = collectionForContainer(document)?.get?.(itemId);
    if (item) return item;
  }

  return game.items?.get(itemId) ?? null;
}


function sectionItemType(section, actor) {
  const row = section.querySelector("li.item[data-item-id]");
  if (!row) return null;
  return actor?.items?.get?.(row.dataset.itemId)?.type ?? null;
}

function refreshInventoryResponsiveState(inventory) {
  if (!inventory) return;
  try {
    inventory._cacheSections?.();
    requestAnimationFrame(() => {
      const width = inventory.getBoundingClientRect().width;
      if (!width) return;
      inventory._onResize?.([{ borderBoxSize: [{ inlineSize: width }] }]);
    });
  } catch (err) {
    console.warn(MODULE_ID + " | Не удалось пересчитать адаптивные колонки инвентаря", err);
  }
}

function normalizeInventoryResponsiveColumns(app, root) {
  if (!(root instanceof Element)) return;
  const actor = actorFromApp(app);
  if (actor?.type !== "character") return;

  const inventory = root.matches?.("dnd5e-inventory") ? root : root.querySelector("dnd5e-inventory");
  if (!inventory) return;

  const sections = Array.from(inventory.querySelectorAll(".items-section"));
  let equipmentMinWidth = "250";

  // Read the equipment section's own minimum name-column width first.
  for (const section of sections) {
    if (sectionItemType(section, actor) === "equipment") {
      equipmentMinWidth = section.dataset.columnMinWidth || "250";
      break;
    }
  }

  for (const section of sections) {
    const type = sectionItemType(section, actor);
    const header = section.querySelector(":scope > .items-header");
    if (!header) continue;

    // Keep the basic economy columns the same physical width everywhere.
    for (const id of ["quantity", "weight", "price", "charges", "uses"]) {
      const cell = header.querySelector(":scope > [data-column-id='" + id + "']");
      if (cell) cell.dataset.columnWidth = "76";
    }

    if (type !== "weapon") continue;

    // A weapon has extra Roll + Formula columns. On narrow sheets those must disappear
    // BEFORE the normal inventory columns so the weapon name area behaves like Equipment.
    section.dataset.columnMinWidth = equipmentMinWidth;
    const priorities = {
      controls: 1000,
      charges: 900,
      uses: 900,
      quantity: 800,
      weight: 700,
      price: 600,
      roll: 200,
      formula: 100
    };
    for (const [id, priority] of Object.entries(priorities)) {
      const cell = header.querySelector(":scope > [data-column-id='" + id + "']");
      if (cell) cell.dataset.columnPriority = String(priority);
    }
  }

  refreshInventoryResponsiveState(inventory);
}

function decorateInventoryLayout(app, html) {
  const root = getRoot(html, app);
  if (!root) return;
  reorderInventoryColumns(root);
  normalizeInventoryResponsiveColumns(app, root);
  scheduleInventoryHeaderAlignment(root);
}

async function normalizePhysicalCoins() {
  if (!game.user.isGM || !isDnd5e()) return;

  const seen = new Set();
  const normalize = async item => {
    const denomination = coinDenomination(item);
    if (!item || !denomination) return;

    const key = item.uuid ?? item.id;
    if (seen.has(key)) return;
    seen.add(key);

    const desired = COINS[denomination];
    const updates = {};

    if (item.name !== desired.name) updates.name = desired.name;
    if (item.img !== desired.img) updates.img = desired.img;
    if (Number(item.system?.price?.value ?? 0) !== 1) updates["system.price.value"] = 1;
    if (item.system?.price?.denomination !== denomination) {
      updates["system.price.denomination"] = denomination;
    }
    if (item.system?.type?.value) updates["system.type.value"] = "";

    const desiredDescription = "<p>" + desired.description + "</p>";
    if ((item.system?.description?.value ?? "") !== desiredDescription) {
      updates["system.description.value"] = desiredDescription;
    }

    if (Object.keys(updates).length) await item.update(updates);
  };

  for (const item of game.items ?? []) await normalize(item);
  for (const actor of game.actors ?? []) {
    for (const item of actor.items ?? []) await normalize(item);
  }
}


function hideContainerCurrency(app, html) {
  if (!isDnd5e()) return;
  const item = getDocument(app);
  if (item?.documentName !== "Item" || item.type !== "container") return;
  const root = getRoot(html, app);
  if (!root) return;

  root.classList.add("lipatos-physical-coins-container");
  for (const section of root.querySelectorAll("dnd5e-inventory > section.currency, dnd5e-inventory section.currency")) {
    section.style.setProperty("display", "none", "important");
  }
}

function actorFromApp(app) {
  const doc = getDocument(app);
  if (doc?.documentName === "Actor") return doc;
  if (app?.actor?.documentName === "Actor") return app.actor;
  return null;
}

function decorateCharacterCurrency(app, html) {
  if (!isDnd5e()) return;
  const actor = actorFromApp(app);
  if (actor?.type !== "character") return;

  const root = getRoot(html, app);
  if (!root) return;
  root.classList.add("lipatos-physical-currency-icons");

  for (const denomination of ["gp", "sp", "cp"]) {
    for (const input of root.querySelectorAll('input[name="system.currency.' + denomination + '"]')) {
      const label = input.closest("label") ?? input.parentElement;
      if (!label) continue;

      let icon = label.querySelector("img.lipatos-currency-drag." + denomination);
      if (!icon) {
        const oldIcon = label.querySelector("i.currency." + denomination + ", span.currency." + denomination);
        icon = document.createElement("img");
        icon.className = "currency " + denomination + " lipatos-currency-drag";
        icon.src = COINS[denomination].img;
        icon.alt = COINS[denomination].name;
        oldIcon?.replaceWith(icon);
        if (!oldIcon) label.prepend(icon);
      }

      icon.src = COINS[denomination].img;
      icon.draggable = true;
      icon.dataset.lipatosCurrency = denomination;
      icon.dataset.actorUuid = actor.uuid;
      icon.dataset.tooltip = COINS[denomination].name;
      icon.setAttribute("aria-label", COINS[denomination].name);

      if (wiredCurrencyIcons.has(icon)) continue;
      wiredCurrencyIcons.add(icon);

      icon.addEventListener("dragstart", event => {
        const available = Math.max(0, Math.floor(Number(actor.system?.currency?.[denomination] ?? 0)));
        if (!available) {
          event.preventDefault();
          ui.notifications.warn("LipatoS: у персонажа нет " + COINS[denomination].name.toLowerCase() + ".");
          return;
        }

        const payload = {
          type: CURRENCY_DRAG_TYPE,
          actorUuid: actor.uuid,
          denomination
        };
        activeCurrencyDrag = payload;

        event.stopImmediatePropagation?.();
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", JSON.stringify(payload));
        event.dataTransfer.setData("application/x-lipatos-currency", JSON.stringify(payload));
        icon.classList.add("lipatos-dragging-currency");
      }, true);

      icon.addEventListener("dragend", () => {
        activeCurrencyDrag = null;
        icon.classList.remove("lipatos-dragging-currency");
      }, true);
    }
  }
}
function currencyDragData(event) {
  let data = null;
  try {
    const custom = event.dataTransfer?.getData("application/x-lipatos-currency");
    if (custom) data = JSON.parse(custom);
  } catch {}
  data ??= parseDropData(event);
  data ??= activeCurrencyDrag;
  return data?.type === CURRENCY_DRAG_TYPE && COINS[data.denomination] ? data : null;
}


function currencyDenominationFromElement(element) {
  if (!(element instanceof Element)) return null;
  return ["gp", "sp", "cp"].find(denomination => element.classList.contains(denomination)) ?? null;
}

function decorateCurrencyTooltipElement(element) {
  const denomination = currencyDenominationFromElement(element);
  if (!denomination) return;
  const name = COINS[denomination].name;
  element.dataset.tooltip = name;
  element.setAttribute("aria-label", name);
  element.removeAttribute("title");
  if (element instanceof HTMLImageElement && !element.alt) element.alt = name;
}

function decorateCurrencyTooltips(root=document) {
  if (!(root instanceof Document || root instanceof Element || root instanceof DocumentFragment)) return;
  if (root instanceof Element && root.matches(":is(i, span, img).currency:is(.gp, .sp, .cp)")) {
    decorateCurrencyTooltipElement(root);
  }
  for (const element of root.querySelectorAll?.(":is(i, span, img).currency:is(.gp, .sp, .cp)") ?? []) {
    decorateCurrencyTooltipElement(element);
  }
}

function installCurrencyTooltipObserver() {
  if (currencyTooltipObserver || !document.body) return;
  decorateCurrencyTooltips(document);
  currencyTooltipObserver = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) decorateCurrencyTooltips(node);
      }
    }
  });
  currencyTooltipObserver.observe(document.body, { childList: true, subtree: true });
}

function applicationFromElement(element) {
  const application = element?.closest?.(".application");
  if (!application?.id) return null;
  return foundry.applications.instances.get(application.id) ?? null;
}

function resolveContainerDropTarget(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return null;

  const containerElement = target.closest(".container[data-item-id]");
  if (containerElement) {
    try {
      const uuid = containerElement.dataset.uuid;
      const item = uuid && globalThis.fromUuidSync ? fromUuidSync(uuid, { strict: false }) : null;
      if (item?.documentName === "Item" && item.type === "container") return item;
    } catch {}

    const app = applicationFromElement(containerElement);
    const actor = actorFromApp(app);
    const item = actor?.items?.get(containerElement.dataset.itemId);
    if (item?.type === "container") return item;
  }

  const app = applicationFromElement(target);
  const document = getDocument(app);
  if (document?.documentName === "Item" && document.type === "container") return document;

  return null;
}

function clearCurrencyDropTargets() {
  for (const element of document.querySelectorAll(".lipatos-currency-drop-target")) {
    element.classList.remove("lipatos-currency-drop-target");
  }
}

function installGlobalCurrencyDrag() {
  if (globalCurrencyDragBound) return;
  globalCurrencyDragBound = true;

  document.addEventListener("dragover", event => {
    if (!activeCurrencyDrag) return;
    const container = resolveContainerDropTarget(event);
    if (!container) return;

    event.preventDefault();
    event.stopImmediatePropagation?.();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";

    clearCurrencyDropTargets();
    const target = event.target instanceof Element
      ? (event.target.closest(".container[data-item-id]") ?? event.target.closest(".application"))
      : null;
    target?.classList.add("lipatos-currency-drop-target");
  }, true);

  document.addEventListener("drop", event => {
    const container = resolveContainerDropTarget(event);

    // GM world-item coin templates must be intercepted here, at document capture phase,
    // BEFORE D&D5e can clone the item into the actor root inventory.
    if (container) {
      const itemData = parseDropData(event);
      if (itemData?.type === "Item") {
        const source = syncItemFromDropData(itemData);
        if (isWorldCoinTemplate(source)) {
          event.preventDefault();
          event.stopImmediatePropagation?.();
          event.stopPropagation();
          clearCurrencyDropTargets();

          void grantWorldTemplateCoinsToContainer(container, source).catch(err => {
            console.error(MODULE_ID + " | Ошибка глобальной выдачи монет ГМа в контейнер", err);
            ui.notifications.error("LipatoS: не удалось добавить монеты в контейнер.");
          });
          return;
        }
      }
    }

    const data = currencyDragData(event);
    if (!data || !container) return;

    event.preventDefault();
    event.stopImmediatePropagation?.();
    event.stopPropagation();
    clearCurrencyDropTargets();

    void moveCurrencyToContainer(data, container).catch(err => {
      console.error(MODULE_ID + " | Ошибка глобального переноса валюты в контейнер", err);
      ui.notifications.error("LipatoS: не удалось переместить монеты в контейнер.");
    });
  }, true);

  document.addEventListener("dragend", clearCurrencyDropTargets, true);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function installAmountPresetButtons() {
  if (amountPresetBound) return;
  amountPresetBound = true;

  document.addEventListener("click", event => {
    const button = event.target.closest?.("[data-lipatos-amount-preset]");
    if (!button) return;

    const form = button.closest("form");
    const input = form?.elements?.amount ?? form?.querySelector?.('input[name="amount"]');
    if (!input) return;

    event.preventDefault();
    event.stopPropagation();

    const maximum = Math.max(1, Math.floor(Number(input.max) || Number(button.dataset.maximum) || 1));
    const preset = button.dataset.lipatosAmountPreset;
    input.value = preset === "half" ? Math.max(1, Math.floor(maximum / 2)) : maximum;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.focus();
    input.select();
  }, true);
}

async function promptTransferAmount({ maximum=null, fromName, toName, title="Передать монеты", defaultValue=null }) {
  const limited = Number.isFinite(Number(maximum)) && Number(maximum) > 0;
  const max = limited ? Math.max(1, Math.floor(Number(maximum))) : null;
  const initial = Math.max(1, Math.floor(Number(defaultValue ?? (limited ? max : 1)) || 1));
  const value = limited ? Math.min(max, initial) : initial;

  const maxAttr = limited ? ' max="' + max + '"' : "";
  const presets = limited
    ? '<div class="lps-coin-transfer-presets">'
      + '<button type="button" data-lipatos-amount-preset="all" data-maximum="' + max + '">'
      + '<i class="fa-solid fa-coins"></i><span>Всё</span></button>'
      + '<button type="button" data-lipatos-amount-preset="half" data-maximum="' + max + '">'
      + '<i class="fa-solid fa-circle-half-stroke"></i><span>Половина</span></button>'
      + '</div>'
    : "";

  const result = await foundry.applications.api.DialogV2.prompt({
    rejectClose: false,
    window: { title },
    position: { width: 400 },
    content:
      '<div class="lps-coin-transfer">'
      + '<div class="form-group"><label>Количество</label><div class="form-fields">'
      + '<input name="amount" type="number" min="1"' + maxAttr + ' step="1" value="' + value + '">'
      + '</div></div>'
      + presets
      + '</div>',
    ok: {
      label: "Подтвердить",
      icon: "fa-solid fa-check",
      callback: (_event, button) => {
        const amount = Math.floor(Number(button.form.elements.amount.value));
        if (!Number.isFinite(amount) || amount < 1) return 0;
        return limited ? Math.min(max, amount) : amount;
      }
    }
  });

  return Number(result) || 0;
}

async function promptCurrencyAmount(actor, denomination, container) {
  return promptTransferAmount({
    maximum: actor.system?.currency?.[denomination] ?? 0,
    fromName: actor.name,
    toName: container.name,
    title: "Переместить " + COINS[denomination].name.toLowerCase()
  });
}

async function moveCurrencyToContainer(data, container) {
  if (!data?.actorUuid || !COINS[data.denomination] || container?.type !== "container") return;

  const actor = await fromUuid(data.actorUuid);
  if (actor?.documentName !== "Actor" || actor.type !== "character") return;

  if (!game.user.isGM && (!actor.isOwner || !container.isOwner)) {
    ui.notifications.warn("LipatoS: нет прав на перемещение этих монет.");
    return;
  }
  if (!(await container.system.canDropContents())) return;

  const denomination = data.denomination;
  const amount = await promptCurrencyAmount(actor, denomination, container);
  if (!amount) return;

  await enqueueActor(actor, async () => {
    const current = Math.max(0, Math.floor(Number(actor.system?.currency?.[denomination] ?? 0)));
    if (current < amount) throw new Error("Недостаточно монет у персонажа.");

    await actor.update({ ["system.currency." + denomination]: current - amount });
    try {
      await putPhysicalCoinsInContainer(container, denomination, amount);
    } catch (err) {
      const after = Math.max(0, Math.floor(Number(actor.system?.currency?.[denomination] ?? 0)));
      await actor.update({ ["system.currency." + denomination]: after + amount });
      throw err;
    }
  });

  ui.notifications.info(actor.name + ": -" + amount + " × " + denominationLabel(denomination)
    + " → " + container.name);
}

function bindContainerCurrencyDrop(app, html) {
  if (!isDnd5e()) return;
  const container = getDocument(app);
  if (container?.documentName !== "Item" || container.type !== "container") return;

  const root = getRoot(html, app);
  if (!root || wiredContainerRoots.has(root)) return;
  wiredContainerRoots.add(root);

  root.addEventListener("dragover", event => {
    // Currency-counter drags and normal Item drags are both valid candidates.
    const types = Array.from(event.dataTransfer?.types ?? []);
    if (!activeCurrencyDrag && !types.includes("text/plain")) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    root.classList.add("lipatos-currency-drop-target");
  }, true);

  root.addEventListener("dragleave", event => {
    if (!root.contains(event.relatedTarget)) root.classList.remove("lipatos-currency-drop-target");
  }, true);

  root.addEventListener("drop", event => {
    root.classList.remove("lipatos-currency-drop-target");

    const currencyData = currencyDragData(event);
    if (currencyData) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      void moveCurrencyToContainer(currencyData, container).catch(err => {
        console.error(MODULE_ID + " | Ошибка перемещения валюты в контейнер", err);
        ui.notifications.error("LipatoS: не удалось переместить монеты в контейнер.");
      });
      return;
    }

    const data = parseDropData(event);
    if (data?.type !== "Item") return;
    const source = syncItemFromDropData(data);
    if (!isWorldCoinTemplate(source)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    void grantWorldTemplateCoinsToContainer(container, source).catch(err => {
      console.error(MODULE_ID + " | Ошибка выдачи монет ГМа в открытый контейнер", err);
      ui.notifications.error("LipatoS: не удалось добавить монеты в контейнер.");
    });
  }, true);
}

function parseDropData(event) {
  try {
    return foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
  } catch {
    try {
      return JSON.parse(event.dataTransfer?.getData("text/plain") || "{}");
    } catch {
      return {};
    }
  }
}

function syncItemFromDropData(data) {
  try {
    if (data?.uuid && globalThis.fromUuidSync) return fromUuidSync(data.uuid, { strict: false });
  } catch {
    // Ignore documents that are not synchronously available.
  }
  if (data?.id) return game.items?.get(data.id) ?? null;
  return null;
}

function enqueueActor(actor, operation) {
  const key = actor.uuid ?? actor.id;
  const previous = actorQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation).finally(() => {
    if (actorQueues.get(key) === next) actorQueues.delete(key);
  });
  actorQueues.set(key, next);
  return next;
}

async function creditActorCurrency(actor, denomination, quantity) {
  if (!COINS[denomination] || actor?.type !== "character") return false;
  if (!game.user.isGM && !actor.isOwner) {
    ui.notifications.warn("LipatoS: нет прав на изменение валюты этого персонажа.");
    return false;
  }

  const amount = Math.max(1, Math.floor(Number(quantity) || 1));
  await enqueueActor(actor, async () => {
    const current = Number(actor.system?.currency?.[denomination] ?? 0) || 0;
    await actor.update({ ["system.currency." + denomination]: current + amount });
  });
  return true;
}

function isWorldCoinTemplate(item) {
  return !!item && !item.isEmbedded && isManagedTemplate(item) && !!coinDenomination(item);
}

async function grantWorldTemplateCoinsToContainer(container, source) {
  const denomination = coinDenomination(source);
  if (!denomination || container?.type !== "container" || !isWorldCoinTemplate(source)) return;

  if (!game.user.isGM && !container.isOwner) {
    ui.notifications.warn("LipatoS: нет прав на изменение этого контейнера.");
    return;
  }
  if (!(await container.system.canDropContents())) return;

  const amount = await promptTransferAmount({
    maximum: null,
    defaultValue: 1,
    fromName: "Предметы ГМа",
    toName: container.name,
    title: "Добавить " + COINS[denomination].name.toLowerCase()
  });
  if (!amount) return;

  await putPhysicalCoinsInContainer(container, denomination, amount);
  ui.notifications.info(container.name + ": +" + amount + " × " + denominationLabel(denomination));
}

async function absorbDroppedCoin(actor, item) {
  const denomination = coinDenomination(item);
  if (!denomination) return;

  if (!game.user.isGM && !item.isOwner) {
    ui.notifications.warn("LipatoS: эту стопку монет нельзя забрать без прав владельца.");
    return;
  }

  const templateSource = isWorldCoinTemplate(item);
  const maximum = templateSource ? null : coinQuantity(item);
  const sourceContainer = item.system?.container
    ? collectionForContainer(item)?.get?.(item.system.container)
    : null;
  const amount = await promptTransferAmount({
    maximum,
    defaultValue: templateSource ? 1 : maximum,
    fromName: templateSource ? "Предметы ГМа" : (sourceContainer?.name ?? item.name),
    toName: actor.name,
    title: (templateSource ? "Выдать " : "Передать ") + COINS[denomination].name.toLowerCase()
  });
  if (!amount) return;

  if (!(await creditActorCurrency(actor, denomination, amount))) return;

  if (item.isEmbedded) {
    try {
      if (amount >= coinQuantity(item)) await item.delete();
      else await item.update({ "system.quantity": coinQuantity(item) - amount });
    } catch (err) {
      console.error(MODULE_ID + " | Монеты зачислены, но исходную стопку обновить не удалось", err);
      // Roll back the actor currency to avoid duplication if source update fails.
      await enqueueActor(actor, async () => {
        const current = Math.max(0, Math.floor(Number(actor.system?.currency?.[denomination] ?? 0)));
        await actor.update({ ["system.currency." + denomination]: Math.max(0, current - amount) });
      });
      ui.notifications.error("LipatoS: не удалось завершить передачу монет.");
      return;
    }
  }

  ui.notifications.info(actor.name + ": +" + amount + " × " + denominationLabel(denomination));
}

function onCharacterInventoryDrop(event, actor) {
  if (event.defaultPrevented || actor?.type !== "character") return;
  if (!event.target?.closest?.("dnd5e-inventory, .inventory-element")) return;

  const data = parseDropData(event);

  if (data?.type === CURRENCY_DRAG_TYPE) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    const target = event.target.closest(".container[data-item-id]");
    if (!target) return;

    const container = actor.items.get(target.dataset.itemId);
    if (container?.type !== "container") return;

    void moveCurrencyToContainer(data, container).catch(err => {
      console.error(MODULE_ID + " | Ошибка перемещения валюты в контейнер", err);
      ui.notifications.error("LipatoS: не удалось переместить монеты в контейнер.");
    });
    return;
  }

  if (data?.type !== "Item") return;
  const item = syncItemFromDropData(data);
  if (!item || !coinDenomination(item)) return;

  const containerTarget = event.target.closest(".container[data-item-id]");
  if (containerTarget && isWorldCoinTemplate(item)) {
    const container = actor.items.get(containerTarget.dataset.itemId);
    if (container?.type !== "container") return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    void grantWorldTemplateCoinsToContainer(container, item).catch(err => {
      console.error(MODULE_ID + " | Ошибка выдачи монет ГМа в контейнер", err);
      ui.notifications.error("LipatoS: не удалось добавить монеты в контейнер.");
    });
    return;
  }

  // Existing embedded physical coin stacks still use the native D&D5e container move.
  if (containerTarget) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();

  void absorbDroppedCoin(actor, item).catch(err => {
    console.error(MODULE_ID + " | Ошибка зачисления монет", err);
    ui.notifications.error("LipatoS: не удалось зачислить монеты.");
  });
}

function bindCharacterDrop(app, html) {
  if (!isDnd5e()) return;
  const actor = actorFromApp(app);
  if (actor?.type !== "character") return;

  const root = getRoot(html, app);
  if (!root || wiredActorRoots.has(root)) return;
  wiredActorRoots.add(root);

  root.addEventListener("dragover", event => {
    if (!activeCurrencyDrag) return;
    const target = event.target.closest?.(".container[data-item-id]");
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    target.classList.add("lipatos-currency-drop-target");
  }, true);

  root.addEventListener("dragleave", event => {
    const target = event.target.closest?.(".container[data-item-id]");
    target?.classList.remove("lipatos-currency-drop-target");
  }, true);

  root.addEventListener("drop", event => {
    const target = event.target.closest?.(".container[data-item-id]");
    target?.classList.remove("lipatos-currency-drop-target");
    onCharacterInventoryDrop(event, actor);
  }, true);
}

function collectionForContainer(container) {
  return container.actor?.items ?? game.items;
}

function findCoinStack(container, denomination) {
  return collectionForContainer(container)?.find?.(item =>
    item.id !== container.id
    && item.system?.container === container.id
    && coinDenomination(item) === denomination
  ) ?? null;
}

async function putPhysicalCoinsInContainer(container, denomination, quantity) {
  if (!COINS[denomination] || container?.type !== "container") return null;
  const amount = Math.max(1, Math.floor(Number(quantity) || 1));
  const existing = findCoinStack(container, denomination);

  if (existing) {
    await existing.update({ "system.quantity": coinQuantity(existing) + amount });
    return existing;
  }

  const data = coinData(denomination, amount, {
    container: container.id,
    folder: container.actor ? null : (container.folder?.id ?? null)
  });
  const options = container.actor ? { parent: container.actor } : {};
  const created = await Item.createDocuments([data], options);
  return created[0] ?? null;
}

function onContainerSheetDrop(container, _sheet, data) {
  if (!isDnd5e() || container?.type !== "container" || data?.type !== "Item") return;
  const source = syncItemFromDropData(data);
  if (!isWorldCoinTemplate(source)) return;

  if (!container.isOwner && !game.user.isGM) {
    ui.notifications.warn("LipatoS: нет прав на изменение этого контейнера.");
    return false;
  }

  void grantWorldTemplateCoinsToContainer(container, source).catch(err => {
    console.error(MODULE_ID + " | Не удалось выдать монеты ГМа в контейнер", err);
    ui.notifications.error("LipatoS: не удалось добавить монеты в контейнер.");
  });

  // Never let D&D5e clone the 1-coin GM template into the actor root inventory.
  return false;
}

async function absorbCreatedInventoryCoin(item) {
  if (!item?.isEmbedded || item.actor?.type !== "character") return;
  if (item.system?.container) return;

  const denomination = coinDenomination(item);
  if (!denomination) return;
  const quantity = coinQuantity(item);

  if (!(await creditActorCurrency(item.actor, denomination, quantity))) return;
  const actorName = item.actor.name;
  await item.delete();
  ui.notifications.info(actorName + ": +" + quantity + " × " + denominationLabel(denomination));
}

async function ensureCoinTemplates() {
  if (!game.user.isGM || !isDnd5e()) return;

  let folder = game.folders?.find(f => f.type === "Item" && f.getFlag?.(MODULE_ID, "coinFolder") === true);
  if (!folder) {
    folder = await Folder.create({
      name: "LipatoS — Монеты",
      type: "Item",
      flags: { [MODULE_ID]: { coinFolder: true } }
    });
  }

  for (const denomination of ["gp", "sp", "cp"]) {
    const desired = COINS[denomination];
    let item = game.items?.find(i => isManagedTemplate(i) && coinDenomination(i) === denomination);

    if (!item) {
      await Item.create(coinData(denomination, 1, { template: true, folder: folder.id }));
      continue;
    }

    const updates = {};
    if (item.name !== desired.name) updates.name = desired.name;
    if (item.img !== desired.img) updates.img = desired.img;
    if (item.folder?.id !== folder.id) updates.folder = folder.id;
    if (coinQuantity(item) !== 1) updates["system.quantity"] = 1;
    if (item.system?.price?.value !== 1) updates["system.price.value"] = 1;
    if (item.system?.price?.denomination !== denomination) updates["system.price.denomination"] = denomination;
    if (item.system?.type?.value) updates["system.type.value"] = "";
    const desiredDescription = "<p>" + desired.description + "</p>";
    if ((item.system?.description?.value ?? "") !== desiredDescription) {
      updates["system.description.value"] = desiredDescription;
    }
    if (item.system?.weight?.value !== 0.02) updates["system.weight.value"] = 0.02;
    if (item.system?.weight?.units !== "lb") updates["system.weight.units"] = "lb";
    if (Object.keys(updates).length) await item.update(updates);
  }
}

function containerCurrencyAmounts(container) {
  const currency = container.system?.currency ?? {};
  const cp = Math.max(0, Math.floor(Number(currency.cp) || 0));
  const sp = Math.max(0, Math.floor(Number(currency.sp) || 0))
    + Math.max(0, Math.floor(Number(currency.ep) || 0)) * 5;
  const gp = Math.max(0, Math.floor(Number(currency.gp) || 0))
    + Math.max(0, Math.floor(Number(currency.pp) || 0)) * 10;
  return { cp, sp, gp };
}

async function migrateContainerCurrency(container) {
  if (container?.type !== "container") return;
  const amounts = containerCurrencyAmounts(container);
  if (!amounts.cp && !amounts.sp && !amounts.gp) return;

  for (const denomination of ["gp", "sp", "cp"]) {
    const quantity = amounts[denomination];
    if (quantity) await putPhysicalCoinsInContainer(container, denomination, quantity);
  }

  await container.update({
    "system.currency.cp": 0,
    "system.currency.sp": 0,
    "system.currency.gp": 0,
    "system.currency.ep": 0,
    "system.currency.pp": 0
  });
}

async function migrateAllContainerCurrency() {
  if (!game.user.isGM || !isDnd5e()) return;

  const seen = new Set();
  const migrate = async container => {
    if (!container || container.type !== "container") return;
    const key = container.uuid ?? ((container.parent?.uuid ?? "world") + ":" + container.id);
    if (seen.has(key)) return;
    seen.add(key);
    try {
      await migrateContainerCurrency(container);
    } catch (err) {
      console.error(MODULE_ID + " | Не удалось перенести валюту контейнера " + container.name + " в предметы-монеты", err);
    }
  };

  for (const item of game.items ?? []) await migrate(item);

  const actors = [];
  for (const actor of game.actors ?? []) actors.push(actor);
  for (const scene of game.scenes ?? []) {
    for (const token of scene.tokens ?? []) {
      if (!token.actorLink && token.actor) actors.push(token.actor);
    }
  }

  for (const actor of actors) {
    for (const item of actor.items ?? []) await migrate(item);
  }
}

Hooks.on("renderApplicationV2", (app, html) => {
  hideContainerCurrency(app, html);
  bindCharacterDrop(app, html);
  decorateCharacterCurrency(app, html);
  bindContainerCurrencyDrop(app, html);
  decorateCurrencyTooltips(getRoot(html, app) ?? document);
  decorateInventoryLayout(app, html);
});
Hooks.on("renderApplication", (app, html) => {
  hideContainerCurrency(app, html);
  bindCharacterDrop(app, html);
  decorateCharacterCurrency(app, html);
  bindContainerCurrencyDrop(app, html);
  decorateCurrencyTooltips(getRoot(html, app) ?? document);
  decorateInventoryLayout(app, html);
});
Hooks.on("renderItemSheet", (app, html) => {
  hideContainerCurrency(app, html);
  bindContainerCurrencyDrop(app, html);
  decorateInventoryLayout(app, html);
});
Hooks.on("renderActorSheet", (app, html) => {
  bindCharacterDrop(app, html);
  decorateCharacterCurrency(app, html);
  decorateInventoryLayout(app, html);
});
Hooks.on("dnd5e.dropItemSheetData", onContainerSheetDrop);

Hooks.on("createItem", (item, _options, userId) => {
  if (!isDnd5e() || userId !== game.user.id || !coinDenomination(item)) return;
  if (item.system?.container) return;
  setTimeout(() => {
    Promise.resolve(absorbCreatedInventoryCoin(item))
      .catch(err => console.error(MODULE_ID + " | Ошибка обработки предмета-монеты", err));
  }, 0);
});

Hooks.once("ready", () => {
  if (!isDnd5e()) return;
  installGlobalCurrencyDrag();
  installCurrencyTooltipObserver();
  installAmountPresetButtons();
});

Hooks.once("ready", async () => {
  if (!isDnd5e() || !game.user.isGM) return;
  await ensureCoinTemplates();
  await normalizePhysicalCoins();
  await migrateAllContainerCurrency();
});
