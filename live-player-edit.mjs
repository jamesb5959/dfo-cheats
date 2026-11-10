#!/usr/bin/env node
// DFO live player-save editor — own-account testing only.
//
// Writes the character checkpoint, not the account. Stats, skills, level,
// pools, faction/legal reputation, spells and raw save paths are the
// character's own; the service judges some of them (level 1..45, stats
// 0..100, skills 0..200) and ignores others. The script previews the local
// law's findings and refuses a flagged edit unless --allow-flagged.
//
// Dry run (no writes):
//   node live-player-edit.mjs --level 45
//   node live-player-edit.mjs --stats all=100 --skills all=100
//   node live-player-edit.mjs --max-health 5000 --max-magicka 5000
//   node live-player-edit.mjs --max-character
//   node live-player-edit.mjs --carry-weight 1000
//   node live-player-edit.mjs --append-item /tmp/opencode/gun.json
//   node live-player-edit.mjs --faction 9=100 --legal 17=0
//   node live-player-edit.mjs --spell-buff "Arcane Arrow" --spell-factor 5
//   node live-player-edit.mjs --set maxHealth=5000 --set stats.strength=100
//
// Send it (joins the realm and displaces the game tab):
//   node live-player-edit.mjs --level 45 --stats all=100 --apply
//
// See ../reports/DFO-2026-10-31-crafted-arrival.md. Do not publish.

import { readFileSync } from 'node:fs';
import { configValue } from './config.mjs';

const DEFAULT_BASE = 'https://daggerfall-accounts.mackcothran.workers.dev';
const HELP = `DFO live player-save editor — own-account testing only

Get a token once:
  ./dfo-token.sh

Dry run (no writes):
  node live-player-edit.mjs --level 45 --stats all=100 --skills all=100

Send (joins the realm, displacing the game tab):
  node live-player-edit.mjs --level 45 --stats all=100 --skills all=100 --apply

Options:
  --base <url>          default: ${DEFAULT_BASE}
  --token <token>       session bearer (or DFO_TOKEN / .config)
  --handle <handle>     sign in instead (apply only)
  --password-file <f>   password from a file (apply only)
  --character <id>      default: the account's only realm character
  --level <n>           level, 1..45
  --stats <spec>        strength=100,agility=100 or all=100
  --skills <spec>       LongBlade=100,Archery=100 or all=100
  --max-health <n>      set maxHealth (and health, unless --health)
  --max-magicka <n>     set maxMagicka (and magicka, unless --magicka)
  --max-character       level 45, stats 100, skills 200, pools 5000, stat effects
  --weightless          set every held item's weightInKg to 0
  --move-purse-to-bank <n>  move the purse into bank account n (0 carried gold)
  --carry-weight <kg>   add a permanent fortify-strength effect for that carry ceiling
  --health <n>          set current health
  --magicka <n>         set current magicka
  --fatigue <n>         set current fatigue
  --faction <spec>      reputation by id: 9=100,10=50
  --legal <spec>        legal reputation by region: 17=0
  --spell-buff <spell>  duplicate a spell by name or index, scaled
  --spell-factor <n>    magnitude/duration factor (default: 5)
  --remove-template <i> remove every item with template index i
  --append-item <file>  append one lawful item object to the pack (repeatable, no staff)
  --clear-loans         zero every bank loan, due date and default flag
  --ship <n>            set ownedShip (-1 none, 0/1 a hull)
  --sell-ship           sell the current hull into bank 17 (85k/170k) and clear it
  --house <spec>        set a region's house deed: region:mapId:buildingKey[:location]
  --region-price <r=v>  set a region's local price adjustment: 17=-100
  --set <path=json>     set any save path; repeatable
                        e.g. maxHealth=5000, stats.strength=100, spells.0.name="X"
  --allow-flagged       send an edit the local law flags
  --apply               send the request
  --help                this text

The checkpoint is the character's own record. Account titles, glyphs,
auras, icons, effects, armory, silver/Marks, Aurum and Sigil Stones are
not in this save and cannot be edited here.
`;

const die = (why, code = 2) => { console.error(`\nrefused: ${why}\n`); process.exit(code); };

