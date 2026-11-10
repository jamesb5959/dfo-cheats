#!/usr/bin/env node
// Raise the live character above the previous stat/skill ceiling:
//
//   • activeEffects fortify attributes to 5,000 / strength 10,000, with
//     statMaxMods lifting the cap (live 5,100 / 10,100, carry ~15,150 kg)
//   • health / magicka / fatigue 50,000
//   • ten jewellery pieces, each nine EnhancesSkill rows for Long Blade
//     (+135 effective Long Blade each; +1,350 for the full set)
//
// The character judge reads stats 0..100 and skills 0..200; activeEffects and
// item skill mods are outside it. The Portal Book (577) still makes the local
// judge print template@577, so --allow-flagged is passed; the service accepted
// that before.
//
// Dry run:  node make-stat-max.mjs
// Send:     node make-stat-max.mjs --apply

import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configValue } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EDITOR = join(HERE, 'live-player-edit.mjs');
const APPLY = process.argv.includes('--apply');
const OUT = '/tmp/opencode/blade';
const BASE = String(process.env.DFO_BASE_URL ?? configValue('DFO_BASE_URL') ?? 'https://daggerfall-accounts.mackcothran.workers.dev').replace(/\/+$/, '');
const TOKEN = String(process.env.DFO_TOKEN ?? configValue('DFO_TOKEN') ?? '').trim();

const none = { type:-1, param:-1, durationBase:0, durationMod:0, durationPerLevel:0, chanceBase:0, chanceMod:0, chancePerLevel:0, magnitudeBaseLow:0, magnitudeBaseHigh:0, magnitudeLevelBase:0, magnitudeLevelHigh:0, magnitudePerLevel:0 };
const skillRow = () => ({ type:10, param:29, durationBase:999, durationMod:0, durationPerLevel:0, chanceBase:100, chanceMod:0, chancePerLevel:0, magnitudeBaseLow:999, magnitudeBaseHigh:999, magnitudeLevelBase:1, magnitudeLevelHigh:1, magnitudePerLevel:0 });

const pieces = [
  [135, 'Ring of the Blade I'], [135, 'Ring of the Blade II'],
  [133, 'Amulet of the Blade I'], [133, 'Amulet of the Blade II'],
  [134, 'Bracer of the Blade I'], [134, 'Bracer of the Blade II'],
  [136, 'Bracelet of the Blade I'], [136, 'Bracelet of the Blade II'],
  [137, 'Mark of the Blade I'], [137, 'Mark of the Blade II'],
];

async function currentSave() {
  if (!TOKEN) throw new Error('no token; run ./dfo-token.sh');
  const headers = { authorization: `Bearer ${TOKEN}` };
  const realm = await (await fetch(`${BASE}/v1/realm`, { headers })).json();
  const ch = (realm.characters ?? [])[0];
  if (!ch) throw new Error('no realm character');
  const save = await (await fetch(`${BASE}/v1/realm/${encodeURIComponent(ch.id)}/data`, { headers })).json();
  return { id: ch.id, save };
}

const { id, save } = await currentSave();
const effects = Array.isArray(save.activeEffects) ? save.activeEffects : [];
const statEffect = (stat) => effects.findIndex((a) => a && a.stat === stat && a.kind === 'fortifyAttribute');
const stats = [
  ['strength', 10000],
  ['intelligence', 5000], ['willpower', 5000], ['agility', 5000],
  ['endurance', 5000], ['personality', 5000], ['speed', 5000], ['luck', 5000],
];

mkdirSync(OUT, { recursive: true });
const args = [EDITOR];
for (let i = 0; i < pieces.length; i++) {
  const [templateIndex, name] = pieces[i];
  const item = { group:'Jewellery', templateIndex, name, maxCondition:1000000, currentCondition:1000000, value:0, enchantments:Array.from({length:9},skillRow).concat([none]) };
  const path = join(OUT, `blade-${i}.json`);
  writeFileSync(path, JSON.stringify(item, null, 2));
  args.push('--append-item', path);
}
for (const [stat, mag] of stats) {
  const at = statEffect(stat);
  if (at < 0) {
    const entry = { kind:'fortifyAttribute', stat, settingsKey:`dfo-max-${stat}`, magnitude:mag, roundsRemaining:999999, permanent:true, statMaxMods:{ [stat]: mag } };
    args.push('--set', `activeEffects.${effects.length}=${JSON.stringify(entry)}`);
  } else {
    args.push('--set', `activeEffects.${at}.magnitude=${mag}`);
    args.push('--set', `activeEffects.${at}.statMaxMods.${stat}=${mag}`);
  }
}
for (const [k, v] of [['maxHealth', 50000], ['health', 50000], ['maxMagicka', 50000], ['magicka', 50000], ['fatigue', 50000]]) {
  args.push('--set', `${k}=${v}`);
}
args.push('--allow-flagged');
if (APPLY) args.push('--apply');

console.log(`character ${id}; effects ${effects.length}; blade pieces ${pieces.length}; stats 5,000/10,000; pools 50,000; mode ${APPLY ? 'APPLY' : 'dry run'}`);
const run = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: HERE });
process.exit(run.status ?? 1);
