#!/usr/bin/env node
// Make the full maxed wearable set on the account's own character, in one
// checkpoint:
//
//   • seven Daedric armour pieces (cuirass, gauntlets, greaves, both
//     pauldrons, helm, boots) with nine CastWhenHeld rows: the eight
//     attribute fortifies and Shield;
//   • a Daedric Tower Shield with the same nine rows;
//   • ten jewellery pieces (two each of amulet, bracer, ring, bracelet,
//     mark) with the same nine rows;
//   • nineteen Daedric weapons (every weapon template except the already
//     maxed Dai-katana and Thunderlock) with nine CastWhenStrikes rows at
//     Gods' Fire (spell 32);
//   • 65,535 arrows for the bows.
//
// Every row is a classic ten-slot row set (nine live rows + None), which
// the item law accepts. The items are appended with
// live-player-edit.mjs --append-item: no staff, no planks, no Marks. The
// checkpoint's wealth measure still sees their worth; with budget.enforce
// off it passes as a measure finding, with it on it holds.
//
// Dry run:
//   node make-max-wearables.mjs
//
// Send (joins the realm and displaces the game tab):
//   node make-max-wearables.mjs --apply
//
// Options:
//   --apply          send the checkpoint
//   --no-armor       skip the seven armour pieces and shield
//   --no-jewelry     skip the ten jewellery pieces
//   --no-weapons     skip the weapons and arrows
//   --allow-flagged  pass --allow-flagged to the editor
//   --help           this text
//
// Private. Own-account only. Do not publish.

import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = '/tmp/opencode/dfc-wearables';
const EDITOR = join(HERE, 'live-player-edit.mjs');

const HELP = `make-max-wearables.mjs — the full maxed wearable set

  node make-max-wearables.mjs              dry run; writes the item JSON
  node make-max-wearables.mjs --apply      append in one checkpoint
  node make-max-wearables.mjs --no-armor   skip armour and shield
  node make-max-wearables.mjs --no-jewelry skip jewellery
  node make-max-wearables.mjs --no-weapons skip weapons and arrows

Every item is appended with live-player-edit.mjs --append-item: no staff,
no planks, no Marks. The item law still runs; the checkpoint's wealth
measure still sees the worth, so it passes only while budget.enforce is off.
`;

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.has('-h')) { console.log(HELP); process.exit(0); }
for (const a of args) if (!['--apply', '--no-armor', '--no-jewelry', '--no-weapons', '--allow-flagged'].includes(a)) {
  console.error(`\nrefused: unknown argument ${a}\n`);
  process.exit(2);
}

