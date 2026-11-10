#!/usr/bin/env node
// Make the two maxed items on the account's own character, in ONE checkpoint:
//
//   • Daedric Dwarven Thunderlock — nine CastWhenStrikes rows, each Gods' Fire
//     (spell 32); material 9 (Daedric); 12,800 condition.
//   • The Dragonfire Oath — the Gilded Daedric Dai-Katana record, minted exactly
//     as its record is (affixes +40 damage, +15 Strength, +30 Long Blade,
//     +15 Endurance; the Dragonfire power). It is already the record's top band;
//     the item law does not allow a Gilded piece to carry extra rows.
//   • 65,535 Dwemer Pellets, so the gun fires.
//
// It writes the item JSON under /tmp/opencode/ and calls live-player-edit.mjs
// with repeated --append-item. That path does not buy planks or craft a staff:
// the checkpoint takes the item directly. The staff is only the crafted-arrival
// witness's funding device; it is not an item-law requirement. The checkpoint's
// wealth measure still sees the item's worth, so with budget.enforce off it
// passes as a measure finding and with it on it would hold.
//
// Dry run:
//   node make-max-items.mjs
//
// Send (joins the realm and displaces the game tab):
//   node make-max-items.mjs --apply
//
// Options:
//   --apply            send the checkpoint
//   --no-pellets       skip the pellet stack
//   --gun-only         only the Thunderlock (and pellets)
//   --oath-only        only the Dragonfire Oath
//   --custom-oath      use a plain Daedric Dai-Katana with nine Gods' Fire rows
//                      instead of the Gilded Dragonfire Oath (more offence, no
//                      Gilded affixes or Dragonfire power)
//   --max-gear         also append the Ring of the Eight (nine CastWhenHeld
//                      rows) and the plain maxed Dai-Katana
//   --force            append even when the account already holds the item
//   --allow-flagged    pass --allow-flagged to the editor
//   --help             this text
//
// Private. Own-account only. Do not publish.

import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configValue } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = '/tmp/opencode';
const EDITOR = join(HERE, 'live-player-edit.mjs');
const BASE = String(process.env.DFO_BASE_URL ?? configValue('DFO_BASE_URL') ?? 'https://daggerfall-accounts.mackcothran.workers.dev').replace(/\/+$/, '');
const TOKEN = String(process.env.DFO_TOKEN ?? configValue('DFO_TOKEN') ?? '').trim();

const HELP = `make-max-items.mjs — the maxed Thunderlock and Dragonfire Oath

  node make-max-items.mjs                 dry run; writes the item JSON
  node make-max-items.mjs --apply         append both in one checkpoint
  node make-max-items.mjs --custom-oath   plain maxed Dai-Katana instead of the Gilded Oath
  node make-max-items.mjs --gun-only      only the Thunderlock (and pellets)
  node make-max-items.mjs --oath-only     only the Dragonfire Oath
  node make-max-items.mjs --no-pellets    skip the 65,535 pellets
  node make-max-items.mjs --max-gear      also the Ring of the Eight and max Katana
  node make-max-items.mjs --force         append even if already held

The gun and pellets are appended with live-player-edit.mjs --append-item: no
staff, no planks, no Marks. The Dragonfire Oath is the exact Gilded record; the
law fixes its affixes and forbids extra rows on a Gilded piece. Its top-band
affixes and the Dragonfire power are already the maximum the record allows.
`;

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.has('-h')) { console.log(HELP); process.exit(0); }
for (const a of args) if (!['--apply', '--no-pellets', '--gun-only', '--oath-only', '--custom-oath', '--max-gear', '--force', '--allow-flagged'].includes(a)) {
  console.error(`\nrefused: unknown argument ${a}\n`);
  process.exit(2);
}
if (args.has('--gun-only') && args.has('--oath-only')) {
  console.error('\nrefused: --gun-only and --oath-only together leave nothing to make\n');
  process.exit(2);
}