function parseArgs(argv) {
  const out = { set: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--allow-flagged') out['allow-flagged'] = true;
    else if (a === '--clear-loans') out['clear-loans'] = true;
    else if (a === '--sell-ship') out['sell-ship'] = true;
    else if (a === '--max-character') out['max-character'] = true;
    else if (a === '--weightless') out.weightless = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      if (argv[i + 1] == null || argv[i + 1].startsWith('--')) die(`--${key} needs a value`);
      const value = argv[++i];
      if (key === 'set') out.set.push(value);
      else if (key === 'append-item') (out['append-item'] ??= []).push(value);
      else out[key] = value;
    } else die(`unknown argument: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(HELP); process.exit(0); }

const base = String(args.base ?? process.env.DFO_BASE_URL ?? configValue('DFO_BASE_URL') ?? DEFAULT_BASE).replace(/\/+$/, '') || DEFAULT_BASE;
let token = String(args.token ?? process.env.DFO_TOKEN ?? configValue('DFO_TOKEN') ?? '').trim();
const handle = String(args.handle ?? process.env.DFO_HANDLE ?? '').trim();
let password = process.env.DFO_PASSWORD ?? '';
if (args['password-file']) {
  try { password = readFileSync(args['password-file'], 'utf8').replace(/\r?\n$/, ''); } catch (e) { die(`cannot read --password-file: ${e.message}`); }
}
const characterArg = String(args.character ?? process.env.DFO_CHARACTER ?? '').trim();
if (!/^https?:\/\//i.test(base)) die('--base (or DFO_BASE_URL) must be an http(s) URL');
if (!token && !(args.apply && handle && password)) die('a token is needed to read the account; run ./dfo-token.sh (or pass --token/DFO_TOKEN)');

const intArg = (name, min, max) => {
  if (args[name] == null) return null;
  const n = Number(args[name]);
  if (!Number.isSafeInteger(n) || n < min || n > max) die(`--${name} must be a whole number in ${min}..${max}`);
  return n;
};
const levelArg = intArg('level', 1, 45);
const maxHealthArg = intArg('max-health', 0, 2_147_483_647);
const maxMagickaArg = intArg('max-magicka', 0, 2_147_483_647);
const healthArg = intArg('health', 0, 2_147_483_647);
const magickaArg = intArg('magicka', 0, 2_147_483_647);
const fatigueArg = intArg('fatigue', 0, 2_147_483_647);
const carryWeightArg = intArg('carry-weight', 1, 1_000_000);
const spellFactor = args['spell-factor'] != null ? Number(args['spell-factor']) : 5;
if (!(Number.isFinite(spellFactor) && spellFactor > 0)) die('--spell-factor must be a positive number');
const removeTemplate = args['remove-template'] != null ? Number(args['remove-template']) : null;
if (removeTemplate != null && (!Number.isSafeInteger(removeTemplate) || removeTemplate < 0)) die('--remove-template must be a template index');
const shipArg = intArg('ship', -1, 1);
const houseSpec = args.house != null ? String(args.house).trim() : '';
const regionPriceSpec = args['region-price'] != null ? String(args['region-price']).trim() : '';
const clearLoans = args['clear-loans'] === true;
const sellShip = args['sell-ship'] === true;
const maxCharacter = args['max-character'] === true;
const weightless = args.weightless === true;
const movePurseToBank = intArg('move-purse-to-bank', 0, 70);
const appendItemPaths = Array.isArray(args['append-item']) ? args['append-item'].map((p) => String(p).trim()).filter(Boolean) : [];
const allowFlagged = args['allow-flagged'] === true;

// ── the law, for the preview ─────────────────────────────────────────
let characterFindings = null, judgeSave = null, JUDGE_LEVEL_MAX = 45, MAX_STAT_VALUE = 100, SKILL_HARD_CAP = 200;
let STAT_KEYS_ORDER = [], SKILLS = {}, SKILL_KEYS = [];
try {
  const judge = await import(new URL('../daggerfall-js-source/server-account/src/judge.js', import.meta.url));
  characterFindings = judge.characterFindings;
  judgeSave = judge.judgeSave;
  JUDGE_LEVEL_MAX = judge.JUDGE_LEVEL_MAX;
  const stat = await import(new URL('../daggerfall-js-source/src/systems/statMods.js', import.meta.url));
  STAT_KEYS_ORDER = stat.STAT_KEYS_ORDER;
  MAX_STAT_VALUE = stat.MAX_STAT_VALUE;
  const skills = await import(new URL('../daggerfall-js-source/src/systems/skills.js', import.meta.url));
  SKILLS = skills.SKILLS;
  SKILL_KEYS = skills.SKILL_KEYS;
  const soft = await import(new URL('../daggerfall-js-source/src/systems/skillSoftcap.js', import.meta.url));
  SKILL_HARD_CAP = soft.SKILL_HARD_CAP;
} catch (e) {
  die(`the game law is not importable here: ${e.message}`);
}

const STAT_ALIASES = {
  str: 'strength', int: 'intelligence', intel: 'intelligence', wil: 'willpower', will: 'willpower',
  agi: 'agility', end: 'endurance', per: 'personality', pers: 'personality', spd: 'speed', speed: 'speed', luck: 'luck',
};
const skillName = (word) => {
  const w = String(word).trim();
  if (/^\d+$/.test(w)) return Number(w);
  if (SKILLS[w] != null) return SKILLS[w];
  const lower = w.toLowerCase();
  const key = Object.keys(SKILLS).find((k) => k.toLowerCase() === lower);
  return key ? SKILLS[key] : -1;
};

const parsePairs = (spec) => {
  if (!spec) return [];
  return String(spec).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf('=');
    if (i < 0) die(`bad pair "${s}"; use name=value`);
    return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
  });
};

/** Set a dotted path, creating intermediate objects. Numeric parts index arrays. */
function setPath(root, path, value) {
  const parts = String(path).split('.').filter((p) => p !== '');
  if (!parts.length) die('empty --set path');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (/^\d+$/.test(p)) {
      const n = Number(p);
      if (!Array.isArray(cur)) die(`--set ${path}: ${parts.slice(0, i + 1).join('.')} is not an array`);
      if (cur[n] == null) cur[n] = {};
      cur = cur[n];
    } else {
      if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
      cur = cur[p];
    }
  }
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last)) {
    const n = Number(last);
    if (!Array.isArray(cur)) die(`--set ${path}: parent is not an array`);
    cur[n] = value;
  } else {
    if (cur == null || typeof cur !== 'object') die(`--set ${path}: parent is not an object`);
    cur[last] = value;
  }
}

const parseValue = (raw) => {
  try { return JSON.parse(raw); } catch { return raw; }
};

/** The game's entityMaxEncumbrance, over the stats and active effects a save holds. */
function maxCarryKg(save) {
  const base = Number(save?.stats?.strength ?? 0);
  let mod = 0, maxMod = 0;
  for (const a of Array.isArray(save?.activeEffects) ? save.activeEffects : []) {
    if (!a || a.ended) continue;
    if (a.statMaxMods) maxMod += Number(a.statMaxMods.strength ?? 0) || 0;
    if (a.kind === 'fortifyAttribute' && a.stat === 'strength') mod += Number(a.magnitude ?? 0) || 0;
  }
  const live = Math.min(Math.max(base + mod, 0), MAX_STAT_VALUE + maxMod);
  return Math.floor(live * 1.5);
}

function itemLists(save) {
  return ['items', 'otherItems', 'wagonItems', 'bagItems']
    .map((k) => [k, save?.[k]])
    .filter(([, v]) => Array.isArray(v));
}

/** Apply every requested edit to a COPY. Answers { save, changes, notes }. */
function editSave(input) {
  const save = JSON.parse(JSON.stringify(input));
  const changes = [];
  const notes = [];
  const note = (path, from, to) => changes.push({ path, from, to });

  if (maxCharacter) {
    const before = { level: save.level, skills: Array.isArray(save.skills) ? save.skills[0] : null };
    save.level = 45;
    save.levelProgress = 0;
    save.levelRollUp = 0;
    save.readyToLevelUp = false;
    save.pendingLevel = null;
    if (!save.stats || typeof save.stats !== 'object') die('the save has no stats object');
    for (const k of STAT_KEYS_ORDER) save.stats[k] = MAX_STAT_VALUE;
    if (!Array.isArray(save.skills)) die('the save has no skills array');
    for (let i = 0; i < save.skills.length; i++) save.skills[i] = SKILL_HARD_CAP;
    save.maxHealth = 5000;
    save.health = 5000;
    save.maxMagicka = 5000;
    save.magicka = 5000;
    save.fatigue = 5000;
    // Permanent stat effects: 100 base + the fortify magnitude, with
    // statMaxMods lifting the 100 cap. Strength keeps the carry effect's
    // key so --carry-weight still replaces it. The ring's held fortifies
    // then add on top of these, under the higher caps.
    save.activeEffects = (Array.isArray(save.activeEffects) ? save.activeEffects : [])
      .filter((a) => !(a && typeof a.settingsKey === 'string' && a.settingsKey.startsWith('dfo-')));
    const buffs = [
      ['strength', 567, 717, 'dfo-carry'],
      ['intelligence', 400, 550, 'dfo-max-intelligence'],
      ['willpower', 400, 550, 'dfo-max-willpower'],
      ['agility', 400, 550, 'dfo-max-agility'],
      ['endurance', 400, 550, 'dfo-max-endurance'],
      ['personality', 400, 550, 'dfo-max-personality'],
      ['speed', 400, 550, 'dfo-max-speed'],
      ['luck', 400, 550, 'dfo-max-luck'],
    ];
    for (const [stat, magnitude, cap, key] of buffs) {
      save.activeEffects.push({
        kind: 'fortifyAttribute',
        stat,
        settingsKey: key,
        magnitude,
        roundsRemaining: 999999,
        permanent: true,
        statMaxMods: { [stat]: cap },
      });
    }
    changes.push({ path: 'max character', from: `${before.level ?? '?'} / ${before.skills ?? '?'}`, to: 'level 45, stats 100, skills 200, pools 5000, 8 stat effects' });
  }

  if (levelArg != null) {
    if (levelArg > JUDGE_LEVEL_MAX) die(`--level ${levelArg} is past the judge's ${JUDGE_LEVEL_MAX}`);
    note('level', save.level, levelArg);
    save.level = levelArg;
    save.levelProgress = 0;
    save.levelRollUp = 0;
    save.readyToLevelUp = false;
    save.pendingLevel = null;
  }

  for (const [nameRaw, valueRaw] of parsePairs(args.stats)) {
    const name = STAT_ALIASES[nameRaw.toLowerCase()] ?? nameRaw.toLowerCase();
    const value = Number(valueRaw);
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_STAT_VALUE) die(`stat ${name} must be 0..${MAX_STAT_VALUE}`);
    if (!save.stats || typeof save.stats !== 'object') die('the save has no stats object');
    if (name === 'all') {
      for (const k of STAT_KEYS_ORDER) { note(`stats.${k}`, save.stats[k], value); save.stats[k] = value; }
    } else {
      if (save.stats[name] == null) die(`unknown stat ${name}; use ${STAT_KEYS_ORDER.join(', ')}`);
      note(`stats.${name}`, save.stats[name], value);
      save.stats[name] = value;
    }
  }

  if (args.skills != null) {
    if (!Array.isArray(save.skills)) die('the save has no skills array');
    for (const [nameRaw, valueRaw] of parsePairs(args.skills)) {
      const value = Number(valueRaw);
      if (!Number.isSafeInteger(value) || value < 0 || value > SKILL_HARD_CAP) die(`skill ${nameRaw} must be 0..${SKILL_HARD_CAP}`);
      if (nameRaw.toLowerCase() === 'all') {
        for (let i = 0; i < save.skills.length; i++) { note(`skills.${i}`, save.skills[i], value); save.skills[i] = value; }
      } else {
        const id = skillName(nameRaw);
        if (id < 0 || id >= save.skills.length) die(`unknown skill ${nameRaw}`);
        note(`skills.${id}`, save.skills[id], value);
        save.skills[id] = value;
      }
    }
  }

  if (maxHealthArg != null) {
    note('maxHealth', save.maxHealth, maxHealthArg);
    save.maxHealth = maxHealthArg;
    if (healthArg == null) { note('health', save.health, maxHealthArg); save.health = maxHealthArg; }
  }
  if (healthArg != null) {
    note('health', save.health, healthArg);
    save.health = healthArg;
  }
  if (maxMagickaArg != null) {
    note('maxMagicka', save.maxMagicka, maxMagickaArg);
    save.maxMagicka = maxMagickaArg;
    if (magickaArg == null) { note('magicka', save.magicka, maxMagickaArg); save.magicka = maxMagickaArg; }
  }
  if (magickaArg != null) {
    note('magicka', save.magicka, magickaArg);
    save.magicka = magickaArg;
  }
  if (fatigueArg != null) {
    note('fatigue', save.fatigue, fatigueArg);
    save.fatigue = fatigueArg;
  }

  if (carryWeightArg != null) {
    if (!save.stats || typeof save.stats !== 'object') die('the save has no stats object');
    const base = Number(save.stats.strength);
    if (!Number.isFinite(base)) die('the save has no strength');
    const needed = Math.ceil(carryWeightArg / 1.5);
    const extra = needed - base;
    const before = maxCarryKg(save);
    if (extra <= 0) die(`--carry-weight ${carryWeightArg} is at or below the current ${before} kg; ask for more`);
    // IncreasedWeightAllowance's own shape is a +strength channel. statMaxMods
    // lifts the 100 cap and magnitude spends the lift, so liveStat answers
    // `needed` exactly; the judge reads neither field.
    save.activeEffects = (Array.isArray(save.activeEffects) ? save.activeEffects : [])
      .filter((a) => !(a && a.settingsKey === 'dfo-carry'));
    save.activeEffects.push({
      kind: 'fortifyAttribute',
      stat: 'strength',
      settingsKey: 'dfo-carry',
      magnitude: extra,
      roundsRemaining: 999999,
      permanent: true,
      statMaxMods: { strength: extra },
    });
    changes.push({ path: 'carry weight', from: `${before} kg`, to: `${Math.floor(needed * 1.5)} kg (strength ${base}+${extra})` });
  }

  for (const [idRaw, valueRaw] of parsePairs(args.faction)) {
    if (!save.factionRep || !Array.isArray(save.factionRep.ids) || !Array.isArray(save.factionRep.rep)) die('the save has no factionRep ids/rep');
    const id = Number(idRaw);
    const value = Number(valueRaw);
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(value)) die(`bad --faction ${idRaw}=${valueRaw}`);
    const at = save.factionRep.ids.indexOf(id);
    if (at < 0) die(`faction id ${id} is not in the save`);
    note(`factionRep.rep.${at}`, save.factionRep.rep[at], value);
    save.factionRep.rep[at] = value;
  }

  for (const [regionRaw, valueRaw] of parsePairs(args.legal)) {
    if (!save.legalRep || typeof save.legalRep !== 'object') die('the save has no legalRep');
    const region = String(Number(regionRaw));
    const value = Number(valueRaw);
    if (!Number.isSafeInteger(Number(region)) || !Number.isSafeInteger(value)) die(`bad --legal ${regionRaw}=${valueRaw}`);
    note(`legalRep.${region}`, save.legalRep[region], value);
    save.legalRep[region] = value;
  }

  if (args['spell-buff'] != null) {
    if (!Array.isArray(save.spells) || !save.spells.length) die('the save has no spells');
    const want = String(args['spell-buff']).trim();
    const at = save.spells.findIndex((s) => String(s?.index) === want || String(s?.name ?? '').toLowerCase() === want.toLowerCase());
    if (at < 0) die(`no spell named/indexed ${want}`);
    const copy = JSON.parse(JSON.stringify(save.spells[at]));
    const nextIndex = save.spells.reduce((m, s) => Math.max(m, Number.isSafeInteger(s?.index) ? s.index : 0), 0) + 1;
    copy.index = nextIndex;
    copy.name = `${copy.name ?? 'Spell'} (edited)`;
    for (const e of Array.isArray(copy.effects) ? copy.effects : []) {
      for (const k of ['magnitudeBaseLow', 'magnitudeBaseHigh', 'magnitudeLevelBase', 'magnitudeLevelHigh', 'magnitudePerLevel', 'durationBase', 'durationPerLevel']) {
        if (Number.isFinite(e[k]) && e[k] > 0) e[k] = Math.round(e[k] * spellFactor);
      }
    }
    if (Number.isFinite(copy.cost)) copy.cost = Math.max(1, Math.round(copy.cost / spellFactor));
    save.spells.push(copy);
    changes.push({ path: `spells.${save.spells.length - 1}`, from: null, to: `${copy.name} (index ${copy.index})` });
    notes.push(`spell copied from ${save.spells[at].name ?? at}, factor ${spellFactor}`);
  }

  if (removeTemplate != null) {
    let removed = 0;
    for (const [key, list] of itemLists(save)) {
      const before = list.length;
      const kept = list.filter((it) => it?.templateIndex !== removeTemplate);
      removed += before - kept.length;
      save[key] = kept;
    }
    changes.push({ path: `remove item template ${removeTemplate}`, from: null, to: `removed ${removed}` });
  }

  for (const appendItemPath of appendItemPaths) {
    let text;
    try { text = readFileSync(appendItemPath, 'utf8'); } catch (e) { die(`cannot read --append-item: ${e.message}`); }
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { die(`--append-item is not JSON: ${e.message}`); }
    const item = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!item || typeof item !== 'object' || Array.isArray(item)) die('--append-item must hold one item object');
    if (!Number.isSafeInteger(item.templateIndex)) die('--append-item item has no templateIndex');
    if (!Array.isArray(save.items)) die('the save has no items array');
    save.items.push(item);
    changes.push({ path: `items.${save.items.length - 1}`, from: null, to: `${item.name ?? item.templateIndex} (${item.templateIndex})` });
  }

  if (weightless) {
    let n = 0;
    for (const [, list] of itemLists(save)) {
      for (const it of list) {
        if (!it || typeof it !== 'object') continue;
        it.weightInKg = 0;
        if (Number.isFinite(it.water) && it.water > 0) it.water = 0;
        n++;
      }
    }
    changes.push({ path: 'weightless', from: null, to: `${n} item(s) at weightInKg 0` });
  }

  if (clearLoans) {
    if (!Array.isArray(save.bankAccounts)) die('the save has no bankAccounts');
    let cleared = 0;
    save.bankAccounts.forEach((a) => {
      if (!a || typeof a !== 'object') return;
      if (a.loanTotal !== 0 || a.loanDueDate !== 0 || a.hasDefaulted === true) cleared++;
      a.loanTotal = 0;
      a.loanDueDate = 0;
      a.hasDefaulted = false;
    });
    changes.push({ path: 'bankAccounts[*].loanTotal/loanDueDate/hasDefaulted', from: null, to: `cleared on ${cleared} account(s)` });
  }

  if (movePurseToBank != null) {
    if (!Array.isArray(save.bankAccounts)) die('the save has no bankAccounts');
    const purse = Number.isSafeInteger(save.goldPieces) && save.goldPieces > 0 ? save.goldPieces : 0;
    while (save.bankAccounts.length <= movePurseToBank) {
      const regionIndex = save.bankAccounts.length;
      save.bankAccounts.push({ regionIndex, accountGold: 0, loanTotal: 0, loanDueDate: 0, hasDefaulted: false });
    }
    const acct = save.bankAccounts[movePurseToBank];
    if (!acct || typeof acct !== 'object') die(`bank account ${movePurseToBank} is not a record`);
    const before = Number.isSafeInteger(acct.accountGold) ? acct.accountGold : 0;
    acct.accountGold = before + purse;
    save.goldPieces = 0;
    changes.push({ path: `bankAccounts.${movePurseToBank}.accountGold`, from: before, to: `${acct.accountGold} (+${purse} purse moved)` });
  }

  if (shipArg != null) {
    note('ownedShip', save.ownedShip, shipArg);
    save.ownedShip = shipArg;
  }

  if (sellShip) {
    const ship = save.ownedShip;
    if (ship !== 0 && ship !== 1) die('--sell-ship needs --ship 0 or 1 first');
    const price = ship === 0 ? 85_000 : 170_000;   // shipSellPrice: SHIP_PRICES x 0.85
    if (!Array.isArray(save.bankAccounts)) die('the save has no bankAccounts');
    if (!save.bankAccounts[17] || typeof save.bankAccounts[17] !== 'object') {
      save.bankAccounts[17] = { regionIndex: 17, accountGold: 0, loanTotal: 0, loanDueDate: 0, hasDefaulted: false };
    }
    const acct = save.bankAccounts[17];
    acct.accountGold = (Number.isSafeInteger(acct.accountGold) ? acct.accountGold : 0) + price;
    save.ownedShip = -1;
    changes.push({ path: 'ship sale', from: ship, to: `+${price} bank 17, ownedShip -1` });
  }

  if (houseSpec) {
    const parts = houseSpec.split(':');
    if (parts.length < 3) die('--house needs region:mapId:buildingKey[:location]');
    const region = Number(parts.shift());
    const mapId = Number(parts.shift());
    const buildingKey = Number(parts.shift());
    const location = parts.join(':');
    if (!Number.isSafeInteger(region) || region < 0 || region >= (save.houses?.length ?? 0)) die(`--house region ${region} is not in the save`);
    if (!Number.isSafeInteger(mapId) || mapId < 0) die('--house mapId must be a whole number');
    if (!Number.isSafeInteger(buildingKey) || buildingKey <= 0) die('--house buildingKey must be a positive whole number');
    const old = save.houses[region];
    save.houses[region] = { ...(old && typeof old === 'object' ? old : {}), regionIndex: region, location, mapId, buildingKey };
    changes.push({ path: `houses.${region}`, from: old, to: save.houses[region] });
  }

  if (regionPriceSpec) {
    const i = regionPriceSpec.indexOf('=');
    if (i < 0) die('--region-price needs region=value');
    const region = Number(regionPriceSpec.slice(0, i));
    const value = Number(regionPriceSpec.slice(i + 1));
    if (!Number.isSafeInteger(region) || region < 0) die('--region-price region must be a whole number');
    if (!Number.isFinite(value)) die('--region-price value must be a number');
    if (!save.regionPrices || typeof save.regionPrices !== 'object') save.regionPrices = {};
    note(`regionPrices.${region}`, save.regionPrices[region], value);
    save.regionPrices[region] = value;
  }

  for (const spec of args.set ?? []) {
    const i = spec.indexOf('=');
    if (i < 0) die(`--set ${spec} needs path=value`);
    const path = spec.slice(0, i).trim();
    const value = parseValue(spec.slice(i + 1));
    let old;
    try {
      old = path.split('.').reduce((o, p) => (o == null ? undefined : o[/^\d+$/.test(p) ? Number(p) : p]), save);
    } catch { old = undefined; }
    setPath(save, path, value);
    changes.push({ path, from: old, to: value });
  }

  if (!changes.length) die('nothing to edit; pass --level, --stats, --skills, --max-health, --max-magicka, --max-character, --carry-weight, --weightless, --move-purse-to-bank, --faction, --legal, --spell-buff, --remove-template, --append-item, --clear-loans, --ship, --sell-ship, --house, --region-price or --set');
  return { save, changes, notes };
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

