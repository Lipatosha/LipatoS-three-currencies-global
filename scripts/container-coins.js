const MODULE_ID = "lipatos-three-currencies-global";
const COINS = Object.freeze({
  cp: { name: "Медная монета", img: "modules/lipatos-three-currencies-global/assets/coins/copper.webp" },
  sp: { name: "Серебряная монета", img: "modules/lipatos-three-currencies-global/assets/coins/silver.webp" },
  gp: { name: "Золотая монета", img: "modules/lipatos-three-currencies-global/assets/coins/gold.webp" }
});

const actorQueues = new Map();
const wiredActorRoots = new WeakSet();
const wiredCurrencyIcons = new WeakSet();
const wiredContainerRoots = new WeakSet();
const CURRENCY_DRAG_TYPE = "LipatoSCurrency";

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
        value: "<p>Физическая " + coin.name.toLowerCase()
          + ". При переносе из контейнера в инвентарь персонажа автоматически зачисляется в счётчик "
          + denomination.toUpperCase() + ".</p>"
      },
      quantity: Math.max(1, Math.floor(Number(quantity) || 1)),
      weight: { value: 0.02, units: "lb" },
      price: { value: 1, denomination },
      type: { value: "treasure" },
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

function applyCurrencyIcons() {
  const currencies = CONFIG?.DND5E?.currencies;
  if (!currencies) return;
  for (const denomination of ["gp", "sp", "cp"]) {
    if (currencies[denomination]) currencies[denomination].icon = COINS[denomination].img;
  }
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
      const icon = label?.querySelector("i.currency." + denomination);
      if (!icon) continue;

      icon.draggable = true;
      icon.dataset.lipatosCurrency = denomination;
      icon.dataset.tooltip = "Перетащить " + COINS[denomination].name.toLowerCase() + " в контейнер";
      icon.setAttribute("aria-label", icon.dataset.tooltip);

      if (wiredCurrencyIcons.has(icon)) continue;
      wiredCurrencyIcons.add(icon);

      icon.addEventListener("dragstart", event => {
        const available = Math.max(0, Math.floor(Number(actor.system?.currency?.[denomination] ?? 0)));
        if (!available) {
          event.preventDefault();
          ui.notifications.warn("LipatoS: у персонажа нет " + COINS[denomination].name.toLowerCase() + ".");
          return;
        }

        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", JSON.stringify({
          type: CURRENCY_DRAG_TYPE,
          actorUuid: actor.uuid,
          denomination
        }));
        icon.classList.add("lipatos-dragging-currency");
      });

      icon.addEventListener("dragend", () => icon.classList.remove("lipatos-dragging-currency"));
    }
  }
}

function currencyDragData(event) {
  const data = parseDropData(event);
  return data?.type === CURRENCY_DRAG_TYPE && COINS[data.denomination] ? data : null;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

async function promptCurrencyAmount(actor, denomination, container) {
  const maximum = Math.max(0, Math.floor(Number(actor.system?.currency?.[denomination] ?? 0)));
  if (!maximum) return 0;
  if (maximum === 1) return 1;

  const result = await foundry.applications.api.DialogV2.prompt({
    rejectClose: false,
    window: { title: "Переместить монеты" },
    position: { width: 380 },
    content:
      '<div class="form-group"><label>Количество</label><div class="form-fields">'
      + '<input name="amount" type="number" min="1" max="' + maximum + '" step="1" value="' + maximum + '">'
      + '</div></div><p class="notes">Из «' + escapeHtml(actor.name) + '» в «'
      + escapeHtml(container.name) + '». Доступно: ' + maximum + '.</p>',
    ok: {
      label: "Переместить",
      callback: (_event, button) => {
        const amount = Math.floor(Number(button.form.elements.amount.value));
        if (!Number.isFinite(amount)) return 0;
        return Math.min(maximum, Math.max(1, amount));
      }
    }
  });
  return Number(result) || 0;
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

  root.addEventListener("drop", event => {
    const data = currencyDragData(event);
    if (!data) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    void moveCurrencyToContainer(data, container).catch(err => {
      console.error(MODULE_ID + " | Ошибка перемещения валюты в контейнер", err);
      ui.notifications.error("LipatoS: не удалось переместить монеты в контейнер.");
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

async function absorbDroppedCoin(actor, item) {
  const denomination = coinDenomination(item);
  if (!denomination) return;

  if (!game.user.isGM && !item.isOwner) {
    ui.notifications.warn("LipatoS: эту стопку монет нельзя забрать без прав владельца.");
    return;
  }

  const quantity = coinQuantity(item);
  if (!(await creditActorCurrency(actor, denomination, quantity))) return;

  if (item.isEmbedded) {
    try {
      await item.delete();
    } catch (err) {
      console.error(MODULE_ID + " | Монеты зачислены, но исходную стопку удалить не удалось", err);
      ui.notifications.warn("LipatoS: монеты зачислены, но исходную стопку удалить не удалось.");
    }
  }

  ui.notifications.info(actor.name + ": +" + quantity + " × " + denominationLabel(denomination));
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

  // Dropping an existing physical coin onto a container keeps it physical.
  if (event.target.closest(".container[data-item-id]")) return;

  if (data?.type !== "Item") return;
  const item = syncItemFromDropData(data);
  if (!item || !coinDenomination(item)) return;

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
  root.addEventListener("drop", event => onCharacterInventoryDrop(event, actor), true);
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
  if (!source || !isManagedTemplate(source) || !coinDenomination(source)) return;

  if (!container.isOwner) {
    ui.notifications.warn("LipatoS: нет прав на изменение этого контейнера.");
    return false;
  }

  const denomination = coinDenomination(source);
  const quantity = coinQuantity(source);
  void putPhysicalCoinsInContainer(container, denomination, quantity).catch(err => {
    console.error(MODULE_ID + " | Не удалось положить монеты в контейнер", err);
    ui.notifications.error("LipatoS: не удалось положить монеты в контейнер.");
  });

  // Stop D&D5e from moving the managed world template into a world container.
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

Hooks.once("init", applyCurrencyIcons);

Hooks.on("renderApplicationV2", (app, html) => {
  hideContainerCurrency(app, html);
  bindCharacterDrop(app, html);
  decorateCharacterCurrency(app, html);
  bindContainerCurrencyDrop(app, html);
});
Hooks.on("renderApplication", (app, html) => {
  hideContainerCurrency(app, html);
  bindCharacterDrop(app, html);
  decorateCharacterCurrency(app, html);
  bindContainerCurrencyDrop(app, html);
});
Hooks.on("renderItemSheet", (app, html) => {
  hideContainerCurrency(app, html);
  bindContainerCurrencyDrop(app, html);
});
Hooks.on("renderActorSheet", (app, html) => {
  bindCharacterDrop(app, html);
  decorateCharacterCurrency(app, html);
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

Hooks.once("ready", async () => {
  if (!isDnd5e() || !game.user.isGM) return;
  await ensureCoinTemplates();
  await migrateAllContainerCurrency();
});
