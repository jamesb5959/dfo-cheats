#!/usr/bin/env node
// DFO item catalogue — READ ONLY. No account, token or network needed.
//
// Lists every base item template this checkout's item law accepts, with the
// material variants an honest client can mint. Each row is built through the
// same producers the game uses (`setItemFields` + `mintCondition`) and then
// checked with `itemFindings`; `--show` prints the exact object shape the
// checkpoint expects. The catalogue does not roll rarity, affixes,
// enchantments, artifacts or provenance records — those are separate laws.
//
// List everything:
//   node item-catalog.mjs
//
// Search (all words must match; name, group, index and material are searched):
//   node item-catalog.mjs daedric longsword
//   node item-catalog.mjs --group Weapons --material Daedric --max-value 50000
//   node item-catalog.mjs --stackable --search potion
//
// Print one exact item object (add --material for a gear variant):
//   node item-catalog.mjs --show 123 --material daedric
//   node item-catalog.mjs --show 131 --stack 65535
//
// Machine-readable:
//   node item-catalog.mjs --json daedric > daedric.json

import {
  ITEM_TEMPLATES, customTemplateRows, templateByIndex, setItemFields, mintCondition, isAmmunition,
} from '../daggerfall-js-source/src/systems/item/itemTemplates.js';
import { itemFindings, itemWorth, templateGroups, ARTIFACT_RECORDS } from '../daggerfall-js-source/src/systems/item/itemLaw.js';
import { isStackable, effectiveUnitWeightInKg } from '../daggerfall-js-source/src/systems/inventory.js';
import { MATERIAL_NAMES } from '../daggerfall-js-source/src/systems/item/itemInfo.js';
import { ARMOR_MATERIAL } from '../daggerfall-js-source/src/systems/armorMaterials.js';
import { GILDED_RECORDS, mintGilded } from '../daggerfall-js-source/src/systems/gilded.js';
import { ARTIFACT_SUB_TYPE_NAMES, ITEM_GROUP_NAME_BY_CLASS } from '../daggerfall-js-source/src/systems/loot/loot.js';
import { GROUP_TEMPLATE_INDICES } from '../daggerfall-js-source/src/systems/item/itemTemplatesData.js';

const STAFF_WITNESS = 11_000;         // live-arrived-worth.mjs STAFF_WORTH
const SCRIPT_MAX_CRAFTS = 30;         // live-arrived-worth.mjs --crafts ceiling
const GOLD_INT_MAX = 2_147_483_647;   // itemLaw.js GOLD_INT_MAX
const LOOT_STACK_MAX = 65_535;        // loot.js LOOT_STACK_MAX
const GOLD_TEMPLATE = 276;

const WEAPON_MATERIALS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

/** Words a player is likely to type that the template name does not carry. */
const ALIASES = Object.freeze({
  78: 'potion drug', 79: 'potion drug', 80: 'potion drug', 81: 'potion drug',
  83: 'potion flask bottle', 274: 'soul gem trap', 275: 'letter credit gold',
  276: 'gold coins money', 277: 'book tome', 278: 'potion recipe', 287: 'map',
  93: 'cart wagon', 94: 'horse mount', 1820: 'dragon mount',
});
const GROUP_TAGS = Object.freeze({
  Weapons: 'weapon', Armor: 'armour armor', Gems: 'gem jewel',
  MensClothing: 'clothing clothes', WomensClothing: 'clothing clothes',
  PlantIngredients1: 'ingredient plant', PlantIngredients2: 'ingredient plant',
  CreatureIngredients1: 'ingredient creature', CreatureIngredients2: 'ingredient creature',
  CreatureIngredients3: 'ingredient creature', MiscellaneousIngredients1: 'ingredient',
  MetalIngredients: 'ingredient metal', MiscellaneousIngredients2: 'ingredient',
  Drugs: 'potion drug', Books: 'book tome', Currency: 'gold money coins',
  Transportation: 'mount vehicle', ReligiousItems: 'religious holy',
  UselessItems1: 'container', UselessItems2: 'misc', QuestItems: 'quest',
  Deeds: 'deed property', Furniture: 'furniture', Paintings: 'painting art',
  Maps: 'map', Jewellery: 'jewelry jewellery',
});
const ARMOR_MATERIALS = Object.freeze([
  ARMOR_MATERIAL.Leather, ARMOR_MATERIAL.Chain, ARMOR_MATERIAL.Chain2,
  ARMOR_MATERIAL.Iron, ARMOR_MATERIAL.Steel, ARMOR_MATERIAL.Silver, ARMOR_MATERIAL.Elven,
  ARMOR_MATERIAL.Dwarven, ARMOR_MATERIAL.Mithril, ARMOR_MATERIAL.Adamantium, ARMOR_MATERIAL.Ebony,
  ARMOR_MATERIAL.Orcish, ARMOR_MATERIAL.Daedric,
]);