// ── sign in, if needed ──────────────────────────────────────────────
if (!token && handle && password) {
  const signed = await request('POST', '/v1/auth/login', { body: { handle, password, label: 'live-player-edit' }, auth: false });
  token = String(signed?.secret ?? '');
  if (!token) die('login did not answer a session secret');
  console.log(`signed in as ${signed.name ?? handle}`);
}

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

const stored = await getSave(character);
const preview = editSave(stored.save);
const findings = characterFindings ? characterFindings(preview.save, null) : [];
if (findings.length && !allowFlagged) {
  die(`the character law flags this edit: ${findings.map((f) => f.code + (f.at != null ? `@${f.at}` : '')).join(', ')}; pass --allow-flagged to send it anyway`);
}
const itemFindings = judgeSave ? judgeSave(preview.save, null).findings : [];
if (itemFindings.length && !allowFlagged) {
  die(`the judge flags this save: ${itemFindings.map((f) => `${f.code}${f.t != null ? `@${f.t}` : ''}`).join(', ')}; pass --allow-flagged to send it anyway`);
}

console.log('DFO live player-save editor — own-account testing only');
console.log(`  base            ${base}`);
console.log(`  character       ${character} (${ch.name ?? '?'})  online=${ch.playing ? 'yes' : 'no'}  seq=${stored.seq}`);
console.log(`  save            ${stored.bytes} bytes, ${Array.isArray(stored.save.items) ? stored.save.items.length : 0} items`);
console.log(`  edits           ${preview.changes.length}`);
for (const c of preview.changes.slice(0, 60)) console.log(`    ${c.path}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
if (preview.changes.length > 60) console.log(`    ... ${preview.changes.length - 60} more`);
for (const n of preview.notes) console.log(`  note            ${n}`);
if (findings.length) console.log(`  law findings    ${findings.map((f) => f.code + (f.at != null ? `@${f.at}` : '')).join(', ')}  (--allow-flagged)`);
console.log(`  mode            ${args.apply ? 'APPLY — requests will be sent' : 'dry run (pass --apply to send)'}`);

if (!args.apply) {
  console.log('\nNo request was sent. Re-run with --apply when ready.');
  process.exit(0);
}

// ── apply ───────────────────────────────────────────────────────────
try {
  const joined = await request('POST', '/v1/realm/join', { body: { id: character } });
  if (joined?.error) throw new Error(`join: ${joined.error}`);
  if (joined?.id !== character) throw new Error(`join answered ${joined?.id ?? 'no id'}, not ${character}`);
  const lease = String(joined.lease ?? '');
  if (!lease) throw new Error('join answered no lease');
  console.log(`joined ${character} at seq ${joined.seq}`);

  const live = await getSave(character);
  if (live.seq !== Number(joined.seq)) throw new Error(`the record moved from join's ${joined.seq} to ${live.seq}; re-run`);
  const baseSave = JSON.parse(JSON.stringify(live.save));
  const edited = editSave(live.save).save;
  const liveFindings = characterFindings ? characterFindings(edited, null) : [];
  if (liveFindings.length && !allowFlagged) throw new Error(`the live character law flags the edit: ${liveFindings.map((f) => f.code).join(', ')}`);
  const liveItems = judgeSave ? judgeSave(edited, null).findings : [];
  if (liveItems.length && !allowFlagged) throw new Error(`the live judge flags the save: ${liveItems.map((f) => f.code).join(', ')}`);

  const put = (body, seq) => request('PUT', `/v1/realm/${encodeURIComponent(character)}/data`, {
    raw: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-realm-lease': lease, 'x-realm-seq': String(seq) },
  });

  const one = await put(edited, live.seq + 1);
  if (!one?.ok) throw new Error(`checkpoint refused: ${JSON.stringify(one)}`);
  console.log(`checkpoint: seq ${one.seq}, tradeHeld ${one.tradeHeld ?? 'none'}${one.tradeHeldWhy ? ` (${JSON.stringify(one.tradeHeldWhy)})` : ''}`);
  if (one.tradeHeld) {
    const clean = await put(baseSave, one.seq + 1).catch((e) => ({ error: e.message }));
    if (clean?.ok) console.log(`cleanup: seq ${clean.seq}, tradeHeld ${clean.tradeHeld ?? 'none'}`);
    else console.log(`cleanup refused: ${JSON.stringify(clean)}`);
    throw new Error(`the checkpoint is held (${one.tradeHeld}); ${clean?.ok ? 'the pre-run save was restored' : 'the edited save may remain'}`);
  }

  const got = await getSave(character);
  console.log('\nstored record');
  console.log(`  seq             ${got.seq}`);
  console.log(`  level           ${got.save.level}`);
  console.log(`  stats           ${STAT_KEYS_ORDER.map((k) => `${k}:${got.save.stats?.[k] ?? '?'}`).join(' ')}`);
  console.log(`  skills          ${Array.isArray(got.save.skills) ? got.save.skills.slice(0, 8).join(',') + (got.save.skills.length > 8 ? ',…' : '') : '?'}`);
  console.log(`  health/magicka  ${got.save.health}/${got.save.maxHealth}  ${got.save.magicka}/${got.save.maxMagicka}`);
  console.log(`  carry           ${maxCarryKg(got.save)} kg`);
  console.log(`  purse / bank    ${got.save.goldPieces ?? '?'} / ${Array.isArray(got.save.bankAccounts) ? got.save.bankAccounts.reduce((n, a) => n + (Number.isSafeInteger(a?.accountGold) ? a.accountGold : 0), 0) : '?'}`);
  console.log(`  items           ${Array.isArray(got.save.items) ? got.save.items.length : '?'}`);
  console.log(`  spells          ${Array.isArray(got.save.spells) ? got.save.spells.length : 0}`);
  console.log('\nPASS: the character record moved.');
  console.log('The game tab\'s lease was displaced. Rejoin the character in game to load this save.');
} catch (e) {
  die(e?.message ?? String(e), 1);
}
