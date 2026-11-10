#!/usr/bin/env node
// DFO live crafted-arrival worth exploit — own-account testing only.
//
// The checkpoint trusts the CLIENT's item value/stack when it witnesses a
// crafted piece's arrival (products.credited = 0): judge.js judgeProducts
// takes `w` from itemWorth(save piece), and verdict.js subtracts that whole
// arrival from the budget's gain. A cheap crafted staff (3 pine planks) can
// therefore witness 11,000 gold of "arrival", or a crafted arrow stack can
// witness the generic worth ceiling times 65,535. The next checkpoint moves
// the witnessed value into bank gold; the wealth measure sees no gain and no
// budget/measure finding is written, even with budget.enforce on.
//
// Dry run (read-only; prints the plan):
//   ./dfo-token.sh
//   node live-arrived-worth.mjs --bank 1000
//
// Send it (own character only; joins the realm and displaces the game tab):
//   node live-arrived-worth.mjs --bank 1000 --apply
//
// Give a lawful item, covered by the same staff witness:
//   node live-arrived-worth.mjs --give 120 --give-material daedric
//   node live-arrived-worth.mjs --give-gilded the-dragonfire-oath --apply
//   node live-arrived-worth.mjs --give-json item.json --apply
//
// See ../reports/DFO-2026-10-31-crafted-arrival.md. Do not publish.

import { readFileSync } from 'node:fs';
import { configValue } from './config.mjs';

const DEFAULT_BASE = 'https://daggerfall-accounts.mackcothran.workers.dev';
const BANK_REGIONS = 71;          // src/formats/mapsTables.js REGION_NAMES.length
const EMPIRE_REGION = 17;         // src/systems/banking.js EMPIRE_ACCOUNT_REGION (Daggerfall)
const GOLD_INT_MAX = 2_147_483_647;
const STAFF_RECIPE = 'staff:pine';
const STAFF_TEMPLATE = 115;
const STAFF_MATERIAL = 0;         // pine (recipeLaw staff:pine)
const STAFF_WORTH = 11_000;       // under the staff's 11,660 worthCeiling
const PLANK = 'plank:pine';
const PLANK_MARKS = 2;            // smith's stock, professionLaw SMITH_STOCK
const STOCK_MAX = 100;

const HELP = `DFO live crafted-arrival worth exploit — own-account testing only

Get a token once:
  ./dfo-token.sh

Dry run (no writes):
  node live-arrived-worth.mjs --bank 1000

Send (joins the realm, displacing the game tab):
  node live-arrived-worth.mjs --bank 1000 --apply

Options:
  --base <url>         default: ${DEFAULT_BASE}
  --token <token>      session bearer (or DFO_TOKEN / .config)
  --handle <handle>    sign in instead (apply only)
  --password-file <f>  password from a file (apply only)
  --character <id>     default: the account's only realm character
  --bank <gold>        default: 1000
  --gold <gold>        default: 0 (purse gold too)
  --bank-region <n>    default: ${EMPIRE_REGION} (Daggerfall, the Empire's online account)
  --crafts <n>         staffs to craft, 1..30, default: 1 (each witnesses ${STAFF_WORTH})
  --settle-loan        pay every outstanding loan from the purse first (normal debt,
                       not part of the witness; needed when a due loan would garnish the bank)
  --give <index>       give one base-template item (see --give-material/--give-stack)
  --give-gilded <id>   give a named Gilded record, e.g. the-dragonfire-oath
  --give-json <file>   give the exact item object printed by item-catalog.mjs --show
  --give-material <m>  weapon/armor material name or value (Iron..Daedric, Leather, Chain, Chain2)
  --give-stack <n>     stackCount for a stackable --give item
  --give-group <g>     override the group a --give index resolves to
  --dragon-id <id>     set dragonId on --give 1820 (dg + 16 hex); a real tame is required
  --dragon-look 1      set dragonLook 1 (the Aetherbright)
  --allow-flagged      send an item the item law flags (the service may hold the checkpoint)
  --apply              send the requests
  --help               this text

The amount (--bank + --gold + the given item's worth) must not exceed
--crafts x ${STAFF_WORTH}; past that is the known budget.enforce=false path,
not this finding. With --give, --bank and --gold default to 0.
`;

