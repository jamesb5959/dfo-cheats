# Daggerfall Online Cheats/Exploits/Hacks

## Start here

```bash
./dfo-token.sh          # once, or when the session expires
./dfo_tui.py            # the control panel
```

The TUI covers:

- **AUTOMATION — run everything**: one confirm, then the character package,
  ship sale, daily finds, remote gather, custom classic item and any
  affordable gold run, with a combined log; a separate gun preset gives an
  Iron Thunderlock and 100 pellets when 12 Marks are held
- status, silver, Aurum, Sigil Stones, character gold
- item catalogue search, exact item give (including the 23 artifacts)
- gold / bank / settle-loan runs
- earn: daily Marks finds, remote gathering (the service checks the node,
  not your position), market buy orders/listings, Aurum cache claims, Court
  writs (own/bought Stores)
- player save edits: level, stats, skills, pools, carry weight, factions,
  legal rep, loans/defaults, ship/house deeds, region prices, spell buffs,
  item removal, raw paths
- account cosmetics: wear held titles/glyphs/auras/icons/effects/armory,
  buy shop wares with Aurum

## Scripts

| Script | Purpose |
|---|---|
| `live-arrived-worth.mjs` | crafted-arrival witness; bank/purse gold; exact item give |
| `live-player-edit.mjs` | character save fields (stats, skills, level, pools, spells, factions, raw set, direct item append) |
| `make-max-items.mjs` | one-checkpoint maxed Thunderlock, Dragonfire Oath and pellets |
| `make-max-wearables.mjs` | full Daedric armour, shield, jewellery and weapon set |
| `make-power-pack.mjs` | regen/ward rings, all 23 artifacts and elemental Instakill spells |
| `make-stat-max.mjs` | live attributes 5,100/10,100, 50k pools, Blade skill jewellery |
| `item-catalog.mjs` | lawful item catalogue, search, exact item JSON |
| `player-catalog.mjs` | read-only account wardrobe, cosmetics and currencies |
| `dfo_tui.py` | curses control panel |

## Gold and items

```bash
# one staff witnesses 11,000; 26 staffs = 286,000 (156 Marks)
node live-arrived-worth.mjs --crafts 26 --bank 286000 --apply

# one item, exact object from the catalogue
node item-catalog.mjs --show 123 dragonfire > /tmp/opencode/df.json
node live-arrived-worth.mjs --give-json /tmp/opencode/df.json --apply
```

The `bank + gold` total is capped at `crafts × 11,000`. The bank field
itself holds up to 2,147,483,647; the cap is the witnessed arrival, not the
field. The arrow recipe can witness 760,730,280 with a 65,535 stack, but
needs one pine plank, one iron ingot and four northern twigs.

The catalogue now includes all 23 artifacts:

```bash
node item-catalog.mjs --search artifact
node item-catalog.mjs --show 122 chrysamere
```

The artifact's enchantment types are the record's; its params and value are
the client's. The law accepts value 0, so one staff (6 Marks) covers it.

### Guns

The port's two guns are ordinary custom weapon templates the item law
knows: the **Dwarven Thunderlock** (560) and the **Dwarven Pistolet**
(562). Both spend the **Dwemer Pellet** (561), and both can be duplicated,
enchanted or given like any weapon:

```bash
node item-catalog.mjs --show 560 dwarven
node live-arrived-worth.mjs --give 560 --give-material dwarven   # 23,040 worth, 3 staffs / 18 Marks
node live-arrived-worth.mjs --give 562 --give-material dwarven   # 12,480 worth, 2 staffs / 12 Marks
node live-arrived-worth.mjs --give 561 --give-stack 100           # pellets, 4 each
```

An Iron Thunderlock is 1,440 worth (one staff / 6 Marks); Iron Pistolet
780 (one staff). The Gilded records `volendrungs-echo` (a Thunderlock)
and `the-ketchmasters-word` (a Pistolet) are given with `--give-gilded`.
The Hourlock is a gilded **Long Bow** (130) in the current mint; its old
gun shape (560) is lawful only as originally minted (`HOURLOCK_GUN_ERA`).

