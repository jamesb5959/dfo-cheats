#!/usr/bin/env node
// DFO player things — READ ONLY. Titles, glyphs, auras, profile icons,
// Aura Armory pieces, cosmetic effects, and the account's currencies.
//
// These are ACCOUNT rows, not character-save fields. The save exploit
// (live-arrived-worth.mjs --give) writes character items only; it cannot
// grant a title, a glyph, an effect, silver/Marks, Aurum or Sigil Stones.
// The account service decides what is held, and the relay reads the
// wardrobe off a signed identity token.
//
// List everything for the signed-in account:
//   node player-catalog.mjs
//
// Search and filter (all words must match):
//   node player-catalog.mjs hour
//   node player-catalog.mjs --kind title --held
//   node player-catalog.mjs --kind effect --shop
//   node player-catalog.mjs --worn
//
// Machine-readable:
//   node player-catalog.mjs --json
//
// Vocabularies only, no account read:
//   node player-catalog.mjs --no-account

import { configValue } from './config.mjs';
import { TITLES, GLYPHS, AURAS, ICONS } from '../daggerfall-js-source/src/net/identityToken.js';
import { EFFECTS, EFFECT_SLOTS, effectKitKeys } from '../daggerfall-js-source/src/net/effectLaw.js';
import { ARMORY_PIECES, ARMORY_NAME, armoryKitPieces } from '../daggerfall-js-source/src/net/armoryLaw.js';
import { SHOP_WARE_NAME, shopWareById } from '../daggerfall-js-source/src/net/shopLaw.js';
import { TITLE_TEXT, AURA_TEXT } from '../daggerfall-js-source/src/ui/playerBadge.js';
import { GLYPH_LABEL } from '../daggerfall-js-source/src/ui/enhanced/enhancedAccount.js';
import { ICON_TEXT } from '../daggerfall-js-source/src/ui/profileIcons.js';

const DEFAULT_BASE = 'https://daggerfall-accounts.mackcothran.workers.dev';

const HELP = `DFO player things — read only, no writes

Usage:
  node player-catalog.mjs [search words...] [options]

The account read is GET /v1/account plus the character's stored save
(for gold and the bank). Nothing is written.

Options:
  --kind <kind>        title, glyph, aura, icon, effect, or armory
  --held               only things the account holds or wears
  --worn               only things worn now
  --shop               only things with an Aurum price
  --limit <n>          stop after n rows
  --json               print the account summary and rows as JSON
  --no-account         vocabularies only; do not read the account
  --character <id>     character for the gold/bank read
  --base <url>         default: ${DEFAULT_BASE}
  --token <token>      session bearer (or DFO_TOKEN / .config)
  --help               this text

Notes:
  • Titles, glyphs, auras, icons, armory and effects are held on the
    ACCOUNT and signed into the relay token. They are not in the character
    save, so the save exploit cannot grant them.
  • Silver is the account's Marks balance. Aurum is the cosmetic currency.
    Sigil Stones are the Broker's purse. All three are account rows.
  • Gold is the character's purse and bank, the one currency the save
    exploit writes.
  • The shop's Aurum wares are listed with their price. The daily deals
    are the account read's own five.
`;

const die = (why, code = 2) => { console.error(`\nrefused: ${why}\n`); process.exit(code); };

function parseArgs(argv) {
  const out = { words: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--held') out.held = true;
    else if (a === '--worn') out.worn = true;
    else if (a === '--shop') out.shop = true;
    else if (a === '--no-account') out['no-account'] = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      if (argv[i + 1] == null || argv[i + 1].startsWith('--')) die(`--${key} needs a value`);
      out[key] = argv[++i];
    } else out.words.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(HELP); process.exit(0); }

const base = String(args.base ?? process.env.DFO_BASE_URL ?? configValue('DFO_BASE_URL') ?? DEFAULT_BASE).replace(/\/+$/, '') || DEFAULT_BASE;
const token = String(args.token ?? process.env.DFO_TOKEN ?? configValue('DFO_TOKEN') ?? '').trim();
if (!/^https?:\/\//i.test(base)) die('--base (or DFO_BASE_URL) must be an http(s) URL');

async function request(method, path, body) {
  if (!token) throw new Error('no session token');
  const res = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok) {
    const why = typeof parsed === 'string' ? parsed.slice(0, 300) : JSON.stringify(parsed).slice(0, 300);
    throw new Error(`${method} ${path} -> ${res.status}: ${why}`);
  }
  return parsed;
}