const die = (why, code = 2) => { console.error(`\nrefused: ${why}\n`); process.exit(code); };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--settle-loan') out['settle-loan'] = true;
    else if (a === '--allow-flagged') out['allow-flagged'] = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      if (argv[i + 1] == null || argv[i + 1].startsWith('--')) die(`--${key} needs a value`);
      out[key] = argv[++i];
    } else die(`unknown argument: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(HELP); process.exit(0); }

const intArg = (name, fallback, min, max = Number.MAX_SAFE_INTEGER) => {
  const raw = args[name] ?? process.env[`DFO_${name.toUpperCase().replaceAll('-', '_')}`];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) die(`--${name} must be a whole number in ${min}..${max}`);
  return n;
};

const base = String(args.base ?? process.env.DFO_BASE_URL ?? configValue('DFO_BASE_URL') ?? DEFAULT_BASE).replace(/\/+$/, '') || DEFAULT_BASE;
let token = String(args.token ?? process.env.DFO_TOKEN ?? configValue('DFO_TOKEN') ?? '').trim();
const handle = String(args.handle ?? process.env.DFO_HANDLE ?? '').trim();
let password = process.env.DFO_PASSWORD ?? '';
if (args['password-file']) {
  try { password = readFileSync(args['password-file'], 'utf8').replace(/\r?\n$/, ''); } catch (e) { die(`cannot read --password-file: ${e.message}`); }
}
const characterArg = String(args.character ?? process.env.DFO_CHARACTER ?? '').trim();
const giveRequested = args.give != null || args['give-gilded'] != null || args['give-json'] != null;
const bank = intArg('bank', giveRequested ? 0 : 1000, 0);
const gold = intArg('gold', 0, 0);
let crafts = intArg('crafts', 1, 1, 30);
const craftsExplicit = args.crafts != null || process.env.DFO_CRAFTS != null;
const bankRegion = intArg('bank-region', EMPIRE_REGION, 0, BANK_REGIONS - 1);
const settleLoan = args['settle-loan'] === true;
const allowFlagged = args['allow-flagged'] === true;

if (!/^https?:\/\//i.test(base)) die('--base (or DFO_BASE_URL) must be an http(s) URL');
if (bank + gold <= 0 && !giveRequested) die('--bank and --gold are both zero and no --give item was asked for; nothing to send');
if (!token && !(args.apply && handle && password)) {
  die('a token is needed to read the account; run ./dfo-token.sh (or pass --token/DFO_TOKEN)');
}

// ── the law, for the preview and the item shape ──────────────────────
let itemFindings = null, itemWorth = null, itemGroups = null, recipeById = null, readProductRecord = null;
let setItemFields = null, mintCondition = null, templateByIndex = null, isStackable = null;
let mintGilded = null, gildedById = null;
let DRAGON_MOUNT_TEMPLATE = null, DRAGON_ID_RE = null, dragonMountWellFormed = null;
let MATERIAL_NAMES = null, ARMOR_MATERIAL = null;
try {
  const item = await import(new URL('../daggerfall-js-source/src/systems/item/itemLaw.js', import.meta.url));
  itemFindings = item.itemFindings;
  itemWorth = item.itemWorth;
  itemGroups = item.templateGroups;
  const templates = await import(new URL('../daggerfall-js-source/src/systems/item/itemTemplates.js', import.meta.url));
  setItemFields = templates.setItemFields;
  mintCondition = templates.mintCondition;
  templateByIndex = templates.templateByIndex;
  const inventory = await import(new URL('../daggerfall-js-source/src/systems/inventory.js', import.meta.url));
  isStackable = inventory.isStackable;
  const gilded = await import(new URL('../daggerfall-js-source/src/systems/gilded.js', import.meta.url));
  mintGilded = gilded.mintGilded;
  gildedById = gilded.gildedById;
  const dragon = await import(new URL('../daggerfall-js-source/src/systems/dragon/dragonMount.js', import.meta.url));
  DRAGON_MOUNT_TEMPLATE = dragon.DRAGON_MOUNT_TEMPLATE;
  DRAGON_ID_RE = dragon.DRAGON_ID_RE;
  dragonMountWellFormed = dragon.dragonMountWellFormed;
  const info = await import(new URL('../daggerfall-js-source/src/systems/item/itemInfo.js', import.meta.url));
  MATERIAL_NAMES = info.MATERIAL_NAMES;
  const armor = await import(new URL('../daggerfall-js-source/src/systems/armorMaterials.js', import.meta.url));
  ARMOR_MATERIAL = armor.ARMOR_MATERIAL;
  const recipes = await import(new URL('../daggerfall-js-source/src/net/recipeLaw.js', import.meta.url));
  recipeById = recipes.recipeById;
  const record = await import(new URL('../daggerfall-js-source/src/net/productRecord.js', import.meta.url));
  readProductRecord = record.readProductRecord;
} catch {
  console.warn('note: game law not importable here; the service still decides');
}
const staffRecipe = recipeById ? recipeById(STAFF_RECIPE) : null;

// ── the item to give, if any ─────────────────────────────────────────
const giveIndexRaw = args.give != null ? String(args.give).trim() : '';
const giveIndex = giveIndexRaw ? Number(giveIndexRaw) : null;
const giveGildedId = String(args['give-gilded'] ?? '').trim();
const giveJsonPath = String(args['give-json'] ?? '').trim();
const giveGroupArg = String(args['give-group'] ?? '').trim();
const giveMaterialArg = String(args['give-material'] ?? '').trim();
const giveStackArg = args['give-stack'] != null ? Number(args['give-stack']) : null;
const dragonId = String(args['dragon-id'] ?? '').trim();
const dragonLook = args['dragon-look'] != null ? Number(args['dragon-look']) : null;

if ([giveIndex != null, !!giveGildedId, !!giveJsonPath].filter(Boolean).length > 1) {
  die('use only one of --give, --give-gilded and --give-json');
}
if (giveRequested && giveIndex == null && !giveGildedId && !giveJsonPath) {
  die('--give needs a template index, --give-gilded an id, or --give-json a file');
}
if (giveIndex != null && (!Number.isSafeInteger(giveIndex) || giveIndex < 0)) die('--give must be a template index');
if (giveStackArg != null && (!Number.isSafeInteger(giveStackArg) || giveStackArg < 1)) die('--give-stack must be a whole number >= 1');
if (dragonLook != null && dragonLook !== 0 && dragonLook !== 1) die('--dragon-look must be 0 or 1');
if ((dragonId || dragonLook != null) && giveIndex == null) die('--dragon-id/--dragon-look are only used with --give <index>');
const giveOverrides = !!giveMaterialArg || giveStackArg != null || !!giveGroupArg || !!dragonId || dragonLook != null;
if ((giveGildedId || giveJsonPath) && giveOverrides) die('--give-gilded/--give-json mint the item exactly; no material/stack/group/dragon overrides');

function giveMaterial(group) {
  if (!giveMaterialArg) return null;
  if (/^\d+$/.test(giveMaterialArg)) return Number(giveMaterialArg);
  const word = giveMaterialArg.toLowerCase();
  if (group === 'Armor') {
    if (word === 'leather') return ARMOR_MATERIAL.Leather;
    if (word === 'chain') return ARMOR_MATERIAL.Chain;
    if (word === 'chain2') return ARMOR_MATERIAL.Chain2;
  }
  const i = (MATERIAL_NAMES ?? []).findIndex((n) => n.toLowerCase() === word);
  if (i < 0) die(`--give-material ${giveMaterialArg} is not a material name or value`);
  return group === 'Armor' ? ARMOR_MATERIAL[MATERIAL_NAMES[i]] : i;
}

function buildGiveItem() {
  if (!giveRequested) return null;
  if (!itemFindings || !itemWorth || !setItemFields || !mintCondition || !templateByIndex) {
    die('the game law is not importable here; --give cannot build an item');
  }
  if (giveGildedId) {
    const record = gildedById ? gildedById(giveGildedId) : null;
    if (!record) die(`--give-gilded ${giveGildedId} is not a Gilded record`);
    return mintGilded(record);
  }
  if (giveJsonPath) {
    let text;
    try { text = readFileSync(giveJsonPath, 'utf8'); } catch (e) { die(`cannot read --give-json: ${e.message}`); }
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { die(`--give-json is not JSON: ${e.message}`); }
    const item = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!item || typeof item !== 'object' || Array.isArray(item)) die('--give-json must hold one item object');
    if (!Number.isSafeInteger(item.templateIndex)) die('--give-json item has no templateIndex');
    return item;
  }
  const template = templateByIndex(giveIndex);
  if (!template) die(`--give ${giveIndex} is not a template index`);
  let groups = itemGroups ? itemGroups(giveIndex) : [];
  if (giveGroupArg) groups = [giveGroupArg];
  // the same two exclusions the catalogue makes: DFU's unvalued Deeds rows
  // collide with gems, and MiscItems 276 is the Unused slot of Gold_pieces.
  groups = groups.filter((g) => g !== 'Deeds' && !(g === 'MiscItems' && giveIndex === 276));
  if (!groups.length) die(`template ${giveIndex} has no item group; pass --give-group`);
  const group = groups[0];
  if (giveMaterialArg && group !== 'Weapons' && group !== 'Armor') {
    die(`--give-material is only for Weapons or Armor; ${group} ${giveIndex} carries no material`);
  }
  const material = giveMaterial(group);
  const base = { group, templateIndex: giveIndex };
  if (material != null) base.material = material;
  const item = mintCondition(setItemFields(base));
  if (group === 'Currency' && giveIndex === 276) { item.value = 1; item.stackCount = giveStackArg ?? 1; }
  if (dragonId) item.dragonId = dragonId;
  if (dragonLook === 1) item.dragonLook = 1;
  if (giveStackArg != null) {
    if (item.stackCount != null && group === 'Currency' && giveIndex === 276) { /* already set */ }
    else if (!isStackable?.(item)) die(`${item.name ?? giveIndex} does not stack; --give-stack is not lawful on it`);
    else {
      const max = 65_535;
      if (giveStackArg > max) die(`${item.name ?? giveIndex} stacks to ${max}; --give-stack ${giveStackArg} is past the law`);
      item.stackCount = giveStackArg;
    }
  }
  return item;
}

const giveItem = buildGiveItem();
if (giveItem?.provenance) die('--give-json carries a crafted provenance; use the crafted-arrival path, not --give');
const giveFindings = giveItem ? itemFindings(giveItem) : [];
const giveWorth = giveItem && itemWorth ? itemWorth(giveItem) : 0;
if (giveItem && giveFindings.length && !allowFlagged) {
  die(`the item law flags ${giveItem.name ?? 'the item'}: ${giveFindings.join(', ')}; pass --allow-flagged to send it anyway`);
}
if (giveItem && !craftsExplicit && giveWorth > crafts * STAFF_WORTH) {
  crafts = Math.min(30, Math.max(1, Math.ceil(giveWorth / STAFF_WORTH)));
}
if (bank + gold + giveWorth > crafts * STAFF_WORTH) {
  die(`--bank ${bank} + --gold ${gold} + item worth ${giveWorth} is more than the ${crafts * STAFF_WORTH} this run witnesses `
    + `(${crafts} staff${crafts === 1 ? '' : 's'} x ${STAFF_WORTH}). Raise --crafts or lower the amount.`);
}
if (giveItem?.templateIndex === DRAGON_MOUNT_TEMPLATE) {
  if (giveItem.dragonId != null && !DRAGON_ID_RE?.test(giveItem.dragonId)) {
    die(`--dragon-id ${giveItem.dragonId} is not a tame id (dg + 16 lower-case hex)`);
  }
  if (dragonMountWellFormed && !dragonMountWellFormed(giveItem)) {
    console.warn('warning: this Dwarven Dragon is not well formed; the service will find "dragon" and hold the checkpoint.');
  } else {
    console.warn('warning: the service checks a dragon id against its own tame rows; an id this account did not tame will be found "dragon-tame" and hold the checkpoint.');
  }
}

// ── requests ────────────────────────────────────────────────────────
async function request(method, path, { body, raw, headers = {}, auth = true } = {}) {
  if (auth && !token) throw new Error('no session token');
  const res = await fetch(base + path, {
    method,
    headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok) {
    const why = typeof parsed === 'string' ? parsed.slice(0, 500) : JSON.stringify(parsed).slice(0, 500);
    throw new Error(`${method} ${path} -> ${res.status}: ${why}`);
  }
  return parsed;
}

async function getSave(id) {
  const res = await fetch(`${base}/v1/realm/${encodeURIComponent(id)}/data`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET /v1/realm/${id}/data -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  let save;
  try { save = JSON.parse(text); } catch { die('the stored save is not JSON'); }
  if (!save || typeof save !== 'object' || Array.isArray(save)) die('the stored save is not one save object');
  return { save, seq: Number(res.headers.get('x-realm-seq')), bytes: Buffer.byteLength(text) };
}

const rid = (tag) => `${tag}-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
const bankTotalOf = (save) => (Array.isArray(save.bankAccounts) ? save.bankAccounts : [])
  .reduce((n, a) => n + (Number.isSafeInteger(a?.accountGold) ? a.accountGold : 0), 0);
const loansOf = (save) => (Array.isArray(save.bankAccounts) ? save.bankAccounts : [])
  .filter((a) => a && Number.isSafeInteger(a.loanTotal) && a.loanTotal > 0);
const owedOf = (save) => loansOf(save).reduce((n, a) => n + a.loanTotal, 0);

/** Fill every region with a blank account shape the game's save reader accepts, then add `amount` at `region`. */
function addBank(save, region, amount) {
  if (!Array.isArray(save.bankAccounts)) save.bankAccounts = [];
  while (save.bankAccounts.length < BANK_REGIONS) save.bankAccounts.push(null);
  for (let i = 0; i < BANK_REGIONS; i++) {
    const a = save.bankAccounts[i];
    save.bankAccounts[i] = a && typeof a === 'object'
      ? { ...a, regionIndex: i, accountGold: Number.isSafeInteger(a.accountGold) ? a.accountGold : 0, loanTotal: Number.isSafeInteger(a.loanTotal) ? a.loanTotal : 0, loanDueDate: Number.isSafeInteger(a.loanDueDate) ? a.loanDueDate : 0, hasDefaulted: a.hasDefaulted === true }
      : { regionIndex: i, accountGold: 0, loanTotal: 0, loanDueDate: 0, hasDefaulted: false };
  }
  const acct = save.bankAccounts[region];
  acct.accountGold += amount;
  return acct;
}

// ── sign in, if needed ──────────────────────────────────────────────
if (!token && handle && password) {
  const signed = await request('POST', '/v1/auth/login', { body: { handle, password, label: 'live-arrived-worth' }, auth: false });
  token = String(signed?.secret ?? '');
  if (!token) die('login did not answer a session secret');
  console.log(`signed in as ${signed.name ?? handle}`);
}

// ── the account's own characters ────────────────────────────────────
const realm = await request('GET', '/v1/realm');
const characters = Array.isArray(realm?.characters) ? realm.characters : [];
let ch;
if (characterArg) {
  ch = characters.find((c) => c.id === characterArg);
  if (!ch) die(`--character ${characterArg} is not one of this account's realm characters`);
} else {
  if (characters.length !== 1) die(`this account has ${characters.length} realm characters; pass --character <id>`);
  ch = characters[0];
}
const character = ch.id;

// ── the character's Stores, the counter, and the stored save ────────
const state = await request('POST', '/v1/prof/state', { body: { character } });
if (state?.error) die(`professions: ${state.error}`);
const marks = await request('POST', '/v1/marks/balance', { body: {} });
if (marks?.error) die(`Marks: ${marks.error}`);
const havePlanks = (Array.isArray(state.stores) ? state.stores : [])
  .filter((s) => s?.material === PLANK)
  .reduce((n, s) => n + (Number(s.own) || 0) + (Number(s.bought) || 0) + (Number(s.loose) || 0), 0);
const needPlanks = Math.max(0, 3 * crafts - havePlanks);
const cost = needPlanks * PLANK_MARKS;
const marksBalance = Number(marks.balance ?? 0);
if (needPlanks > STOCK_MAX) die(`this run needs ${needPlanks} ${PLANK}; the counter sells at most ${STOCK_MAX} at once`);
if (marksBalance < cost) die(`this run needs ${needPlanks} ${PLANK} (${cost} Marks); the account holds ${marksBalance}`);

const stored = await getSave(character);
const save = stored.save;
const bankNow = bankTotalOf(save);
const goldNow = Number.isSafeInteger(save.goldPieces) ? save.goldPieces : 0;
const owedNow = settleLoan ? owedOf(save) : 0;
if (settleLoan && owedNow > goldNow) {
  die(`--settle-loan must pay ${owedNow} from the purse, which holds ${goldNow}; no request was sent`);
}
if (!Array.isArray(save.items)) die('the stored save has no items list; refusing to guess at its shape');
if (save.items.some((it) => it && typeof it.provenance === 'string' && readProductRecord && readProductRecord(it.provenance))) {
  // not a refusal: a save can hold old crafted pieces. Just say what is there.
  console.log(`note: the stored save already holds ${save.items.filter((it) => it?.provenance).length} crafted piece(s); the new ones are separate`);
}

const giveName = giveItem ? (giveItem.name ?? `#${giveItem.templateIndex}`) : '';
const isDragon = giveItem?.templateIndex === DRAGON_MOUNT_TEMPLATE;
let dragonNotice = null;
if (isDragon) {
  if (!giveItem.dragonId) {
    dragonNotice = 'no dragonId: the service will find "dragon" and hold the checkpoint';
  } else {
    let tames = null;
    try {
      const t = await request('POST', '/v1/dragon/tames', { body: {} });
      tames = Array.isArray(t?.tames) ? t.tames : [];
    } catch { /* the service still checks */ }
    const tame = tames?.find((x) => x.id === giveItem.dragonId && x.character === character) ?? null;
    dragonNotice = tames == null
      ? `dragonId ${giveItem.dragonId}: could not read the tame rows; the service still checks`
      : tame
        ? `dragonId ${giveItem.dragonId} is a tame for ${character}`
        : `dragonId ${giveItem.dragonId} is not a tame for ${character}; the service will find "dragon-tame" and hold`;
  }
}

console.log('DFO live crafted-arrival worth exploit — own-account testing only');
console.log(`  base            ${base}`);
console.log(`  character       ${character} (${ch.name ?? '?'})  online=${ch.playing ? 'yes' : 'no'}  seq=${stored.seq}`);
console.log(`  save            ${stored.bytes} bytes, ${save.items.length} items`);
console.log(`  purse / bank    ${goldNow} / ${bankNow}`);
console.log(`  Marks           ${marksBalance}  (${havePlanks} ${PLANK} in Stores, ${needPlanks} to buy for ${cost})`);
console.log(`  crafts          ${crafts} x ${STAFF_RECIPE}  (witness ${STAFF_WORTH} each = ${crafts * STAFF_WORTH})`);
if (settleLoan) console.log(`  settle loan     ${owedNow} from the purse (normal debt; ${owedNow ? 'loan becomes 0' : 'nothing outstanding'})`);
const sendParts = [
  bank ? `bank +${bank} at region ${bankRegion}` : '',
  gold ? `purse +${gold}` : '',
  giveItem ? `give ${giveName}` : '',
].filter(Boolean);
console.log(`  send            ${sendParts.join(', ')}`);
if (giveItem) {
  const mat = giveItem.material != null ? ` material ${giveItem.material}` : '';
  const stack = giveItem.stackCount != null ? ` x${giveItem.stackCount}` : '';
  console.log(`  give item       ${giveName} (${giveItem.group} ${giveItem.templateIndex}${mat}${stack})`);
  console.log(`  give worth      ${giveWorth}  (covered by ${crafts} staff witness${crafts === 1 ? '' : 'es'} = ${crafts * STAFF_WORTH})`);
  if (giveFindings.length) console.log(`  give findings   ${giveFindings.join(', ')}  (--allow-flagged)`);
  if (dragonNotice) console.log(`  dragon check    ${dragonNotice}`);
}
console.log(`  mode            ${args.apply ? 'APPLY — requests will be sent' : 'dry run (pass --apply to send)'}`);

if (!args.apply) {
  console.log('\nDry run: would send');
  if (needPlanks > 0) console.log(`  POST ${base}/v1/prof/stock  { character, material: ${JSON.stringify(PLANK)}, qty: ${needPlanks}, rid }   (${cost} Marks)`);
  for (let i = 0; i < crafts; i++) console.log(`  POST ${base}/v1/prof/craft  { character, recipe: ${JSON.stringify(STAFF_RECIPE)}, rid }`);
  console.log(`  POST ${base}/v1/realm/join  { id: ${JSON.stringify(character)} }   (displaces the game tab's lease)`);
  console.log(`  PUT  ${base}/v1/realm/${character}/data  x-realm-seq: ${stored.seq + 1}  (+${crafts} staff piece${crafts === 1 ? '' : 's'})`);
  const changes = [
    bank ? `bank +${bank}` : '',
    gold ? `purse +${gold}` : '',
    settleLoan && owedNow ? `settle loan ${owedNow} from purse` : '',
    giveItem ? `+${giveName}` : '',
  ].filter(Boolean).join(', ');
  console.log(`  PUT  ${base}/v1/realm/${character}/data  x-realm-seq: ${stored.seq + 2}  (-staff${changes ? `, ${changes}` : ''})`);
  console.log(`  GET  ${base}/v1/realm/${character}/data`);
  if (giveItem && giveFindings.length) console.log('  note: the service may hold checkpoint 2; if it does, the script removes the item again.');
  console.log('\nNo request was sent. Re-run with --apply when ready.');
  process.exit(0);
}

// ── apply ───────────────────────────────────────────────────────────
try {
  if (needPlanks > 0) {
    const bought = await request('POST', '/v1/prof/stock', { body: { character, material: PLANK, qty: needPlanks, rid: rid('arr-buy') } });
    if (bought?.error) throw new Error(`stock: ${bought.error}`);
    console.log(`bought ${needPlanks} ${PLANK} for ${bought.marks ?? cost} Marks (balance ${bought.balance ?? '?'})`);
  }

  const pieces = [];
  for (let i = 0; i < crafts; i++) {
    const made = await request('POST', '/v1/prof/craft', { body: { character, recipe: STAFF_RECIPE, rid: rid('arr-craft') } });
    if (made?.error) throw new Error(`craft ${i + 1}/${crafts}: ${made.error}`);
    const piece = Array.isArray(made.pieces) ? made.pieces[0] : null;
    if (!piece?.provenance) throw new Error(`craft ${i + 1}/${crafts} answered no provenance`);
    const rec = readProductRecord ? readProductRecord(piece.record) : null;
    if (readProductRecord && (!rec || rec.r !== STAFF_RECIPE)) throw new Error(`craft ${i + 1}/${crafts}: the record is not ${STAFF_RECIPE}`);
    pieces.push({ provenance: piece.provenance, quality: rec?.q ?? -1, record: piece.record });
    console.log(`crafted ${piece.provenance}${rec ? ` (quality ${rec.q})` : ''}`);
  }

  const template = staffRecipe?.templateIndex ?? STAFF_TEMPLATE;
  const material = staffRecipe?.material ?? STAFF_MATERIAL;
  const staffs = pieces.map((p) => ({
    name: 'Pine Staff', group: 'Weapons', templateIndex: template, material,
    quality: p.quality, value: STAFF_WORTH, maxCondition: 1000, currentCondition: 1000,
    provenance: p.provenance, weightInKg: 4,
  }));
  for (const it of staffs) {
    if (itemFindings && itemFindings(it).length) die(`the item law would flag the staff (${itemFindings(it).join(', ')}); no request was sent past the craft`);
    if (itemWorth && itemWorth(it) !== STAFF_WORTH) die(`the item law values the staff at ${itemWorth(it)}, not ${STAFF_WORTH}; no request was sent past the craft`);
  }

  const joined = await request('POST', '/v1/realm/join', { body: { id: character } });
  if (joined?.error) throw new Error(`join: ${joined.error}`);
  if (joined?.id !== character) throw new Error(`join answered ${joined?.id ?? 'no id'}, not ${character}`);
  const lease = String(joined.lease ?? '');
  if (!lease) throw new Error('join answered no lease');
  console.log(`joined ${character} at seq ${joined.seq}`);

  const live = await getSave(character);
  if (live.seq !== Number(joined.seq)) throw new Error(`the record moved from join's ${joined.seq} to ${live.seq}; re-run`);
  const bankAtJoin = bankTotalOf(live.save);
  const goldAtJoin = Number.isSafeInteger(live.save.goldPieces) ? live.save.goldPieces : 0;
  const settleNow = settleLoan ? owedOf(live.save) : 0;
  if (settleNow > goldAtJoin) throw new Error(`--settle-loan must pay ${settleNow} from the purse, which holds ${goldAtJoin}; no request was sent past the join`);
  if (settleLoan && settleNow !== owedNow) console.log(`note: the loan at join is ${settleNow}, not the ${owedNow} the first read showed; settling ${settleNow}`);
  if (live.save.items.some((it) => pieces.some((p) => p.provenance === it?.provenance))) {
    throw new Error('the record already holds a provenance this run just made; refusing');
  }
  // The pre-run record, kept for a cleanup checkpoint if the service holds
  // the item's arrival. It has no staffs and no given item.
  const baseSave = JSON.parse(JSON.stringify(live.save));
  live.save.items.push(...staffs);

  const put = (body, seq) => request('PUT', `/v1/realm/${encodeURIComponent(character)}/data`, {
    raw: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-realm-lease': lease, 'x-realm-seq': String(seq) },
  });
  const cleanup = async (seq, label) => {
    if (!giveItem) return null;
    try {
      const clean = await put(baseSave, seq);
      if (!clean?.ok) {
        console.error(`cleanup ${label}: refused (${JSON.stringify(clean)})`);
        return null;
      }
      console.log(`cleanup ${label}: seq ${clean.seq}, tradeHeld ${clean.tradeHeld ?? 'none'}`);
      return clean;
    } catch (e) {
      console.error(`cleanup ${label}: failed (${e.message})`);
      return null;
    }
  };

  const one = await put(live.save, live.seq + 1);
  if (!one?.ok) throw new Error(`first checkpoint refused: ${JSON.stringify(one)}`);
  console.log(`checkpoint 1: seq ${one.seq}, tradeHeld ${one.tradeHeld ?? 'none'}${one.tradeHeldWhy ? ` (${JSON.stringify(one.tradeHeldWhy)})` : ''}`);
  if (one.tradeHeld) {
    const clean = await cleanup(one.seq + 1, 'checkpoint 1');
    throw new Error(`the first checkpoint is held (${one.tradeHeld}); ${clean ? 'the staffs were removed again and the save restored' : 'no cleanup was sent'}`);
  }

  const finalSave = live.save;
  const ours = new Set(pieces.map((p) => p.provenance));
  finalSave.items = finalSave.items.filter((it) => !ours.has(it?.provenance));
  if (settleNow > 0) {
    const loans = loansOf(finalSave);
    const owedFinal = loans.reduce((n, a) => n + a.loanTotal, 0);
    if (owedFinal !== settleNow) throw new Error(`the loan at the second checkpoint is ${owedFinal}, not the ${settleNow} the join showed; refusing`);
    const purse = Number.isSafeInteger(finalSave.goldPieces) ? finalSave.goldPieces : 0;
    if (purse < settleNow) throw new Error(`the purse holds ${purse}, less than the ${settleNow} loan; refusing`);
    finalSave.goldPieces = purse - settleNow;
    for (const a of loans) { a.loanTotal = 0; a.loanDueDate = 0; }
    console.log(`settled ${settleNow} from the purse (loan now 0; the default mark stays as the game leaves it)`);
  }
  const acct = addBank(finalSave, bankRegion, bank);
  if (gold > 0) {
    const purse = Number.isSafeInteger(finalSave.goldPieces) ? finalSave.goldPieces : 0;
    if (purse + gold > GOLD_INT_MAX) die(`purse ${purse} + ${gold} passes DFU's int; lower --gold`);
    finalSave.goldPieces = purse + gold;
  }
  if (giveItem) {
    finalSave.items.push(giveItem);
    console.log(`adding ${giveName} (${giveItem.group} ${giveItem.templateIndex}${giveItem.gilded ? `, gilded ${giveItem.gilded}` : ''}${giveItem.dragonId ? `, ${giveItem.dragonId}` : ''})`);
  }

  const two = await put(finalSave, live.seq + 2);
  if (!two?.ok) throw new Error(`second checkpoint refused: ${JSON.stringify(two)}`);
  console.log(`checkpoint 2: seq ${two.seq}, tradeHeld ${two.tradeHeld ?? 'none'}${two.tradeHeldWhy ? ` (${JSON.stringify(two.tradeHeldWhy)})` : ''}`);
  if (two.tradeHeld) {
    const clean = await cleanup(two.seq + 1, 'checkpoint 2');
    const why = two.tradeHeldWhy ? ` ${JSON.stringify(two.tradeHeldWhy)}` : '';
    throw new Error(`the second checkpoint is held (${two.tradeHeld})${why}; `
      + (giveItem
        ? (clean ? `${giveName} was removed again and the pre-run save restored` : `the cleanup checkpoint was refused; ${giveName} may remain`)
        : 'no cleanup was attempted'));
  }

  const got = await getSave(character);
  const finalBank = bankTotalOf(got.save);
  const finalGold = Number.isSafeInteger(got.save.goldPieces) ? got.save.goldPieces : 0;
  console.log('\nstored record');
  console.log(`  seq             ${got.seq}`);
  console.log(`  purse           ${finalGold}  (was ${goldAtJoin}${settleNow ? `; -${settleNow} loan` : ''}${gold ? `; +${gold}` : ''})`);
  console.log(`  bank total      ${finalBank}  (was ${bankAtJoin}; +${finalBank - bankAtJoin})`);
  console.log(`  bank[${bankRegion}]      ${JSON.stringify(got.save.bankAccounts?.[bankRegion] ?? null)}`);
  console.log(`  items           ${Array.isArray(got.save.items) ? got.save.items.length : 0}`);
  if (giveItem) {
    const present = (got.save.items ?? []).some((it) => it?.templateIndex === giveItem.templateIndex
      && (giveItem.gilded == null || it?.gilded === giveItem.gilded)
      && (giveItem.dragonId == null || it?.dragonId === giveItem.dragonId)
      && (giveItem.stackCount == null || it?.stackCount === giveItem.stackCount));
    if (!present) throw new Error(`the stored record does not hold the given ${giveName}`);
    console.log(`  gave            ${giveName} (${giveItem.templateIndex})`);
  }
  if (settleNow > 0) console.log(`  loan settled    ${settleNow} from the purse at normal cost`);
  if (finalBank - bankAtJoin !== bank || finalGold !== goldAtJoin - settleNow + gold) {
    throw new Error('the stored record does not show the amount this run sent');
  }
  const moved = [bank ? `bank +${bank}` : '', gold ? `purse +${gold}` : '', giveItem ? `gave ${giveName}` : ''].filter(Boolean).join(', ');
  console.log(`\nPASS: ${moved} with no budget step.`);
  console.log('The game tab\'s lease was displaced. Rejoin the character in game to load this save.');
  if (bank) console.log(`The bank gold is in region ${bankRegion}'s account (${bankRegion === EMPIRE_REGION ? 'Daggerfall, the Empire\'s online account' : 'region ' + bankRegion}).`);
  if (gold) console.log('The purse gold is carried by the character; an overdue loan settles from the bank, not the purse.');
  if (giveItem) console.log(`The ${giveName} is in the save; its ${giveWorth} worth was covered by the same staff witness.`);
  if (settleNow) console.log(`The ${settleNow} loan payment was ordinary debt repayment; ${bank ? `the bank +${bank} is the witnessed arrival.` : 'the give item is the witnessed arrival.'}`);
} catch (e) {
  die(e?.message ?? String(e), 1);
}