// ── the law, for the preview ─────────────────────────────────────────
let itemFindings = null, itemWorth = null, mintGilded = null, DRAGONFIRE_OATH = null;
try {
  const law = await import(new URL('../daggerfall-js-source/src/systems/item/itemLaw.js', import.meta.url));
  itemFindings = law.itemFindings;
  itemWorth = law.itemWorth;
  const gilded = await import(new URL('../daggerfall-js-source/src/systems/gilded.js', import.meta.url));
  mintGilded = gilded.mintGilded;
  DRAGONFIRE_OATH = gilded.DRAGONFIRE_OATH;
} catch (e) {
  console.error(`\nrefused: the game law is not importable here: ${e.message}\n`);
  process.exit(2);
}

const noneRow = {
  type: -1, param: -1,
  durationBase: 0, durationMod: 0, durationPerLevel: 0,
  chanceBase: 0, chanceMod: 0, chancePerLevel: 0,
  magnitudeBaseLow: 0, magnitudeBaseHigh: 0,
  magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 0,
};
const godsFireRow = () => ({
  type: 2,                       // CastWhenStrikes
  param: 32,                     // Gods' Fire (SPELLS.STD)
  durationBase: 999, durationMod: 0, durationPerLevel: 0,
  chanceBase: 100, chanceMod: 0, chancePerLevel: 0,
  magnitudeBaseLow: 999, magnitudeBaseHigh: 999,
  magnitudeLevelBase: 1, magnitudeLevelHigh: 1, magnitudePerLevel: 0,
});
const heldRow = (param) => ({
  type: 1,                       // CastWhenHeld
  param,                         // a self-range beneficial spell
  durationBase: 999, durationMod: 0, durationPerLevel: 0,
  chanceBase: 100, chanceMod: 0, chancePerLevel: 0,
  magnitudeBaseLow: 999, magnitudeBaseHigh: 999,
  magnitudeLevelBase: 1, magnitudeLevelHigh: 1, magnitudePerLevel: 0,
});

/** A Daedric Thunderlock (560) with nine Gods' Fire rows. */
function maxThunderlock() {
  return {
    group: 'Weapons',
    templateIndex: 560,
    material: 9,                 // Daedric
    name: 'Daedric Dwarven Thunderlock',
    maxCondition: 12800,
    currentCondition: 12800,
    value: 0,
    enchantments: Array.from({ length: 9 }, godsFireRow).concat([noneRow]),
  };
}

/** A plain Daedric Dai-Katana (123) with nine Gods' Fire rows. Not Gilded. */
function maxDaiKatana() {
  return {
    group: 'Weapons',
    templateIndex: 123,          // Dai-Katana
    material: 9,                 // Daedric
    name: 'Dragonfire Oath (maxed)',
    maxCondition: 12800,
    currentCondition: 12800,
    value: 0,
    enchantments: Array.from({ length: 9 }, godsFireRow).concat([noneRow]),
  };
}

/** A ring with nine CastWhenHeld rows: the eight attributes and Shield. */
function maxRing() {
  return {
    group: 'Jewellery',
    templateIndex: 135,          // Ring
    name: 'Ring of the Eight',
    maxCondition: 1000000,
    currentCondition: 1000000,
    value: 0,
    enchantments: [82, 83, 84, 85, 86, 87, 88, 89, 17].map(heldRow).concat([noneRow]),
  };
}

/** The exact Gilded Dragonfire Oath record. It is already the top band. */
function dragonfireOath() {
  return mintGilded(DRAGONFIRE_OATH);
}

function pellets() {
  return {
    group: 'Weapons',
    templateIndex: 561,
    name: 'Dwemer Pellet',
    value: 0,
    maxCondition: 1,
    currentCondition: 1,
    stackCount: 65535,
  };
}

const wantGun = !args.has('--oath-only');
const wantOath = !args.has('--gun-only');
const wantPellets = wantGun && !args.has('--no-pellets');

async function heldItems() {
  if (!TOKEN) return [];
  try {
    const headers = { authorization: `Bearer ${TOKEN}` };
    const realm = await (await fetch(`${BASE}/v1/realm`, { headers })).json();
    const ch = (Array.isArray(realm.characters) ? realm.characters : [])[0];
    if (!ch) return [];
    const save = await (await fetch(`${BASE}/v1/realm/${encodeURIComponent(ch.id)}/data`, { headers })).json();
    return Array.isArray(save.items) ? save.items : [];
  } catch {
    return [];
  }
}