// ── the account's wardrobe and balances ─────────────────────────────
let account = null;
let wardrobe = {};
let aurum = null;
let character = null;
let save = null;
let silver = null;
let renown = null;

if (token && !args['no-account']) {
  try {
    const read = await request('GET', '/v1/account');
    account = read.account ?? null;
    wardrobe = read.wardrobe ?? {};
    aurum = read.aurum ?? null;
    silver = Number.isSafeInteger(account?.marks) ? account.marks : null;
    if (silver == null) {
      try { silver = Number((await request('POST', '/v1/marks/balance', {})).balance); } catch { /* no Marks */ }
    }
    if (account?.renown && Array.isArray(account.renown)) {
      const wanted = String(args.character ?? '');
      renown = account.renown.find((r) => r.character === wanted) ?? account.renown[0] ?? null;
    }
    const realm = await request('GET', '/v1/realm');
    const chars = Array.isArray(realm?.characters) ? realm.characters : [];
    if (args.character) {
      character = chars.find((c) => c.id === args.character) ?? null;
      if (!character) console.warn(`note: --character ${args.character} is not one of this account's characters`);
    } else {
      character = chars.find((c) => c.playing) ?? chars[0] ?? null;
    }
    if (character) {
      save = await request('GET', `/v1/realm/${encodeURIComponent(character.id)}/data`);
      if (renown == null && account?.renown) renown = account.renown.find((r) => r.character === character.id) ?? null;
    }
  } catch (e) {
    console.warn(`note: account read failed (${e.message}); showing vocabularies only`);
    account = null;
    wardrobe = {};
    aurum = null;
    save = null;
    silver = null;
  }
}

const heldTitles = new Set(Array.isArray(wardrobe.titles) ? wardrobe.titles : []);
const trueGlyphs = new Set(Array.isArray(wardrobe.glyphs) ? wardrobe.glyphs : []);
const hiddenGlyphs = new Set(Array.isArray(wardrobe.glyphsOff) ? wardrobe.glyphsOff : []);
const heldAuras = new Set(Array.isArray(wardrobe.auras) ? wardrobe.auras : []);
const heldIcons = new Set(Array.isArray(wardrobe.icons) ? wardrobe.icons : []);
const heldArmory = new Set(Array.isArray(wardrobe.armoryHeld) ? wardrobe.armoryHeld : []);
const heldEffects = wardrobe.effectsHeld && typeof wardrobe.effectsHeld === 'object' ? wardrobe.effectsHeld : {};
const wornArmory = armoryKitPieces(wardrobe.armory);
const wornEffects = effectKitKeys(wardrobe.effects);

// ── the catalogue rows ───────────────────────────────────────────────
const rows = [];

const shopOf = (id) => shopWareById(id);
const priceOf = (id) => {
  const w = shopOf(id);
  return w && Number.isFinite(w.price) ? w.price : null;
};

for (const key of TITLES) {
  const id = `title:${key}`;
  const w = shopOf(id);
  rows.push({
    kind: 'title', id, key,
    name: TITLE_TEXT[key] ?? SHOP_WARE_NAME[id] ?? key,
    held: heldTitles.has(key),
    worn: wardrobe.title === key,
    price: priceOf(id),
    source: w ? 'shop' : (['founder', 'developer', 'dungeonmaster', 'shadowfang', 'penitent'].includes(key) ? 'staff/granted' : 'earned/granted'),
  });
}

for (const key of GLYPHS) {
  const id = `glyph:${key}`;
  const w = shopOf(id);
  const held = trueGlyphs.has(key);
  rows.push({
    kind: 'glyph', id, key,
    name: GLYPH_LABEL[key] ?? SHOP_WARE_NAME[id] ?? key,
    held,
    worn: held && !hiddenGlyphs.has(key),
    off: held && hiddenGlyphs.has(key),
    price: priceOf(id),
    source: w ? 'shop' : (['dev', 'mod', 'dm'].includes(key) ? 'staff' : 'earned/granted'),
  });
}

for (const key of AURAS) {
  const id = `aura:${key}`;
  const w = shopOf(id);
  rows.push({
    kind: 'aura', id, key,
    name: AURA_TEXT[key] ?? SHOP_WARE_NAME[id] ?? key,
    held: heldAuras.has(key),
    worn: wardrobe.aura === key,
    price: priceOf(id),
    source: w ? 'shop' : 'earned/granted',
  });
}