const HELP = `DFO item catalogue — read only, no account needed

Usage:
  node item-catalog.mjs [search words...] [options]

Search matches the template name, group, template index and material. Every
word must match. Examples:
  node item-catalog.mjs daedric longsword
  node item-catalog.mjs --group Weapons --material Daedric --max-value 50000
  node item-catalog.mjs --stackable arrow
  node item-catalog.mjs --all --search dragon

Options:
  --search <text>      search words (same as passing them positionally)
  --group <name>       only groups containing name (Weapons, Armor, Gems, ...)
  --material <name>    only materials containing name (Iron..Daedric, Leather, Chain, Chain2)
  --min-value <n>      only items worth at least n gold
  --max-value <n>      only items worth at most n gold
  --stackable          only items that stack
  --max-witness <n>    only rows a run of n pine staffs can cover (30 = current cap)
  --all                include rows the item law would flag (normally hidden)
  --limit <n>          stop after n rows (default: all)
  --json               print the catalogue as JSON
  --show <index>       print the exact item object(s); add --material for one gear variant
  --stack <n>          with --show, set stackCount (stackable items only)
  --help               this text

Notes:
  • Values are the honest mint price: weapon/plate material multipliers and
    condition are applied exactly as the game's item builder applies them.
  • WIT is the number of 11,000-gold pine-staff witnesses a run needs to cover
    one item's value. A * means it is past the current 30-craft script cap.
    A stack's worth is value × stackCount (--show --stack prints the total).
  • Named Gilded weapons are included as their exact records (The Hourlock,
    The Dragonfire Oath, The Sunken Sovereign, Volendrung's Echo, The
    Ketchmaster's Word) - search "gilded" or the name. For one exact object:
    node item-catalog.mjs --show 123 dragonfire
  • The 23 artifacts are included too (Chrysamere, the Ebony Blade, Azura's
    Star, ...) - search "artifact" or the name. Their enchantment rows are
    the record's types with arbitrary params; value is 0.
  • Otherwise the catalogue lists base templates and material variants only.
    It does not enumerate rolled rarity, affixes, other enchantments or
    crafted provenance records.
  • Search also matches a few common words the template name lacks: potion,
    soul gem, gold, book, mount, clothing, ingredient, weapon, armour.
`;

const die = (why, code = 2) => { console.error(`\nrefused: ${why}\n`); process.exit(code); };