The strongest made gun is a **Daedric Thunderlock** with nine
`CastWhenStrikes` rows at `param: 32` (Gods' Fire), appended directly with
no staff. At level 31 each row is 311–360 Damage Health a round for 32
rounds; nine rows land per blow. `reports/DFO-2026-10-31-guns.md` has the
exact JSON. The TUI custom builder can make it: Items → `c`, template 560,
material 9, type 2, param 32, magnitude/duration 999, chance 100, then
choose the direct insert.

## Max items script

```bash
node make-max-items.mjs            # dry run; writes the JSON
node make-max-items.mjs --apply    # one checkpoint, no staffs
node make-max-items.mjs --max-gear # also Ring of the Eight + maxed Dai-Katana
node make-max-items.mjs --custom-oath   # plain Daedric Dai-Katana, nine Gods' Fire rows
node make-max-items.mjs --force    # append even if already held
```

It makes:

- **Daedric Dwarven Thunderlock** — nine `CastWhenStrikes` rows at `param 32`
  (Gods' Fire), material 9, 12,800 condition.
- **The Dragonfire Oath** — the exact Gilded Daedric Dai-Katana record:
  +40 damage, +15 Strength, +30 Long Blade, +15 Endurance and the Dragonfire
  power. The record is already its top band; the item law forbids extra rows
  on a Gilded piece. `--custom-oath` swaps it for a plain Daedric Dai-Katana
  with nine Gods' Fire rows — more offence, no Gilded affixes or power.
- **65,535 Dwemer Pellets**.
- With `--max-gear`: a **Ring of the Eight** — nine `CastWhenHeld` rows,
  the eight attribute fortifies (Orc Strength, Wisdom, Iron Will,
  Nimbleness, Feet of Notorgo, Fortitude, Charisma, Jack of Trades) plus
  Shield, 1,000,000 condition — and a plain **Daedric Dai-Katana** with nine
  Gods' Fire rows.

The script skips an item already held (by Gilded id or template/material/
enchantment signature); `--force` duplicates it. It appends all items in
one checkpoint through `--append-item`, so it needs no planks, staffs or
Marks. The checkpoint's wealth measure still sees the worth: `measure`
finding with enforcement off, hold with it on.

## Max wearables script

```bash
node make-max-wearables.mjs             # dry run
node make-max-wearables.mjs --apply     # one checkpoint
```

It appends the full Daedric combat set:

- seven armour pieces — cuirass, gauntlets, greaves, both pauldrons, helm,
  boots — each with nine `CastWhenHeld` rows (the eight attribute fortifies
  plus Shield);
- a Daedric Tower Shield with the same nine rows;
- ten jewellery pieces — two each of amulet, bracer, ring, bracelet, mark —
  with the same nine rows;
- nineteen Daedric weapons — every weapon template except the already maxed
  Dai-katana and Thunderlock — each with nine `CastWhenStrikes` rows at
  Gods’ Fire (spell 32);
- 65,535 arrows for the bows.

All items are 1,000,000 condition so the held spells’ equip bill and the
weapons’ 90-condition strike cost do not break them quickly. The held spells
refresh rather than stack across pieces; the armour value is the set’s main
gain. Use `--no-armor`, `--no-jewelry` or `--no-weapons` to skip a group.

## Power pack

```bash
node make-power-pack.mjs            # dry run
node make-power-pack.mjs --apply    # one checkpoint
```

It adds:

- **Ring of Regeneration** — nine `RegensHealth` rows, 1,000,000 condition
- **Ring of Warding** — one `AbsorbsSpells` row and eight `RegensHealth` rows
- **All 23 artifacts** from the catalogue
- **Instakill (Fire/Frost/Shock)** — 2,147,483,647 Damage Health, fixed 5 magicka
- Raises the original **Instakill** to 2,147,483,647 magnitude

Sockets were probed: a custom Legendary is flagged `legendary`; sockets are only
lawful on Rare/Legendary records, which means dropping the nine-row path. It is
a trade-off, not a raw-power upgrade, so no weaker socketed item was added.

## Stat max

```bash
node make-stat-max.mjs            # dry run
node make-stat-max.mjs --apply    # one checkpoint
```

It raises the live attributes beyond the previous 500: `activeEffects`
fortify values to 5,000 (strength 10,000) with matching `statMaxMods`, so
`liveStat` reads 5,100 (strength 10,100) and carry is 15,150 kg. It also sets
health/magicka/fatigue to 50,000 and adds ten jewellery pieces with nine
`EnhancesSkill` rows each for Long Blade (+135 per piece, +1,350 for the full
set). Equip the Blade jewellery to receive the skill mod. The character judge
still sees base stats 100 and skills 200; the live values are outside it.

A classic item is accepted with ten enchantment slots: nine arbitrary rows
and one `None`. A Daedric Dagger with nine `CastWhenStrikes` rows at high
magnitude/duration/chance passes the law; one staff covers its 1,536 base
worth. `reports/DFO-2026-10-31-custom-enchanted.md` has the shape.

## Player save

```bash
node live-player-edit.mjs --level 45 --stats all=100 --skills all=100
node live-player-edit.mjs --max-health 5000 --max-magicka 5000
node live-player-edit.mjs --max-character
node live-player-edit.mjs --carry-weight 1000
node live-player-edit.mjs --append-item /tmp/opencode/gun.json
node live-player-edit.mjs --spell-buff "Arcane Arrow" --spell-factor 5
node live-player-edit.mjs --set maxHealth=9000 --set stats.strength=100
```

`--append-item` appends one lawful item object to the pack and sends the
checkpoint directly, with no staff. The item law still runs; the checkpoint's
wealth measure still sees the item's worth, so with `budget.enforce` off it
passes as a measure finding and with it on it holds. In the TUI, `i` on a
catalogue row inserts directly; `g` uses the staff path.

Carry weight is `floor(liveStrength × 1.5)` kg, plus any
IncreasedWeightAllowance multiplier. Strength 100 is 150 kg. Base stats
are judged 0..100, so `--carry-weight` writes a permanent
`fortifyAttribute` entry for strength with a matching `statMaxMods`
lift; `liveStat` sums both, so 1000 kg asks for strength 667. The
character judge does not read `activeEffects`. Re-running the option
replaces its own `dfo-carry` entry rather than stacking.

`--max-character` sets level 45, stats 100, skills 200 (the judge's cap),
health/magicka/fatigue 5000 and eight permanent `fortifyAttribute` effects:
strength 667 (1,000 kg) and 500 in every other attribute, with
`statMaxMods` lifting the caps. It replaces the `dfo-` effects rather than
stacking them. The Player edit “Everything” preset uses it.

The Player edit **Add Instakill spell** appends a custom spell with one
Damage Health effect at magnitude 1,000,000, range 2, element 4, stored
cost 5 and `minimumCastingCost: true`. The flag is what makes the cast cost
exactly 5: without it the engine prices the 1,000,000 magnitude and the
spellbook dims it as unaffordable. The character judge does not read
`spells`. The same object is in `/tmp/opencode/instakill-spell.json`;
append it with `--set "spells.<n>=..."` at the current spell count.

Judged: level 1..45, stats 0..100, skills 0..200, starting skill sum,
arcane path, items/provenance, arms, dragons, gold/bank shape.
Not judged (candidates): maxHealth, maxMagicka, spells, activeEffects,
factionRep, legalRep, guild memberships and most quest/world state.