for (const key of ICONS) {
  const id = `icon:${key}`;
  const w = shopOf(id);
  rows.push({
    kind: 'icon', id, key,
    name: ICON_TEXT[key] ?? SHOP_WARE_NAME[id] ?? key,
    held: heldIcons.has(key),
    worn: wardrobe.icon === key,
    price: priceOf(id),
    source: w ? 'shop' : (key === 'soulcake' ? 'event' : key === 'guildcrest' ? 'guild' : 'pass'),
  });
}

for (const e of EFFECTS) {
  const id = `${e.slot}:${e.key}`;
  const w = shopOf(id);
  rows.push({
    kind: e.slot, id, key: e.key, slot: e.slot,
    name: e.name,
    held: Array.isArray(heldEffects[e.slot]) && heldEffects[e.slot].includes(e.key),
    worn: wornEffects[e.slot] === e.key,
    price: priceOf(id),
    source: w ? 'shop' : 'pass/earned',
  });
}

for (const p of ARMORY_PIECES) {
  const id = `armory:${p.key}`;
  rows.push({
    kind: 'armory', id, key: p.key, slot: p.slot,
    name: ARMORY_NAME[p.key] ?? p.key,
    held: heldArmory.has(p.key),
    worn: wornArmory[p.slot] === p.key,
    price: priceOf(id),
    source: p.source,
  });
}

// ── search and filters ───────────────────────────────────────────────
const terms = `${(args.words ?? []).join(' ')} ${args.search ?? ''}`.trim().toLowerCase().split(/\s+/).filter(Boolean);
const kindFilter = String(args.kind ?? '').trim().toLowerCase();
const limit = args.limit != null ? Number(args.limit) : null;
if (limit != null && (!Number.isSafeInteger(limit) || limit < 1)) die('--limit must be a whole number >= 1');

const stateOf = (row) => row.worn ? 'worn' : row.off ? 'off' : row.held ? 'held' : '-';

const matches = (row) => {
  if (args.held && !row.held && !row.worn) return false;
  if (args.worn && !row.worn) return false;
  if (args.shop && row.price == null) return false;
  if (kindFilter) {
    const isEffect = row.kind === 'kill' || row.kind === 'portal' || row.kind === 'mount';
    if (kindFilter === 'effect' || kindFilter === 'effects') { if (!isEffect) return false; }
    else if (row.kind !== kindFilter) return false;
  }
  if (terms.length) {
    const hay = `${row.kind} ${row.id} ${row.key} ${row.name} ${row.source}`.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) return false;
  }
  return true;
};

let found = rows.filter(matches);
if (limit != null && found.length > limit) found = found.slice(0, limit);

// ── account summary ──────────────────────────────────────────────────
const bankTotal = save && Array.isArray(save.bankAccounts)
  ? save.bankAccounts.reduce((n, a) => n + (Number.isSafeInteger(a?.accountGold) ? a.accountGold : 0), 0)
  : null;
const goldPieces = save && Number.isSafeInteger(save.goldPieces) ? save.goldPieces : null;
const carryKg = save ? (() => {
  const base = Number(save.stats?.strength ?? 0);
  let mod = 0, maxMod = 0;
  for (const a of Array.isArray(save.activeEffects) ? save.activeEffects : []) {
    if (!a || a.ended) continue;
    if (a.statMaxMods) maxMod += Number(a.statMaxMods.strength ?? 0) || 0;
    if (a.kind === 'fortifyAttribute' && a.stat === 'strength') mod += Number(a.magnitude ?? 0) || 0;
  }
  return Math.floor(Math.min(Math.max(base + mod, 0), 100 + maxMod) * 1.5);
})() : null;
const shownGlyphs = [...trueGlyphs].filter((g) => !hiddenGlyphs.has(g));
const wornArmoryNames = Object.entries(wornArmory).filter(([, k]) => k).map(([, k]) => ARMORY_NAME[k] ?? k);
const wornEffectNames = EFFECT_SLOTS
  .map((slot) => EFFECTS.find((e) => e.slot === slot && e.key === wornEffects[slot]))
  .filter(Boolean)
  .map((e) => e.name);

