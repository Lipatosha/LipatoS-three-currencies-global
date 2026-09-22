const MODULE_ID = "lipatos-three-currencies-global";
const EP_PATH = "system.currency.ep";
const PP_PATH = "system.currency.pp";
const SP_PATH = "system.currency.sp";
const GP_PATH = "system.currency.gp";

function isDnd5e() {
  return game.system?.id === "dnd5e";
}

function getEp(actor) {
  return Number(foundry.utils.getProperty(actor, EP_PATH) ?? 0) || 0;
}

function getPp(actor) {
  return Number(foundry.utils.getProperty(actor, PP_PATH) ?? 0) || 0;
}

function getGp(actor) {
  return Number(foundry.utils.getProperty(actor, GP_PATH) ?? 0) || 0;
}

function getSp(actor) {
  return Number(foundry.utils.getProperty(actor, SP_PATH) ?? 0) || 0;
}

function isElectrumCurrency(currency) {
  const path = `${currency?.data?.path ?? currency?.path ?? ""}`.toLowerCase();
  const abbreviation = `${currency?.abbreviation ?? ""}`
    .toLowerCase()
    .replaceAll("{#}", "")
    .replace(/[^a-z]/g, "");
  const name = `${currency?.name ?? ""}`.toLowerCase();
  const img = `${currency?.img ?? ""}`.toLowerCase();
  return path.endsWith("currency.ep") || path.endsWith(".ep") || abbreviation === "ep" ||
    name.includes("electrum") || name.includes("электрум") || /(^|\/)electrum\.(png|webp|jpg|jpeg|svg)$/.test(img);
}

function isPlatinumCurrency(currency) {
  const path = `${currency?.data?.path ?? currency?.path ?? ""}`.toLowerCase();
  const abbreviation = `${currency?.abbreviation ?? ""}`
    .toLowerCase()
    .replaceAll("{#}", "")
    .replace(/[^a-z]/g, "");
  const name = `${currency?.name ?? ""}`.toLowerCase();
  const img = `${currency?.img ?? ""}`.toLowerCase();
  return path.endsWith("currency.pp") || path.endsWith(".pp") || abbreviation === "pp" ||
    name.includes("platinum") || name.includes("платин") || /(^|\/)platinum\.(png|webp|jpg|jpeg|svg)$/.test(img);
}

function isRemovedCurrency(currency) {
  return isElectrumCurrency(currency) || isPlatinumCurrency(currency);
}

/** Prevent EP and PP from ever being written back to an Actor. */
function enforceRemovedCurrencies(_actor, changes) {
  if (!isDnd5e() || !changes) return;

  if (Object.prototype.hasOwnProperty.call(changes, EP_PATH)) changes[EP_PATH] = 0;
  if (Object.prototype.hasOwnProperty.call(changes, PP_PATH)) changes[PP_PATH] = 0;
  if (changes.system?.currency) {
    if (Object.prototype.hasOwnProperty.call(changes.system.currency, "ep")) changes.system.currency.ep = 0;
    if (Object.prototype.hasOwnProperty.call(changes.system.currency, "pp")) changes.system.currency.pp = 0;
  }
}

/** Existing removed currencies are converted once, then forced to zero. */
async function convertAndRemoveCurrencies(actor) {
  if (!actor) return;

  const ep = getEp(actor);
  const pp = getPp(actor);
  if (!ep && !pp) return;

  const updates = {};
  if (ep) {
    updates[EP_PATH] = 0;
    updates[SP_PATH] = getSp(actor) + ep * 5;
  }
  if (pp) {
    updates[PP_PATH] = 0;
    updates[GP_PATH] = getGp(actor) + pp * 10;
  }

  await actor.update(updates);
}

function getRoot(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  if (html?.element instanceof HTMLElement) return html.element;
  return null;
}

/**
 * Find the smallest wrapper that belongs only to the EP control.
 * This deliberately avoids generic ancestors such as `.currency`, because in
 * D&D5e v6 that class can wrap the ENTIRE money panel.
 */
function findSingleCurrencyWrapper(input, root) {
  let node = input;
  for (let i = 0; i < 7 && node && node !== root; i++, node = node.parentElement) {
    const currencyInputs = node.querySelectorAll?.('input[name^="system.currency."]') ?? [];
    if (currencyInputs.length === 1 && currencyInputs[0] === input) return node;
    if (currencyInputs.length > 1) break;
  }
  return input;
}

