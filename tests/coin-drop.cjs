const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("scripts/container-coins.js", "utf8");
const hooks = new Map();
const listeners = new Map();
const property = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
const game = {system: {id: "dnd5e"}, user: {id: "player", isGM: false}};
const Elements = class {};
const character = {documentName: "Actor", type: "character", uuid: "Actor.1"};
const silver = {
  documentName: "Item", uuid: "Actor.1.Item.silver", name: "Серебро", system: {quantity: 51, container: "wallet"},
  getFlag: (module, key) => module === "lipatos-three-currencies-global" && key === "coin" ? "sp" : undefined
};
const findUuid = uuid => uuid === character.uuid ? character : uuid === silver.uuid ? silver : null;
const sandbox = {
  Hooks: {
    on(name, callback) { hooks.set(name, callback); },
    once() {}
  },
  window: {addEventListener(name, callback) {listeners.set(name, callback);}},
  document: {
    addEventListener() {},
    querySelectorAll() {return [];}
  },
  Element: Elements,
  foundry: {
    utils: {getProperty: property},
    applications: {ux: {TextEditor: {implementation: {getDragEventData(event) {return event.payload;}}}}, instances: new Map()}
  },
  game,
  fromUuidSync: findUuid,
  console,
  ui: {notifications: {warn() {}, error() {}, info() {}}},
  globalThis: null
};
vm.runInNewContext(source + "\nglobalThis.__test = {installGlobalCurrencyDrag};", sandbox, {filename: "container-coins.js"});

const beforeCreate = hooks.get("preCreateItem");
assert.equal(typeof beforeCreate, "function", "a preCreateItem guard must be installed");

const created = (denomination, container, type = "character") => ({
  parent: {documentName: "Actor", type},
  system: {container},
  getFlag(module, key) {
    return module === "lipatos-three-currencies-global" && key === "coin" ? denomination : undefined;
  }
});
assert.equal(beforeCreate(created("sp", null), {}, {}, "player"), false, "root inventory coins forbidden");
assert.equal(beforeCreate(created("gp", undefined), {}, {}, "player"), false, "missing container also forbidden");
assert.equal(beforeCreate(created("sp", "container123"), {}, {}, "player"), undefined, "container coins allowed");
assert.equal(beforeCreate(created(null, null), {}, {}, "player"), undefined, "other items unaffected");
assert.equal(beforeCreate(created("cp", null, "npc"), {}, {}, "player"), undefined, "other actor types unaffected");
assert.equal(beforeCreate(created("sp", null), {}, {}, "another-user"), undefined, "only originating client guards a creation");

sandbox.__test.installGlobalCurrencyDrag();
const dropHandler = listeners.get("drop");
assert.equal(typeof dropHandler, "function", "window-level capture must intercept drops");

class DropElement extends Elements {
  closest(selector) {
    if (selector === "[data-lipatos-currency-actor-uuid]") {
      return {dataset: {lipatosCurrencyActorUuid: character.uuid}};
    }
    if (selector === "dnd5e-inventory, .inventory-element") return {};
    return null;
  }
}
let blocked = 0;
const event = {
  target: new DropElement(),
  payload: {type: "Item", uuid: silver.uuid},
  preventDefault() {blocked++;},
  stopPropagation() {},
  stopImmediatePropagation() {},
  dataTransfer: {getData() {return "";}}
};
dropHandler(event);
assert.equal(blocked, 1, "silver dropped into inventory root must be ignored");
assert.equal(silver.system.quantity, 51, "source physical stack must be preserved");
assert.match(source, /item\.delete\(\{ lipatosCurrencyTransfer: true \}\)/,
  "wallet conversion must tag the audit-safe technical deletion");
assert.doesNotMatch(source, /Hooks\.on\("createItem"/,
  "invalid inventory drops may not be auto-credited after creation");

console.log("LipatoS currency drop protection tests passed.");