function parseArgs(argv) {
  const out = { words: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--all') out.all = true;
    else if (a === '--stackable') out.stackable = true;
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

const intArg = (name, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (args[name] == null) return null;
  const n = Number(args[name]);
  if (!Number.isSafeInteger(n) || n < min || n > max) die(`--${name} must be a whole number in ${min}..${max}`);
  return n;
};

const minValue = intArg('min-value', 0);
const maxValue = intArg('max-value', 0);
const maxWitness = intArg('max-witness', 0);
const limit = intArg('limit', 1);
const showIndex = intArg('show', 0);
const showStack = intArg('stack', 1);

if (minValue != null && maxValue != null && minValue > maxValue) die('--min-value is above --max-value');
if (showStack != null && showIndex == null) die('--stack is only used with --show');

const materialLabel = (group, material) => {
  if (material == null) return '-';
  if (group === 'Armor') {
    if (material === ARMOR_MATERIAL.Leather) return 'Leather';
    if (material === ARMOR_MATERIAL.Chain) return 'Chain';
    if (material === ARMOR_MATERIAL.Chain2) return 'Chain2';
    return MATERIAL_NAMES[material & 0xff] ?? `0x${material.toString(16)}`;
  }
  return MATERIAL_NAMES[material] ?? String(material);
};

const displayName = (baseName, group, material, label) => {
  if (material == null) return baseName;
  if (!['Weapons', 'Armor'].includes(group)) return baseName;
  if (baseName.toLowerCase().startsWith(`${label.toLowerCase()} `)) return baseName;
  return `${label} ${baseName}`;
};

const allTemplates = [...ITEM_TEMPLATES.filter(Boolean), ...customTemplateRows()]
  .sort((a, b) => a.index - b.index);

const makeItem = (template, group, material) => {
  const base = { group, templateIndex: template.index };
  if (material != null) base.material = material;
  const item = mintCondition(setItemFields(base));
  // The game's own goldStack: a pile's value is 1 and its count is the gold.
  if (group === 'Currency' && template.index === GOLD_TEMPLATE) { item.value = 1; item.stackCount = 1; }
  const findings = itemFindings(item);
  const label = materialLabel(group, material);
  const name = displayName(String(item.name ?? template.name ?? `#${template.index}`), group, material, label);
  const stackable = isStackable(item);
  const stackMax = !stackable ? 1
    : group === 'Currency' && template.index === GOLD_TEMPLATE ? GOLD_INT_MAX : LOOT_STACK_MAX;
  const value = Number.isFinite(item.value) ? item.value : 0;
  const weight = effectiveUnitWeightInKg(item);
  return {
    index: template.index,
    name,
    baseName: String(item.name ?? template.name ?? `#${template.index}`),
    group,
    material: material ?? null,
    materialLabel: label,
    value,
    weight,
    maxCondition: item.maxCondition ?? 0,
    stackable,
    stackMax,
    witness: Math.max(0, Math.ceil(value / STAFF_WITNESS)),
    tags: `${ALIASES[template.index] ?? ''} ${GROUP_TAGS[group] ?? ''}`.trim(),
    lawful: findings.length === 0,
    findings,
    item,
  };
};

// GILDED1/GILDED2/KETCH: the named Gilded weapons. They are not plain
// template rows - a record's exact affixes and gilded id are the item - so
// they are minted through the game's own `mintGilded`, not `setItemFields`.
const gildedRows = GILDED_RECORDS.map((record) => {
  const item = mintGilded(record);
  const findings = itemFindings(item);
  const value = Number.isFinite(item.value) ? item.value : 0;
  return {
    index: record.templateIndex,
    name: record.name,
    baseName: record.name,
    group: record.group,
    material: record.material,
    materialLabel: materialLabel(record.group, record.material),
    tier: 'gilded',
    record: record.id,
    power: record.power?.name ?? '',
    value,
    weight: effectiveUnitWeightInKg(item),
    maxCondition: item.maxCondition ?? 0,
    stackable: false,
    stackMax: 1,
    witness: Math.max(0, Math.ceil(value / STAFF_WITNESS)),
    tags: `gilded named ${record.id} ${record.power?.name ?? ''} ${(record.affixes ?? []).map((a) => a.id).join(' ')}`.trim(),
    lawful: findings.length === 0,
    findings,
    item,
  };
});

// The 23 DFU artifacts. The service's artifact law checks the index,
// the record's template and the enchantment TYPES - not the MAGIC.DEF
// values - so an artifact can be minted with the record's rows and any
// params; value 0 keeps it out of the wealth measure. `createArtifact`
// needs the player's MAGIC.DEF, which a headless reader does not have.
const artifactNames = ARTIFACT_SUB_TYPE_NAMES.filter(([, i]) => i >= 0);
const artifactRows = ARTIFACT_RECORDS.map((rec, i) => {
  const group = ITEM_GROUP_NAME_BY_CLASS[rec.group];
  const templateIndex = GROUP_TEMPLATE_INDICES[group]?.[rec.index];
  const name = String(artifactNames[i]?.[0] ?? `Artifact ${i}`).replaceAll('_', ' ');
  const item = {
    group, templateIndex, name,
    magic: true, artifact: true, isIdentified: true,
    artifactIndexBitfield: (i << 1) | 1,
    material: 0,
    enchantments: rec.types.map((type) => ({ type, param: type === 26 ? i : 0 })),
    maxCondition: 1000,
    currentCondition: 1000,
    value: 0,
  };
  const findings = itemFindings(item);
  const worth = itemWorth ? itemWorth(item) : 0;
  return {
    index: templateIndex,
    name,
    baseName: name,
    group,
    material: 0,
    materialLabel: 'Artifact',
    tier: 'artifact',
    record: name,
    power: '',
    value: 0,
    weight: effectiveUnitWeightInKg(item),
    maxCondition: 1000,
    stackable: false,
    stackMax: 1,
    witness: Math.max(0, Math.ceil(worth / STAFF_WITNESS)),
    tags: `artifact named relic ${name}`,
    lawful: findings.length === 0,
    findings,
    item,
  };
});

const rows = [...gildedRows, ...artifactRows];
for (const template of allTemplates) {
  for (const group of templateGroups(template.index)) {
    // DFU's Deeds enum carries no values (0,1,2), so the enum's first three
    // rows collide with Ruby/Emerald/Sapphire. No mint path writes group
    // Deeds; house and ship deeds are MiscItems 285/286.
    if (group === 'Deeds') continue;
    // MiscItems 276 is DFU's `Unused` slot - the same template as the
    // Currency's Gold_pieces, but not an item a character can hold.
    if (group === 'MiscItems' && template.index === GOLD_TEMPLATE) continue;
    if (group === 'Weapons' && !isAmmunition({ templateIndex: template.index })) {
      for (const material of WEAPON_MATERIALS) rows.push(makeItem(template, group, material));
    } else if (group === 'Armor') {
      for (const material of ARMOR_MATERIALS) rows.push(makeItem(template, group, material));
    } else {
      rows.push(makeItem(template, group, null));
    }
  }
}

const terms = `${(args.words ?? []).join(' ')} ${args.search ?? ''}`.trim().toLowerCase().split(/\s+/).filter(Boolean);
const groupFilter = String(args.group ?? '').trim().toLowerCase();
const materialFilter = String(args.material ?? '').trim().toLowerCase();

const matches = (row) => {
  if (!args.all && !row.lawful) return false;
  if (args.stackable && !row.stackable) return false;
  if (groupFilter && !row.group.toLowerCase().includes(groupFilter)) return false;
  if (materialFilter && ![row.materialLabel, String(row.material ?? ''), row.material == null ? '' : `0x${row.material.toString(16)}`]
    .some((v) => String(v).toLowerCase().includes(materialFilter))) return false;
  if (minValue != null && row.value < minValue) return false;
  if (maxValue != null && row.value > maxValue) return false;
  if (maxWitness != null && row.witness > maxWitness) return false;
  if (terms.length) {
    const hay = `${row.index} ${row.name} ${row.baseName} ${row.group} ${row.materialLabel} ${row.tags}`.toLowerCase();
    if (!terms.every((term) => hay.includes(term))) return false;
  }
  return true;
};

let found = rows.filter(matches);
if (showIndex != null) found = found.filter((row) => row.index === showIndex);
if (!found.length && showIndex != null && !args.all) {
  const hidden = rows.find((row) => row.index === showIndex);
  if (hidden && !hidden.lawful) die(`template ${showIndex} (${hidden.name}) is flagged by itemLaw: ${hidden.findings.join(', ')}; pass --all to print it anyway`);
}
const hiddenCount = args.all ? 0 : rows.filter((row) => !row.lawful).length;
if (!found.length) {
  const what = showIndex != null ? `template ${showIndex}` : (terms.join(' ') || 'those filters');
  die(`no item matched ${what}`);
}
if (limit != null && found.length > limit) found = found.slice(0, limit);

const stackWith = (row) => {
  if (showStack == null) return row.item;
  if (!row.stackable) die(`${row.name} does not stack; --stack is not lawful on it`);
  if (showStack > row.stackMax) die(`${row.name} stacks to ${row.stackMax.toLocaleString('en-US')}; --stack ${showStack} is past the law`);
  if (showStack > 1) {
    const total = row.value * showStack;
    const witness = Math.ceil(total / STAFF_WITNESS);
    console.error(`note: ${showStack.toLocaleString('en-US')} x ${row.value.toLocaleString('en-US')} = ${total.toLocaleString('en-US')} gold; about ${witness} staff witness${witness === 1 ? '' : 'es'}.`);
  }
  return showStack > 1 ? { ...row.item, stackCount: showStack } : row.item;
};

if (args.show !== undefined) {
  for (const row of found) {
    if (!row.lawful) console.error(`note: ${row.name} is flagged by itemLaw: ${row.findings.join(', ')}`);
  }
  const items = found.map((row) => stackWith(row));
  console.log(JSON.stringify(items.length === 1 ? items[0] : items, null, 2));
  process.exit(0);
}

if (args.json) {
  const json = JSON.stringify(found.map(({ item, ...row }) => ({ ...row, item })), null, 2);
  // A large JSON write must finish before exit: process.exit() can truncate a
  // pipe at 64 KiB. Wait for the write's callback, then exit.
  process.stdout.write(json + '\n', () => process.exit(0));
  await new Promise(() => {});
}

const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const num = (n) => n.toLocaleString('en-US');
const stackLabel = (row) => {
  if (!row.stackable) return '-';
  if (row.stackMax >= 1_000_000_000) return `Y ${(row.stackMax / 1_000_000_000).toFixed(1)}B`;
  return `Y ${num(row.stackMax)}`;
};
const cols = [
  { key: 'index', title: 'IDX', width: 5, right: true },
  { key: 'materialLabel', title: 'MAT', width: 9 },
  { key: 'name', title: 'ITEM', width: 37 },
  { key: 'group', title: 'GROUP', width: 19 },
  { key: 'value', title: 'VALUE', width: 11, right: true },
  { key: 'weight', title: 'KG', width: 7, right: true },
  { key: 'stack', title: 'STACK', width: 11 },
  { key: 'witness', title: 'WIT', width: 5, right: true },
  { key: 'law', title: 'LAW', width: 4 },
];
const line = (cells) => cells.map((c, i) => {
  const text = trunc(String(c), cols[i].width);
  return cols[i].right ? text.padStart(cols[i].width) : text.padEnd(cols[i].width);
}).join('  ').trimEnd();

console.log(line(cols.map((c) => c.title)));
console.log(cols.map((c) => '-'.repeat(c.width)).join('  '));
for (const row of found) {
  console.log(line([
    row.index,
    row.tier === 'gilded' ? 'Gilded' : row.tier === 'artifact' ? 'Artifact' : row.materialLabel,
    row.name,
    row.group,
    num(row.value),
    row.weight.toFixed(2),
    stackLabel(row),
    `${num(row.witness)}${row.witness > SCRIPT_MAX_CRAFTS ? '*' : ''}`,
    row.lawful ? 'ok' : '!!',
  ]));
}
const lawful = found.filter((row) => row.lawful).length;
console.log(`\n${found.length} row${found.length === 1 ? '' : 's'} (${lawful} lawful${found.length > lawful ? `, ${found.length - lawful} flagged` : ''})`);
console.log(`WIT = pine-staff witnesses at ${num(STAFF_WITNESS)} each for one unit; * is past the current ${SCRIPT_MAX_CRAFTS}-craft cap.`);
console.log('A stack multiplies the worth, and therefore the witnesses, by its stackCount.');
if (hiddenCount) console.log(`${hiddenCount} flagged row${hiddenCount === 1 ? '' : 's'} hidden; --all shows ${hiddenCount === 1 ? 'it' : 'them'}.`);
console.log('Base templates, material variants, named Gilded records and the 23 artifacts only; rolled affixes, other enchantments and provenance are not listed.');
console.log('Use --show <index> [--material <name>] [--stack <n>] for the exact item object.');