function hideRemovedCurrencyUi(html) {
  if (!isDnd5e()) return;
  const root = getRoot(html);
  if (!root) return;

  const explicit = root.querySelectorAll([
    '[data-currency="ep"]', '[data-currency="pp"]',
    '[data-denomination="ep"]', '[data-denomination="pp"]',
    '[data-key="ep"]', '[data-key="pp"]',
    '[data-currency-key="ep"]', '[data-currency-key="pp"]'
  ].join(','));
  for (const node of explicit) node.style.setProperty("display", "none", "important");

  for (const input of root.querySelectorAll('input[name="system.currency.ep"], input[name="system.currency.pp"]')) {
    const wrapper = findSingleCurrencyWrapper(input, root);
    wrapper.style.setProperty("display", "none", "important");

    if (wrapper === input && input.id) {
      const label = root.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      label?.style?.setProperty("display", "none", "important");
    }
  }

  for (const node of root.querySelectorAll('label, span, div')) {
    if (node.children.length > 2) continue;
    const text = (node.textContent ?? "").trim().toLowerCase();
    if (!["ep", "электрум", "electrum", "pp", "платина", "платиновая", "platinum"].includes(text)) continue;
    const parent = node.parentElement;
    if (parent?.querySelectorAll?.('input[name^="system.currency."]').length > 1) continue;
    node.style.setProperty("display", "none", "important");
  }
}

/** Remove EP and PP from D&D5e's public currency definition where possible. */
function removeRemovedCurrenciesFromDnd5eConfig() {
  if (!isDnd5e()) return;
  try {
    const currencies = CONFIG?.DND5E?.currencies;
    if (currencies) {
      if (Object.prototype.hasOwnProperty.call(currencies, "ep")) delete currencies.ep;
      if (Object.prototype.hasOwnProperty.call(currencies, "pp")) delete currencies.pp;
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | Не удалось убрать EP/PP из CONFIG.DND5E.currencies`, err);
  }
}

async function removeRemovedCurrenciesFromItemPiles() {
  if (!game.user?.isGM) return;
  const api = game.itempiles?.API;
  if (!api) return;

  try {
    if (Array.isArray(api.CURRENCIES) && typeof api.setCurrencies === "function") {
      const currencies = api.CURRENCIES;
      const filtered = currencies.filter((currency) => !isRemovedCurrency(currency));
      if (filtered.length !== currencies.length) await api.setCurrencies(filtered);
    }

    if (Array.isArray(api.SECONDARY_CURRENCIES) && typeof api.setSecondaryCurrencies === "function") {
      const currencies = api.SECONDARY_CURRENCIES;
      const filtered = currencies.filter((currency) => !isRemovedCurrency(currency));
      if (filtered.length !== currencies.length) await api.setSecondaryCurrencies(filtered);
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | Не удалось обновить глобальный список валют Item Piles`, err);
  }

  for (const actor of game.actors ?? []) {
    const pileData = actor.getFlag?.("item-piles", "data");
    if (!pileData) continue;

    const updates = {};
    for (const key of ["overrideCurrencies", "overrideSecondaryCurrencies"]) {
      if (!Array.isArray(pileData[key])) continue;
      const filtered = pileData[key].filter((currency) => !isRemovedCurrency(currency));
      if (filtered.length !== pileData[key].length) updates[`flags.item-piles.data.${key}`] = filtered;
    }

    if (Object.keys(updates).length) {
      try {
        await actor.update(updates);
      } catch (err) {
        console.warn(`${MODULE_ID} | Не удалось убрать EP/PP из настроек ${actor.name}`, err);
      }
    }
  }
}

async function cleanWorldActors() {
  if (!game.user?.isGM || !isDnd5e()) return;

  const processed = new Set();
  const clean = async (actor) => {
    if (!actor) return;
    const key = actor.uuid ?? actor.id;
    if (processed.has(key)) return;
    processed.add(key);
    try {
      await convertAndRemoveCurrencies(actor);
    } catch (err) {
      console.warn(`${MODULE_ID} | Не удалось конвертировать EP/PP у ${actor.name}`, err);
    }
  };

  for (const actor of game.actors ?? []) await clean(actor);
  for (const scene of game.scenes ?? []) {
    for (const token of scene.tokens ?? []) {
      if (token.actorLink) continue;
      await clean(token.actor);
    }
  }
}

Hooks.once("init", () => {
  if (!isDnd5e()) return;
  removeRemovedCurrenciesFromDnd5eConfig();
});

Hooks.on("preUpdateActor", enforceRemovedCurrencies);
Hooks.on("renderActorSheet", (_app, html) => hideRemovedCurrencyUi(html));
Hooks.on("renderApplication", (_app, html) => hideRemovedCurrencyUi(html));

Hooks.once("ready", async () => {
  if (!isDnd5e()) return;

  removeRemovedCurrenciesFromDnd5eConfig();

  if (game.user?.isGM) {
    await cleanWorldActors();
    await removeRemovedCurrenciesFromItemPiles();
    setTimeout(() => removeRemovedCurrenciesFromItemPiles(), 1200);
  }

  hideRemovedCurrencyUi(document.body);
});