let itemFindings = null, itemWorth = null;
try {
  const law = await import(new URL('../daggerfall-js-source/src/systems/item/itemLaw.js', import.meta.url));
  itemFindings = law.itemFindings;
  itemWorth = law.itemWorth;
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
const heldRow = (param) => ({
  type: 1, param,                 // CastWhenHeld
  durationBase: 999, durationMod: 0, durationPerLevel: 0,
  chanceBase: 100, chanceMod: 0, chancePerLevel: 0,
  magnitudeBaseLow: 999, magnitudeBaseHigh: 999,
  magnitudeLevelBase: 1, magnitudeLevelHigh: 1, magnitudePerLevel: 0,
});
const strikeRow = () => ({
  type: 2, param: 32,             // CastWhenStrikes: Gods' Fire
  durationBase: 999, durationMod: 0, durationPerLevel: 0,
  chanceBase: 100, chanceMod: 0, chancePerLevel: 0,
  magnitudeBaseLow: 999, magnitudeBaseHigh: 999,
  magnitudeLevelBase: 1, magnitudeLevelHigh: 1, magnitudePerLevel: 0,
});

const HELD_SPELLS = [82, 83, 84, 85, 86, 87, 88, 89, 17];   // eight attributes + Shield
const heldRows = () => HELD_SPELLS.map(heldRow).concat([noneRow]);
const strikeRows = () => Array.from({ length: 9 }, strikeRow).concat([noneRow]);

const CONDITION = 1_000_000;
const ARMOR_DAEDRIC = 521;   // ARMOR_MATERIALS 0x0209; weapon Daedric is 9

const items = [];
const add = (label, file, item) => items.push([label, file, item]);

if (!args.has('--no-armor')) {
  const armor = [
    [102, 'Daedric Cuirass of the Eight'],
    [103, 'Daedric Gauntlets of the Eight'],
    [104, 'Daedric Greaves of the Eight'],
    [105, 'Daedric Left Pauldron of the Eight'],
    [106, 'Daedric Right Pauldron of the Eight'],
    [107, 'Daedric Helm of the Eight'],
    [108, 'Daedric Boots of the Eight'],
    [112, 'Daedric Tower Shield of the Eight'],
  ];
  for (const [templateIndex, name] of armor) {
    add(name, `armor-${templateIndex}.json`, {
      group: 'Armor', templateIndex, material: ARMOR_DAEDRIC, name,
      maxCondition: CONDITION, currentCondition: CONDITION, value: 0,
      enchantments: heldRows(),
    });
  }
}

if (!args.has('--no-jewelry')) {
  const jewelry = [
    [133, 'Amulet of the Eight I'], [133, 'Amulet of the Eight II'],
    [134, 'Bracer of the Eight I'], [134, 'Bracer of the Eight II'],
    [135, 'Ring of the Eight I'], [135, 'Ring of the Eight II'],
    [136, 'Bracelet of the Eight I'], [136, 'Bracelet of the Eight II'],
    [137, 'Mark of the Eight I'], [137, 'Mark of the Eight II'],
  ];
  jewelry.forEach(([templateIndex, name], i) => {
    add(name, `jewelry-${i}.json`, {
      group: 'Jewellery', templateIndex, name,
      maxCondition: CONDITION, currentCondition: CONDITION, value: 0,
      enchantments: heldRows(),
    });
  });
}

if (!args.has('--no-weapons')) {
  const weapons = [
    [113, 'Daedric Dagger of the Nine'],
    [114, 'Daedric Tanto of the Nine'],
    [115, 'Daedric Staff of the Nine'],
    [116, 'Daedric Shortsword of the Nine'],
    [117, 'Daedric Wakizashi of the Nine'],
    [118, 'Daedric Broadsword of the Nine'],
    [119, 'Daedric Saber of the Nine'],
    [120, 'Daedric Longsword of the Nine'],
    [121, 'Daedric Katana of the Nine'],
    [122, 'Daedric Claymore of the Nine'],
    [124, 'Daedric Mace of the Nine'],
    [125, 'Daedric Flail of the Nine'],
    [126, 'Daedric Warhammer of the Nine'],
    [127, 'Daedric Battle Axe of the Nine'],
    [128, 'Daedric War Axe of the Nine'],
    [129, 'Daedric Short Bow of the Nine'],
    [130, 'Daedric Long Bow of the Nine'],
    [562, 'Daedric Dwarven Pistolet of the Nine'],
    [563, 'Daedric Hand Wraps of the Nine'],
  ];
  for (const [templateIndex, name] of weapons) {
    add(name, `weapon-${templateIndex}.json`, {
      group: 'Weapons', templateIndex, material: 9, name,
      maxCondition: CONDITION, currentCondition: CONDITION, value: 0,
      enchantments: strikeRows(),
    });
  }
  add('65,535 Arrows', 'arrows.json', {
    group: 'Weapons', templateIndex: 131, name: 'Arrow',
    maxCondition: 1, currentCondition: 1, value: 0, stackCount: 65535,
  });
}

mkdirSync(OUT, { recursive: true });
let flagged = 0;
let worth = 0;
console.log('DFO max wearables — own-account testing only');
console.log(`  output          ${OUT}`);
console.log('  path            live-player-edit.mjs --append-item (one checkpoint, no staff)');
console.log('');
for (const [label, file, item] of items) {
  const path = join(OUT, file);
  writeFileSync(path, JSON.stringify(item, null, 2));
  const findings = itemFindings ? itemFindings(item) : [];
  if (findings.length) flagged++;
  const w = itemWorth ? itemWorth(item) : 0;
  worth += w;
  console.log(`  ${label.padEnd(42)} ${String(item.templateIndex).padStart(4)}  worth ${String(w).padStart(9)}  ${findings.length ? `FLAGGED: ${findings.join(', ')}` : 'lawful'}`);
}
if (flagged && !args.has('--allow-flagged')) {
  console.error('\nrefused: the item law flags one or more items; pass --allow-flagged to send anyway\n');
  process.exit(2);
}
console.log(`\n  items           ${items.length}`);
console.log(`  total worth     ${worth}`);
console.log(`  mode            ${args.has('--apply') ? 'APPLY — joins the realm and displaces the game tab' : 'dry run (pass --apply to send)'}`);
if (!args.has('--apply')) {
  console.log('\nNo request was sent. Re-run with --apply when ready.\n');
  process.exit(0);
}

const editorArgs = [EDITOR];
for (const [, file] of items) editorArgs.push('--append-item', join(OUT, file));
if (args.has('--allow-flagged')) editorArgs.push('--allow-flagged');
editorArgs.push('--apply');
const run = spawnSync(process.execPath, editorArgs, { stdio: 'inherit', cwd: HERE });
process.exit(run.status ?? 1);