const held = args.has('--force') ? [] : await heldItems();
const signature = (item) => JSON.stringify({
  t: item.templateIndex,
  m: item.material ?? null,
  g: item.gilded ?? null,
  e: (Array.isArray(item.enchantments) ? item.enchantments : []).map((e) => [e.type, e.param]),
});
const alreadyHeld = (item) => {
  if (item.templateIndex === 561) return held.some((i) => i.templateIndex === 561);
  const sig = signature(item);
  return held.some((i) => signature(i) === sig);
};

const items = [];
if (wantGun) items.push(['Thunderlock', 'dfc-max-thunderlock.json', maxThunderlock()]);
if (wantOath) {
  if (args.has('--custom-oath') && !args.has('--max-gear')) items.push(['Dai-Katana (custom max)', 'dfc-max-dai-katana.json', maxDaiKatana()]);
  else items.push(['Dragonfire Oath (Gilded)', 'dfc-max-dragonfire-oath.json', dragonfireOath()]);
}
if (args.has('--max-gear')) {
  items.push(['Ring of the Eight', 'dfc-max-ring.json', maxRing()]);
  items.push(['Dai-Katana (max)', 'dfc-max-dai-katana.json', maxDaiKatana()]);
}
if (wantPellets) items.push(['Dwemer Pellets', 'dfc-max-pellets.json', pellets()]);

mkdirSync(OUT, { recursive: true });
let flagged = 0;
const toSend = [];
console.log('DFO max items — own-account testing only');
console.log(`  output          ${OUT}`);
console.log('  path            live-player-edit.mjs --append-item (one checkpoint, no staff)');
console.log('');
for (const [label, file, item] of items) {
  const path = join(OUT, file);
  writeFileSync(path, JSON.stringify(item, null, 2));
  const findings = itemFindings ? itemFindings(item) : [];
  if (findings.length) flagged++;
  const skip = alreadyHeld(item);
  if (!skip) toSend.push([label, file, item]);
  const state = skip ? 'already held — skip' : findings.length ? `FLAGGED: ${findings.join(', ')}` : 'lawful';
  console.log(`  ${label.padEnd(26)} ${String(item.templateIndex).padStart(4)}  worth ${String(itemWorth ? itemWorth(item) : '?').padStart(9)}  ${state}`);
  console.log(`    ${path}`);
  if (item.affixes) console.log(`    affixes        ${item.affixes.map((a) => `${a.id}${a.param != null ? `:${a.param}` : ''}=${a.value}`).join(', ')}`);
  if (item.gilded) console.log(`    gilded         ${item.gilded}`);
  if (item.stackCount) console.log(`    stack          ${item.stackCount}`);
}
if (flagged && !args.has('--allow-flagged')) {
  console.error('\nrefused: the item law flags one or more items; pass --allow-flagged to send anyway\n');
  process.exit(2);
}
console.log(`\n  to append       ${toSend.length} of ${items.length}`);
console.log(`  total worth     ${toSend.reduce((n, [, , item]) => n + (itemWorth ? itemWorth(item) : 0), 0)}`);
console.log(`  mode            ${args.has('--apply') ? 'APPLY — joins the realm and displaces the game tab' : 'dry run (pass --apply to send)'}`);
if (!toSend.length) {
  console.log('\nNothing to append: every asked-for item is already held. Use --force to duplicate.\n');
  process.exit(0);
}
if (!args.has('--apply')) {
  console.log('\nNo request was sent. Re-run with --apply when ready.\n');
  process.exit(0);
}

const editorArgs = [EDITOR];
for (const [, file] of toSend) editorArgs.push('--append-item', join(OUT, file));
if (args.has('--allow-flagged')) editorArgs.push('--allow-flagged');
editorArgs.push('--apply');
const run = spawnSync(process.execPath, editorArgs, { stdio: 'inherit', cwd: HERE });
process.exit(run.status ?? 1);