const summary = {
  account: account ? {
    name: account.name ?? null,
    handle: account.handle ?? null,
    kind: account.kind ?? null,
    silver,
    aurum: aurum?.balance ?? null,
    sigilStones: Number.isSafeInteger(wardrobe.purse) ? wardrobe.purse : null,
    gold: goldPieces,
    bank: bankTotal,
    carry: carryKg,
    character: character ? { id: character.id, name: character.name ?? null } : null,
    renown: renown ? { character: renown.character, level: renown.level ?? null, xp: renown.xp ?? null } : null,
    dragons: account.dragons ?? null,
    aurumDaily: aurum?.daily?.wares ?? [],
    worn: {
      title: wardrobe.title ?? null,
      glyphs: shownGlyphs,
      aura: wardrobe.aura ?? null,
      icon: wardrobe.icon ?? null,
      armory: wornArmory,
      effects: wornEffects,
    },
  } : null,
  rows: found.map((row) => ({ ...row, state: stateOf(row) })),
};

if (args.json) {
  const json = JSON.stringify(summary, null, 2);
  // A large JSON write must finish before exit: process.exit() can truncate a
  // pipe at 64 KiB. Wait for the write's callback, then exit.
  process.stdout.write(json + '\n', () => process.exit(0));
  await new Promise(() => {});
}

console.log('DFO player things — READ ONLY');
if (account) {
  console.log(`  account         ${account.name ?? '?'}${account.handle ? ` (${account.handle})` : ''}  ${account.kind ?? ''}`);
  console.log(`  silver (Marks)  ${silver ?? '?'}`);
  console.log(`  Aurum           ${aurum?.balance ?? '?'}`);
  console.log(`  Sigil Stones    ${Number.isSafeInteger(wardrobe.purse) ? wardrobe.purse : '?'}`);
  if (save) console.log(`  gold            ${goldPieces ?? '?'} purse / ${bankTotal ?? '?'} bank  (${character.name ?? character.id})`);
  if (save) console.log(`  carry           ${carryKg ?? '?'} kg  (strength ${save.stats?.strength ?? '?'})`);
  if (renown) console.log(`  renown          level ${renown.level ?? '?'} (${renown.xp ?? '?'} xp)`);
  if (account.dragons) console.log(`  dragons         ${account.dragons.slain ?? 0} slain / ${account.dragons.tamed ?? 0} tamed`);
  console.log(`  worn            title ${wardrobe.title ? (TITLE_TEXT[wardrobe.title] ?? wardrobe.title) : 'none'}; `
    + `glyphs ${shownGlyphs.length ? shownGlyphs.map((g) => GLYPH_LABEL[g] ?? g).join(', ') : 'none'}; `
    + `aura ${wardrobe.aura ? (AURA_TEXT[wardrobe.aura] ?? wardrobe.aura) : 'none'}`);
  console.log(`                  icon ${wardrobe.icon ? (ICON_TEXT[wardrobe.icon] ?? wardrobe.icon) : 'face (none)'}; `
    + `armory ${wornArmoryNames.length ? wornArmoryNames.join(', ') : 'none'}; `
    + `effects ${wornEffectNames.length ? wornEffectNames.join(', ') : 'none'}`);
} else {
  console.log('  account         not read (no token or --no-account)');
}

const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const num = (n) => Number(n).toLocaleString('en-US');
const cols = [
  { title: 'KIND', width: 8 },
  { title: 'ID', width: 26 },
  { title: 'NAME', width: 30 },
  { title: 'STATE', width: 6 },
  { title: 'AURUM', width: 7, right: true },
  { title: 'SOURCE', width: 15 },
];
const line = (cells) => cells.map((c, i) => {
  const text = trunc(String(c), cols[i].width);
  return cols[i].right ? text.padStart(cols[i].width) : text.padEnd(cols[i].width);
}).join('  ').trimEnd();

console.log('');
console.log(line(cols.map((c) => c.title)));
console.log(cols.map((c) => '-'.repeat(c.width)).join('  '));
for (const row of found) {
  console.log(line([
    row.kind,
    row.id,
    row.name,
    stateOf(row),
    row.price == null ? '-' : num(row.price),
    row.source,
  ]));
}

console.log(`\n${found.length} row${found.length === 1 ? '' : 's'} (${rows.length} in the catalogue).`);
console.log('Silver/Marks, Aurum and Sigil Stones are account balances; the character save carries gold, not these.');
console.log('Titles, glyphs, auras, icons, armory and effects are account rows signed into the relay token.');
console.log('The save exploit (live-arrived-worth.mjs --give) writes character items only; it cannot grant these.');
