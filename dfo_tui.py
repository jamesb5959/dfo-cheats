#!/usr/bin/env python3
"""DFO control panel — a curses TUI over the scripts in this folder.

Read-only unless you press 'a' on a dry run and confirm. The item and
player editors are dry-run by default; account cosmetics are the service's
own rows and can only be worn/bought, never granted.
"""

import curses
import json
import os
import re
import secrets
import subprocess
import sys
import textwrap
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / ".config"
CACHE_DIR = Path("/tmp/opencode/dfo-tui-cache")
NODE = os.environ.get("DFO_NODE", "node")
TIMEOUT = 300
DEFAULT_BASE = "https://daggerfall-accounts.mackcothran.workers.dev"

C_HEAD = 1
C_GOOD = 2
C_WARN = 3
C_BAD = 4
C_SEL = 5
C_DIM = 6

_items_cache = None
_player_cache = None
_writs_cache = None
_writs_at = 0


def cache_read(name, max_age):
    try:
        p = CACHE_DIR / name
        if time.time() - p.stat().st_mtime > max_age:
            return None
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def cache_write(name, value):
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        (CACHE_DIR / name).write_text(json.dumps(value), encoding="utf-8")
    except OSError:
        pass


# ── config and HTTP ──────────────────────────────────────────────────
def read_config():
    token = ""
    base = DEFAULT_BASE
    try:
        text = CONFIG.read_text(encoding="utf-8")
    except OSError:
        return token, base
    for line in text.splitlines():
        m = re.match(r"^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$", line)
        if not m:
            continue
        key, val = m.group(1), m.group(2)
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "'\"":
            val = val[1:-1]
        if key == "DFO_TOKEN":
            token = val
        elif key == "DFO_BASE_URL":
            base = val.rstrip("/")
    return token, base or DEFAULT_BASE


def api(method, path, body=None):
    token, base = read_config()
    if not token:
        raise RuntimeError("no DFO_TOKEN in .config; run ./dfo-token.sh")
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        base + path,
        data=data,
        method=method,
        headers={
            "authorization": "Bearer " + token,
            "accept": "application/json",
            # Cloudflare's browser-integrity check refuses Python-urllib's
            # default signature with error 1010.
            "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
            **({"content-type": "application/json"} if body is not None else {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            text = res.read().decode("utf-8")
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(text)
            raise RuntimeError(f"{e.code}: {parsed.get('error', text)[:300]}")
        except json.JSONDecodeError:
            raise RuntimeError(f"{e.code}: {text[:300]}")
    except urllib.error.URLError as e:
        raise RuntimeError(str(e.reason))


# ── Node runners ─────────────────────────────────────────────────────
def run_node(args, timeout=TIMEOUT):
    try:
        proc = subprocess.run(
            [NODE, *args],
            cwd=str(ROOT),
            text=True,
            capture_output=True,
            timeout=timeout,
        )
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout}s"
    except FileNotFoundError:
        return 127, "", f"{NODE} not found"


def load_items():
    global _items_cache
    if _items_cache is not None:
        return _items_cache
    cached = cache_read("items.json", 3600)
    if cached is not None:
        _items_cache = cached
        return cached
    code, out, err = run_node(["item-catalog.mjs", "--json"], 120)
    if code != 0:
        raise RuntimeError((err or out or f"exit {code}")[:500])
    _items_cache = json.loads(out)
    cache_write("items.json", _items_cache)
    return _items_cache


def load_player():
    global _player_cache
    code, out, err = run_node(["player-catalog.mjs", "--json"], 120)
    if code != 0:
        raise RuntimeError((err or out or f"exit {code}")[:500])
    _player_cache = json.loads(out)
    return _player_cache


# ── curses helpers ───────────────────────────────────────────────────
def init_colors():
    if not curses.has_colors():
        return
    curses.start_color()
    try:
        curses.use_default_colors()
    except curses.error:
        pass
    curses.init_pair(C_HEAD, curses.COLOR_CYAN, -1)
    curses.init_pair(C_GOOD, curses.COLOR_GREEN, -1)
    curses.init_pair(C_WARN, curses.COLOR_YELLOW, -1)
    curses.init_pair(C_BAD, curses.COLOR_RED, -1)
    curses.init_pair(C_SEL, curses.COLOR_BLACK, curses.COLOR_CYAN)
    curses.init_pair(C_DIM, curses.COLOR_WHITE, -1)


def attr(pair, extra=0):
    return curses.color_pair(pair) | extra if curses.has_colors() else extra


def put(win, y, x, text, a=0):
    h, w = win.getmaxyx()
    if y < 0 or y >= h or x >= w:
        return
    if x < 0:
        text = text[-x:]
        x = 0
    room = w - x
    if room <= 0:
        return
    try:
        win.addnstr(y, x, str(text), room, a)
    except curses.error:
        pass


def busy(stdscr, text="loading…"):
    h, w = stdscr.getmaxyx()
    stdscr.erase()
    put(stdscr, max(0, h // 2), max(0, (w - len(text)) // 2), text, attr(C_WARN, curses.A_BOLD))
    footer(stdscr, "this can take a few seconds")
    stdscr.refresh()


def header(stdscr, title, sub=""):
    stdscr.erase()
    h, w = stdscr.getmaxyx()
    put(stdscr, 0, 0, title.ljust(max(0, w - 1)), attr(C_HEAD, curses.A_BOLD))
    if sub:
        put(stdscr, 1, 0, sub[: max(0, w - 1)], curses.A_DIM)
    try:
        stdscr.hline(2, 0, curses.ACS_HLINE, w)
    except curses.error:
        pass


def footer(stdscr, text):
    h, w = stdscr.getmaxyx()
    put(stdscr, h - 1, 0, text[: max(0, w - 1)], curses.A_DIM)


def wait_key(stdscr, text):
    h, w = stdscr.getmaxyx()
    put(stdscr, h - 1, 0, text[: max(0, w - 1)], attr(C_WARN, curses.A_BOLD))
    stdscr.refresh()
    stdscr.getch()


def prompt(stdscr, label, default=""):
    h, w = stdscr.getmaxyx()
    y = min(h - 2, 4)
    stdscr.move(y, 0)
    stdscr.clrtoeol()
    put(stdscr, y, 0, label + ": ", attr(C_WARN, curses.A_BOLD))
    x = len(label) + 2
    buf = ""
    try:
        curses.curs_set(1)
    except curses.error:
        pass
    stdscr.timeout(-1)
    while True:
        put(stdscr, y, x, (buf or default)[: max(0, w - x - 1)], curses.A_NORMAL)
        stdscr.move(y, min(w - 2, x + len(buf or default)))
        stdscr.refresh()
        ch = stdscr.getch()
        if ch in (10, 13):
            try:
                curses.curs_set(0)
            except curses.error:
                pass
            return buf if buf else default
        if ch == 27:
            try:
                curses.curs_set(0)
            except curses.error:
                pass
            return None
        if ch in (8, 127, curses.KEY_BACKSPACE):
            buf = buf[:-1]
        elif ch == 21:  # Ctrl-U
            buf = ""
        elif 32 <= ch < 127:
            if len(buf) < 600:
                buf += chr(ch)


def confirm(stdscr, text):
    h, w = stdscr.getmaxyx()
    put(stdscr, h - 1, 0, (text + " [y/N] ")[: max(0, w - 1)], attr(C_WARN, curses.A_BOLD))
    stdscr.refresh()
    ch = stdscr.getch()
    return ch in (ord("y"), ord("Y"))


def wrap_lines(text, width):
    out = []
    for line in (text or "").splitlines() or [""]:
        if not line:
            out.append("")
            continue
        out.extend(textwrap.wrap(line, max(10, width), replace_whitespace=False, drop_whitespace=False) or [""])
    return out


def show_output(stdscr, title, text, allow_apply=False):
    lines = wrap_lines(text, max(20, stdscr.getmaxyx()[1] - 4))
    top = 0
    while True:
        header(stdscr, title, "output")
        h, w = stdscr.getmaxyx()
        body = h - 4
        for i in range(body):
            idx = top + i
            if idx >= len(lines):
                break
            put(stdscr, 3 + i, 0, lines[idx][: max(0, w - 1)])
        more = ""
        if top + body < len(lines):
            more = f"  ({top + body}/{len(lines)})"
        footer(stdscr, ("↑↓/PgUp/PgDn scroll  " + ("a apply  " if allow_apply else "") + "q back" + more))
        stdscr.refresh()
        ch = stdscr.getch()
        if ch in (ord("q"), 27):
            return None
        if allow_apply and ch in (ord("a"), ord("A")):
            return "apply"
        if ch in (curses.KEY_UP, ord("k")):
            top = max(0, top - 1)
        elif ch in (curses.KEY_DOWN, ord("j")):
            top = min(max(0, len(lines) - body), top + 1)
        elif ch == curses.KEY_PPAGE:
            top = max(0, top - body)
        elif ch == curses.KEY_NPAGE:
            top = min(max(0, len(lines) - body), top + body)
        elif ch == curses.KEY_HOME:
            top = 0
        elif ch == curses.KEY_END:
            top = max(0, len(lines) - body)


def menu(stdscr, title, sub, items, foot="↑↓ choose  Enter select  q back"):
    sel = 0
    top = 0
    while True:
        header(stdscr, title, sub)
        h, w = stdscr.getmaxyx()
        body = h - 4
        if sel < top:
            top = sel
        if sel >= top + body:
            top = sel - body + 1
        for i in range(body):
            idx = top + i
            if idx >= len(items):
                break
            mark = "> " if idx == sel else "  "
            a = attr(C_SEL, curses.A_BOLD) if idx == sel else curses.A_NORMAL
            put(stdscr, 3 + i, 0, (mark + items[idx])[: max(0, w - 1)], a)
        footer(stdscr, foot)
        stdscr.refresh()
        ch = stdscr.getch()
        if ch in (ord("q"), 27):
            return -1
        if ch in (curses.KEY_UP, ord("k")):
            sel = max(0, sel - 1)
        elif ch in (curses.KEY_DOWN, ord("j")):
            sel = min(len(items) - 1, sel + 1)
        elif ch == curses.KEY_PPAGE:
            sel = max(0, sel - body)
        elif ch == curses.KEY_NPAGE:
            sel = min(len(items) - 1, sel + body)
        elif ch == curses.KEY_HOME:
            sel = 0
        elif ch == curses.KEY_END:
            sel = len(items) - 1
        elif ch in (10, 13):
            return sel


def run_and_apply(stdscr, title, args):
    header(stdscr, title, "running — this can take a while")
    footer(stdscr, "please wait…")
    stdscr.refresh()
    code, out, err = run_node(args)
    text = (out + ("\n" + err if err else "")).strip()
    action = show_output(stdscr, title + (" — failed" if code else ""), text or f"(exit {code})", allow_apply=(code == 0))
    if action == "apply":
        header(stdscr, title + " — APPLY", "sending…")
        footer(stdscr, "please wait…")
        stdscr.refresh()
        code2, out2, err2 = run_node(args + ["--apply"])
        global _player_cache
        _player_cache = None
        show_output(stdscr, title + " — applied", (out2 + ("\n" + err2 if err2 else "")).strip() or f"(exit {code2})")
    return code, text


# ── status ───────────────────────────────────────────────────────────
def status_screen(stdscr):
    if _player_cache is None:
        busy(stdscr, "Reading the account…")
    try:
        data = load_player()
    except Exception as e:
        show_output(stdscr, "Status failed", str(e))
        return
    acct = data.get("account") or {}
    if not acct:
        show_output(stdscr, "Status", "Account not read. Check .config / token.")
        return
    worn = acct.get("worn") or {}
    lines = [
        f"account        {acct.get('name')} ({acct.get('handle')})  {acct.get('kind')}",
        f"silver (Marks) {acct.get('silver')}",
        f"Aurum          {acct.get('aurum')}",
        f"Sigil Stones   {acct.get('sigilStones')}",
        f"gold           {acct.get('gold')} purse / {acct.get('bank')} bank  ({(acct.get('character') or {}).get('name')})",
        f"carry          {acct.get('carry')} kg",
        f"renown         level {(acct.get('renown') or {}).get('level')} ({(acct.get('renown') or {}).get('xp')} xp)",
        f"dragons        {(acct.get('dragons') or {}).get('slain', 0)} slain / {(acct.get('dragons') or {}).get('tamed', 0)} tamed",
        "",
        f"title          {worn.get('title') or 'none'}",
        f"glyphs         {', '.join(worn.get('glyphs') or []) or 'none'}",
        f"aura           {worn.get('aura') or 'none'}",
        f"icon           {worn.get('icon') or 'face (none)'}",
        f"armory         {json.dumps(worn.get('armory') or {})}",
        f"effects        {json.dumps(worn.get('effects') or {})}",
        "",
        f"catalogue rows {len(data.get('rows') or [])}",
        "",
        *(["Marks are 0: item gives and gold runs need Marks to buy staffs.",
           "The Player save edit is free and needs no Marks."] if acct.get("silver") == 0 else []),
        "Account things are service-side: silver/Aurum/Sigil Stones, titles,",
        "glyphs, auras, icons, effects and dragon tames cannot be granted here.",
        "Use the Account screen to wear what you hold or buy with Aurum.",
    ]
    show_output(stdscr, "Status", "\n".join(lines))


# ── items ────────────────────────────────────────────────────────────
def item_label(row):
    mat = row.get("materialLabel") or "-"
    tier = "GILDED " if row.get("tier") == "gilded" else ""
    return f"{row.get('index'):>5}  {mat:<9}  {tier}{row.get('name')}"


def item_detail(row):
    lines = [
        f"index       {row.get('index')}",
        f"name        {row.get('name')}",
        f"group       {row.get('group')}",
        f"material    {row.get('materialLabel')} ({row.get('material')})",
        f"value       {row.get('value')}",
        f"weight      {row.get('weight')} kg",
        f"condition   {row.get('maxCondition')}",
        f"stackable   {row.get('stackable')} {('max ' + str(row.get('stackMax'))) if row.get('stackable') else ''}",
        f"witness     {row.get('witness')} pine staff(s)",
        f"lawful      {row.get('lawful')}  {row.get('findings') or ''}",
        "",
        "item object:",
        json.dumps(row.get("item"), indent=2),
    ]
    return "\n".join(lines)


def give_item(stdscr, row):
    item = json.loads(json.dumps(row.get("item") or {}))
    if not item:
        wait_key(stdscr, "no item object on this row")
        return
    name = row.get("name") or item.get("name") or item.get("templateIndex")
    stack = None
    if row.get("stackable"):
        raw = prompt(stdscr, f"stack count for {name} (1..{row.get('stackMax')})", "1")
        if raw is None:
            return
        try:
            stack = int(raw)
        except ValueError:
            wait_key(stdscr, "not a number")
            return
        if stack < 1 or stack > int(row.get("stackMax") or 1):
            wait_key(stdscr, "stack out of range")
            return
        if stack > 1:
            item["stackCount"] = stack
    crafts = prompt(stdscr, "staff crafts (0 = auto from item worth)", "0")
    if crafts is None:
        return
    try:
        crafts = int(crafts)
    except ValueError:
        wait_key(stdscr, "not a number")
        return
    allow = False
    if not row.get("lawful"):
        if not confirm(stdscr, f"{name} is flagged ({', '.join(row.get('findings') or [])}). Send with --allow-flagged?"):
            return
        allow = True
    if int(row.get("index") or -1) == 1820:
        if not confirm(stdscr, "Dwarven Dragon: the service will hold this (no tame). Send anyway?"):
            return
    tmp = Path("/tmp/opencode")
    tmp.mkdir(parents=True, exist_ok=True)
    path = tmp / "dfo-give-item.json"
    path.write_text(json.dumps(item, indent=2), encoding="utf-8")
    args = ["live-arrived-worth.mjs", "--give-json", str(path)]
    if crafts > 0:
        args += ["--crafts", str(crafts)]
    if allow:
        args += ["--allow-flagged"]
    run_and_apply(stdscr, f"Give {name}", args)


def insert_item(stdscr, row):
    item = json.loads(json.dumps(row.get("item") or {}))
    if not item:
        wait_key(stdscr, "no item object on this row")
        return
    name = row.get("name") or item.get("name") or item.get("templateIndex")
    if row.get("stackable"):
        raw = prompt(stdscr, f"stack count for {name} (1..{row.get('stackMax')})", "1")
        if raw is None:
            return
        try:
            stack = int(raw)
        except ValueError:
            wait_key(stdscr, "not a number")
            return
        if stack < 1 or stack > int(row.get("stackMax") or 1):
            wait_key(stdscr, "stack out of range")
            return
        if stack > 1:
            item["stackCount"] = stack
    tmp = Path("/tmp/opencode")
    tmp.mkdir(parents=True, exist_ok=True)
    path = tmp / "dfo-insert-item.json"
    path.write_text(json.dumps(item, indent=2), encoding="utf-8")
    run_and_apply(stdscr, f"Insert {name} — no staff", ["live-player-edit.mjs", "--append-item", str(path)])


def items_screen(stdscr):
    if _items_cache is None:
        busy(stdscr, "Loading the item catalogue…")
    try:
        rows = load_items()
    except Exception as e:
        show_output(stdscr, "Item catalogue failed", str(e))
        return
    query = ""
    sel = 0
    while True:
        terms = query.lower().split()
        visible = []
        for r in rows:
            hay = f"{r.get('index')} {r.get('name')} {r.get('group')} {r.get('materialLabel')} {r.get('tier') or ''}".lower()
            if all(t in hay for t in terms):
                visible.append(r)
        if not visible:
            sel = 0
        else:
            sel = min(sel, len(visible) - 1)
        header(stdscr, "Items — search & give", f"{len(visible)} / {len(rows)} rows   query: {query or '(all)'}")
        h, w = stdscr.getmaxyx()
        body = h - 5
        top = max(0, sel - body + 1) if sel >= body else 0
        for i in range(body):
            idx = top + i
            if idx >= len(visible):
                break
            r = visible[idx]
            mark = "> " if idx == sel else "  "
            a = attr(C_SEL, curses.A_BOLD) if idx == sel else curses.A_NORMAL
            put(stdscr, 3 + i, 0, (mark + item_label(r))[: max(0, w - 1)], a)
        if visible:
            r = visible[sel]
            foot = f"value {r.get('value')}  witness {r.get('witness')}  {'LAWFUL' if r.get('lawful') else 'FLAGGED: ' + ', '.join(r.get('findings') or [])}"
        else:
            foot = "no match"
        footer(stdscr, "↑↓ choose  / search  v details  g give (staff)  i insert (no staff)  c custom  q back   |  " + foot)
        stdscr.refresh()
        ch = stdscr.getch()
        if ch in (ord("q"), 27):
            return
        if ch in (curses.KEY_UP, ord("k")):
            sel = max(0, sel - 1)
        elif ch in (curses.KEY_DOWN, ord("j")):
            sel = min(max(0, len(visible) - 1), sel + 1)
        elif ch == curses.KEY_PPAGE:
            sel = max(0, sel - body)
        elif ch == curses.KEY_NPAGE:
            sel = min(max(0, len(visible) - 1), sel + body)
        elif ch == curses.KEY_HOME:
            sel = 0
        elif ch == curses.KEY_END:
            sel = max(0, len(visible) - 1)
        elif ch in (ord("/"),):
            q = prompt(stdscr, "search")
            if q is not None:
                query = q
                sel = 0
        elif ch in (ord("v"),) and visible:
            show_output(stdscr, "Item", item_detail(visible[sel]))
        elif ch in (ord("g"),) and visible:
            give_item(stdscr, visible[sel])
        elif ch in (ord("i"),) and visible:
            insert_item(stdscr, visible[sel])
        elif ch == ord("c"):
            custom_item_screen(stdscr)


def custom_item_screen(stdscr):
    group = prompt(stdscr, "group", "Weapons")
    if group is None:
        return
    template = prompt(stdscr, "template index", "113")
    if template is None:
        return
    material = prompt(stdscr, "material (number)", "9")
    if material is None:
        return
    name = prompt(stdscr, "item name", "Dagger")
    if name is None:
        return
    etype = prompt(stdscr, "effect type (2 = CastWhenStrikes)", "2")
    if etype is None:
        return
    param = prompt(stdscr, "effect param", "0")
    if param is None:
        return
    magnitude = prompt(stdscr, "magnitude", "999")
    if magnitude is None:
        return
    duration = prompt(stdscr, "duration", "999")
    if duration is None:
        return
    chance = prompt(stdscr, "chance", "100")
    if chance is None:
        return
    try:
        template, material, etype, param = int(template), int(material), int(etype), int(param)
        magnitude, duration, chance = int(magnitude), int(duration), int(chance)
    except ValueError:
        wait_key(stdscr, "numbers only")
        return
    row = lambda: {
        "type": etype, "param": param,
        "durationBase": duration, "durationMod": 0, "durationPerLevel": 0,
        "chanceBase": chance, "chanceMod": 0, "chancePerLevel": 0,
        "magnitudeBaseLow": magnitude, "magnitudeBaseHigh": magnitude,
        "magnitudeLevelBase": 1, "magnitudeLevelHigh": 1, "magnitudePerLevel": 0,
    }
    none = {
        "type": -1, "param": -1, "durationBase": 0, "durationMod": 0, "durationPerLevel": 0,
        "chanceBase": 0, "chanceMod": 0, "chancePerLevel": 0,
        "magnitudeBaseLow": 0, "magnitudeBaseHigh": 0,
        "magnitudeLevelBase": 0, "magnitudeLevelHigh": 0, "magnitudePerLevel": 0,
    }
    item = {
        "group": group, "templateIndex": template, "material": material, "name": name,
        "maxCondition": 12800, "currentCondition": 12800, "value": 0,
        "enchantments": [row() for _ in range(9)] + [none],
    }
    tmp = Path("/tmp/opencode")
    tmp.mkdir(parents=True, exist_ok=True)
    path = tmp / "custom-classic.json"
    path.write_text(json.dumps(item, indent=2), encoding="utf-8")
    if confirm(stdscr, "Insert directly with no staff? (No = craft one staff, 6 Marks)"):
        run_and_apply(stdscr, "Custom classic item — direct insert", ["live-player-edit.mjs", "--append-item", str(path)])
    elif confirm(stdscr, "Build and give this 9-effect classic item (one staff, 6 Marks)?"):
        run_and_apply(stdscr, "Custom classic item", ["live-arrived-worth.mjs", "--give-json", str(path)])


# ── gold / bank ──────────────────────────────────────────────────────
def gold_screen(stdscr):
    try:
        acct = (load_player().get("account") or {})
    except Exception:
        acct = {}
    sub = f"silver {acct.get('silver')}  gold {acct.get('gold')} purse / {acct.get('bank')} bank"
    if acct.get("silver") == 0:
        wait_key(stdscr, "Marks are 0 — the staffs need Marks for planks; the run will refuse")
    crafts = prompt(stdscr, "staff crafts (1..30)", "1")
    if crafts is None:
        return
    bank = prompt(stdscr, "bank gold (+)", "0")
    if bank is None:
        return
    gold = prompt(stdscr, "purse gold (+)", "0")
    if gold is None:
        return
    settle = confirm(stdscr, "settle outstanding loans from the purse first?")
    try:
        c, b, g = int(crafts), int(bank), int(gold)
    except ValueError:
        wait_key(stdscr, "numbers only")
        return
    if c < 1 or c > 30 or b < 0 or g < 0:
        wait_key(stdscr, "out of range")
        return
    if b + g <= 0:
        wait_key(stdscr, "bank and purse are both zero")
        return
    args = ["live-arrived-worth.mjs", "--crafts", str(c), "--bank", str(b), "--gold", str(g)]
    if settle:
        args.append("--settle-loan")
    run_and_apply(stdscr, f"Gold — {c} staffs, bank +{b}, purse +{g}", args)


# ── player save edit ─────────────────────────────────────────────────
def instakill_spell():
    none = {
        "type": -1, "subType": -1,
        "durationBase": 0, "durationMod": 0, "durationPerLevel": 0,
        "chanceBase": 0, "chanceMod": 0, "chancePerLevel": 0,
        "magnitudeBaseLow": 0, "magnitudeBaseHigh": 0,
        "magnitudeLevelBase": 0, "magnitudeLevelHigh": 0, "magnitudePerLevel": 0,
    }
    return {
        "effects": [
            {"type": 4, "subType": 0, "durationBase": 0, "durationMod": 0, "durationPerLevel": 0,
             "chanceBase": 0, "chanceMod": 0, "chancePerLevel": 0,
             "magnitudeBaseLow": 1000000, "magnitudeBaseHigh": 1000000,
             "magnitudeLevelBase": 0, "magnitudeLevelHigh": 0, "magnitudePerLevel": 0},
            none, none,
        ],
        "element": 4, "rangeType": 2, "name": "Instakill", "icon": 57,
        "index": 994, "rri": True, "custom": True, "minimumCastingCost": True, "cost": 5,
    }


def player_edit_screen(stdscr):
    opts = [
        "Max stats (100)",
        "Skills to 100",
        "Level 45",
        "Max health / magicka 5000",
        "Carry weight (fortify strength)",
        "Faction / legal reputation",
        "Clear all loan debt / default",
        "Ship deed + sell (85k/170k bank)",
        "House deed (sell at bank)",
        "Local region price",
        "Everything (level 45, stats 100, skills 200, pools 5000, effects)",
        "Buff a spell",
        "Add Instakill spell (1M damage, free)",
        "Remove item template",
        "Raw save field (path=value)",
        "Back",
    ]
    while True:
        i = menu(stdscr, "Player save edit", "character save only — dry run first", opts)
        if i < 0 or i == len(opts) - 1:
            return
        args = ["live-player-edit.mjs"]
        title = opts[i]
        if i == 0:
            args += ["--stats", "all=100"]
        elif i == 1:
            args += ["--skills", "all=100"]
        elif i == 2:
            args += ["--level", "45"]
        elif i == 3:
            args += ["--max-health", "5000", "--max-magicka", "5000"]
        elif i == 4:
            kg = prompt(stdscr, "carry ceiling in kg", "1000")
            if kg is None:
                continue
            args += ["--carry-weight", kg]
            title += f" — {kg} kg"
        elif i == 5:
            fac = prompt(stdscr, "faction id=value (blank to skip)", "9=100")
            if fac is None:
                continue
            legal = prompt(stdscr, "legal region=value (blank to skip)", "17=0")
            if legal is None:
                continue
            if fac:
                args += ["--faction", fac]
            if legal:
                args += ["--legal", legal]
            if not fac and not legal:
                continue
            title += f" — faction {fac or '-'} legal {legal or '-'}"
        elif i == 6:
            args += ["--clear-loans"]
        elif i == 7:
            ship = prompt(stdscr, "ship hull (0 small, 1 large)", "1")
            if ship is None:
                continue
            args += ["--ship", ship, "--sell-ship"]
            title += " — sold into bank 17"
        elif i == 8:
            region = prompt(stdscr, "region index", "17")
            if region is None:
                continue
            map_id = prompt(stdscr, "mapId", "891563575")
            if map_id is None:
                continue
            key = prompt(stdscr, "buildingKey", "132096")
            if key is None:
                continue
            loc = prompt(stdscr, "location name", "Daggerfall")
            if loc is None:
                continue
            args += ["--house", f"{region}:{map_id}:{key}:{loc}"]
            title += " — sell it at the bank in game"
        elif i == 9:
            region = prompt(stdscr, "region index", "17")
            if region is None:
                continue
            value = prompt(stdscr, "price adjustment", "-100")
            if value is None:
                continue
            args += ["--region-price", f"{region}={value}"]
            title += f" — region {region} price {value}"
        elif i == 10:
            args += ["--max-character"]
        elif i == 11:
            name = prompt(stdscr, "spell name or index", "Arcane Arrow")
            if name is None:
                continue
            factor = prompt(stdscr, "magnitude/duration factor", "5")
            if factor is None:
                continue
            args += ["--spell-buff", name, "--spell-factor", factor]
            title += f" — {name} x{factor}"
        elif i == 12:
            char = character_id()
            if not char:
                wait_key(stdscr, "no character found")
                continue
            save = api("GET", f"/v1/realm/{char}/data")
            spells = save.get("spells") if isinstance(save.get("spells"), list) else []
            n = len(spells)
            max_index = max([int(s.get("index")) for s in spells if isinstance(s, dict) and isinstance(s.get("index"), int)] or [993])
            spell = instakill_spell()
            spell["index"] = max_index + 1
            args += ["--set", f"spells.{n}={json.dumps(spell)}"]
            title += f" — Instakill index {spell['index']}"
        elif i == 13:
            idx = prompt(stdscr, "item template index", "2000")
            if idx is None:
                continue
            args += ["--remove-template", idx]
            title += f" — template {idx}"
        elif i == 14:
            sets = []
            while True:
                spec = prompt(stdscr, "path=value (blank to finish)", "")
                if spec is None:
                    break
                if not spec:
                    break
                sets.append(spec)
                if not confirm(stdscr, "add another --set?"):
                    break
            if not sets:
                continue
            for s in sets:
                args += ["--set", s]
            title += f" — {len(sets)} set(s)"
        run_and_apply(stdscr, title, args)


# ── account wardrobe ────────────────────────────────────────────────
def wear_action(stdscr, row):
    state = row.get("state")
    kind = row.get("kind")
    key = row.get("key")
    if kind == "title":
        body = {"title": None if state == "worn" else key}
        endpoint = "/v1/account/title"
    elif kind == "aura":
        body = {"aura": None if state == "worn" else key}
        endpoint = "/v1/account/aura"
    elif kind == "icon":
        body = {"icon": None if state == "worn" else key}
        endpoint = "/v1/account/icon"
    elif kind == "glyph":
        body = {"glyph": key, "on": state != "worn"}
        endpoint = "/v1/account/glyph"
    elif kind in ("kill", "portal", "mount"):
        body = {"slot": kind, "key": None if state == "worn" else key}
        endpoint = "/v1/account/effect"
    elif kind == "armory":
        body = {"slot": row.get("slot"), "piece": None if state == "worn" else key}
        endpoint = "/v1/account/armory"
    else:
        wait_key(stdscr, "no wear action for this kind")
        return
    if not confirm(stdscr, f"{'Take off' if state == 'worn' else 'Wear'} {row.get('name')}?"):
        return
    try:
        r = api("POST", endpoint, body)
        msg = f"ok — {json.dumps(r.get('title') or r.get('aura') or r.get('icon') or r.get('effects') or r.get('armory') or 'worn', ensure_ascii=False)}"
    except Exception as e:
        msg = f"refused: {e}"
    global _player_cache
    _player_cache = None
    wait_key(stdscr, msg)


def buy_action(stdscr, row):
    price = row.get("price")
    if not price:
        wait_key(stdscr, "this row has no shop price")
        return
    if not confirm(stdscr, f"Buy {row.get('name')} for {price} Aurum?"):
        return
    body = {"ware": row.get("id"), "price": price}
    try:
        r = api("POST", "/v1/aurum/buy", body)
        msg = f"bought — spent {r.get('spent', price)} Aurum"
    except Exception as e:
        text = str(e)
        if "aurum-price" in text:
            wait_key(stdscr, f"price changed ({text}); reopen the shop and try again")
            return
        msg = f"refused: {e}"
    global _player_cache
    _player_cache = None
    wait_key(stdscr, msg)


def account_screen(stdscr):
    held_only = False
    query = ""
    sel = 0
    while True:
        if _player_cache is None:
            busy(stdscr, "Reading the account…")
        try:
            data = load_player()
        except Exception as e:
            show_output(stdscr, "Account read failed", str(e))
            return
        rows = data.get("rows") or []
        acct = data.get("account") or {}
        terms = query.lower().split()
        visible = []
        for r in rows:
            hay = f"{r.get('kind')} {r.get('id')} {r.get('name')} {r.get('source')}".lower()
            if held_only and not (r.get("held") or r.get("worn")):
                continue
            if all(t in hay for t in terms):
                visible.append(r)
        if not visible:
            sel = 0
        else:
            sel = min(sel, len(visible) - 1)
        header(stdscr, "Account cosmetics — wear / buy", f"silver {acct.get('silver')}  Aurum {acct.get('aurum')}  Sigil Stones {acct.get('sigilStones')}")
        h, w = stdscr.getmaxyx()
        body = h - 5
        top = max(0, sel - body + 1) if sel >= body else 0
        for i in range(body):
            idx = top + i
            if idx >= len(visible):
                break
            r = visible[idx]
            mark = "> " if idx == sel else "  "
            a = attr(C_SEL, curses.A_BOLD) if idx == sel else curses.A_NORMAL
            price = r.get("price")
            state = r.get("state") or "-"
            line = f"{r.get('kind'):<8} {r.get('id'):<26} {r.get('name'):<28} {state:<6} {str(price or '-'):>6}"
            put(stdscr, 3 + i, 0, (mark + line)[: max(0, w - 1)], a)
        if visible:
            r = visible[sel]
            foot = f"{r.get('source')}  {r.get('state')}  {'shop ' + str(r.get('price')) + ' Aurum' if r.get('price') else 'not sold'}"
        else:
            foot = "no match"
        footer(stdscr, "↑↓  / search  h held-only  w wear/take-off  b buy  q back   |  " + foot)
        stdscr.refresh()
        ch = stdscr.getch()
        if ch in (ord("q"), 27):
            return
        if ch in (curses.KEY_UP, ord("k")):
            sel = max(0, sel - 1)
        elif ch in (curses.KEY_DOWN, ord("j")):
            sel = min(max(0, len(visible) - 1), sel + 1)
        elif ch == curses.KEY_PPAGE:
            sel = max(0, sel - body)
        elif ch == curses.KEY_NPAGE:
            sel = min(max(0, len(visible) - 1), sel + body)
        elif ch == curses.KEY_HOME:
            sel = 0
        elif ch == curses.KEY_END:
            sel = max(0, len(visible) - 1)
        elif ch == ord("/"):
            q = prompt(stdscr, "search")
            if q is not None:
                query = q
                sel = 0
        elif ch == ord("h"):
            held_only = not held_only
            sel = 0
        elif ch == ord("w") and visible:
            if visible[sel].get("held") or visible[sel].get("worn"):
                wear_action(stdscr, visible[sel])
            else:
                wait_key(stdscr, "not held — buy it first")
        elif ch == ord("b") and visible:
            buy_action(stdscr, visible[sel])


# ── earn: finds, market, caches, writs ──────────────────────────────
def character_id():
    acct = load_player().get("account") or {}
    return (acct.get("character") or {}).get("id")


def rid():
    return secrets.token_urlsafe(12)


def finds_screen(stdscr):
    global _player_cache
    while True:
        try:
            m = api("POST", "/v1/marks/balance", {})
        except Exception as e:
            show_output(stdscr, "Marks failed", str(e))
            return
        today = m.get("today") or {}
        found, fmax = int(today.get("found") or 0), int(today.get("findMax") or 20)
        opts = [
            f"Claim one find (balance {m.get('balance')}, find Marks {found}/{fmax})",
            f"Claim all remaining find Marks (up to {max(0, fmax - found)})",
            "Back",
        ]
        i = menu(stdscr, "Daily finds", "client-trusted; 1-4 Marks each, 20/day", opts)
        if i < 0 or i == 2:
            return
        if i == 0:
            try:
                r = api("POST", "/v1/marks/find", {"kind": "pile", "rid": rid()})
                _player_cache = None
                show_output(stdscr, "Find", json.dumps(r, indent=2))
            except Exception as e:
                show_output(stdscr, "Find refused", str(e))
        else:
            remaining = max(0, fmax - found)
            if remaining == 0:
                wait_key(stdscr, "no finds left today")
                continue
            if not confirm(stdscr, f"Claim all {remaining} remaining find(s)?"):
                continue
            total, last = 0, None
            for i in range(remaining):
                try:
                    r = api("POST", "/v1/marks/find", {"kind": "pile", "rid": rid()})
                    struck = int(r.get("struck") or 0)
                    total += struck
                    last = r
                    if struck <= 0:
                        break
                    if int((r.get("today") or {}).get("found") or 0) >= fmax:
                        break
                except Exception as e:
                    wait_key(stdscr, f"stopped after {i}: {e}")
                    break
            show_output(stdscr, "Finds claimed", f"struck {total} Marks\n" + json.dumps(last or {}, indent=2))
            _player_cache = None


def market_fill_screen(stdscr):
    char = character_id()
    if not char:
        wait_key(stdscr, "no character found")
        return
    busy(stdscr, "Reading market orders…")
    try:
        orders = api("POST", "/v1/market/read", {"character": char, "region": 17, "view": "orders", "currency": "marks"}).get("orders") or []
        stores = api("POST", "/v1/prof/state", {"character": char}).get("stores") or []
    except Exception as e:
        show_output(stdscr, "Market failed", str(e))
        return
    have = {}
    for s in stores:
        have[s.get("material")] = int(s.get("own") or 0) + int(s.get("bought") or 0)
    opts = []
    for o in orders:
        n = have.get(o.get("material"), 0)
        if n <= 0:
            continue
        opts.append((o, f"{o.get('material')}  have {n}  order {o.get('left')} @ {o.get('price')}  region {o.get('region')}"))
    if not opts:
        show_output(stdscr, "Buy orders", "No open Marks buy order matches your own/bought Stores.\n\n"
                   "Loose units are station-only and do not fill orders; the market screen cannot use them.")
        return
    labels = [x[1] for x in opts] + ["Back"]
    i = menu(stdscr, "Fill a market buy order", "own/bought only — loose does not count", labels)
    if i < 0 or i == len(labels) - 1:
        return
    o = opts[i][0]
    units = prompt(stdscr, f"units of {o.get('material')} (order left {o.get('left')})", str(min(have.get(o.get('material'), 0), int(o.get('left') or 0))))
    if units is None:
        return
    try:
        units = int(units)
    except ValueError:
        wait_key(stdscr, "not a number")
        return
    if not confirm(stdscr, f"Fill {units} x {o.get('material')} at {o.get('price')} Marks each?"):
        return
    try:
        r = api("POST", "/v1/market/fill", {"character": char, "region": 17, "order": o.get("id"), "units": units, "rid": rid()})
        show_output(stdscr, "Order filled", json.dumps(r, indent=2))
        global _player_cache
        _player_cache = None
    except Exception as e:
        show_output(stdscr, "Fill refused", str(e))


def market_buy_screen(stdscr):
    char = character_id()
    if not char:
        wait_key(stdscr, "no character found")
        return
    material = prompt(stdscr, "material key", "plank:pine")
    if not material:
        return
    busy(stdscr, f"Reading {material} listings…")
    try:
        rows = api("POST", "/v1/market/read", {"character": char, "region": 17, "view": "materials", "currency": "marks", "material": material}).get("rows") or []
    except Exception as e:
        show_output(stdscr, "Market failed", str(e))
        return
    if not rows:
        wait_key(stdscr, f"no Marks listing for {material}")
        return
    labels = [f"{r.get('material')}  {r.get('units')} @ {r.get('price')}  region {r.get('region')}" for r in rows] + ["Back"]
    i = menu(stdscr, "Buy a material listing", "pays in Marks from your account", labels)
    if i < 0 or i == len(labels) - 1:
        return
    r = rows[i]
    units = prompt(stdscr, f"units (listing {r.get('units')})", str(r.get("units") or 1))
    if units is None:
        return
    try:
        units = int(units)
        max_cost = units * int(r.get("price") or 0)
    except ValueError:
        wait_key(stdscr, "not a number")
        return
    if not confirm(stdscr, f"Buy {units} x {r.get('material')} for {max_cost} Marks?"):
        return
    try:
        ans = api("POST", "/v1/market/buy", {"character": char, "region": 17, "listing": r.get("id"), "units": units, "max": max_cost, "rid": rid()})
        show_output(stdscr, "Material bought", json.dumps(ans, indent=2))
        global _player_cache
        _player_cache = None
    except Exception as e:
        show_output(stdscr, "Buy refused", str(e))


def cache_screen(stdscr):
    cache_id = prompt(stdscr, "Aurum cache id (d...)", "")
    if not cache_id:
        return
    proof = prompt(stdscr, "relay proof (cp)", "")
    if proof is None:
        return
    if not confirm(stdscr, "Claim this cache?"):
        return
    busy(stdscr, "Claiming the Aurum cache…")
    try:
        r = api("POST", "/v1/aurum/cache", {"id": cache_id, "proof": proof})
        show_output(stdscr, "Aurum cache", json.dumps(r, indent=2))
        global _player_cache
        _player_cache = None
    except Exception as e:
        show_output(stdscr, "Cache refused", str(e))


def writs_screen(stdscr):
    global _writs_cache, _writs_at
    char = character_id()
    if not char:
        wait_key(stdscr, "no character found")
        return
    try:
        if _writs_cache is None or time.time() - _writs_at > 180:
            busy(stdscr, "Loading the writs board (large, can take a while)…")
            board = api("POST", "/v1/writs/list", {"character": char, "region": 17})
            _writs_cache = board
            _writs_at = time.time()
        else:
            board = _writs_cache
        stores = api("POST", "/v1/prof/state", {"character": char}).get("stores") or []
    except Exception as e:
        show_output(stdscr, "Writs failed", str(e))
        return
    have = {}
    for s in stores:
        have[s.get("material")] = int(s.get("own") or 0) + int(s.get("bought") or 0)
    writs = board.get("writs") or []
    crafts = (board.get("crafts") or {}).get("writs") or []
    court = [w for w in writs if not w.get("filled_by")]
    fillable = [w for w in court if have.get(w.get("material"), 0) >= int(w.get("qty") or 0)]
    lines = [f"region 17   day {board.get('day')}   ends {board.get('endsAt')}", "",
             f"open Court/hall writs: {len(court)}",
             f"fillable from your own/bought Stores: {len(fillable)}"]
    for w in fillable[:20]:
        lines.append(f"  {w.get('id')}  {w.get('material')} x{w.get('qty')}  pay {w.get('pay')}  {w.get('kind')}")
    if len(fillable) > 20:
        lines.append(f"  ... {len(fillable) - 20} more")
    if not fillable:
        lines.append("  none — a Court writ fills from own/bought Stores; loose does not count")
    lines += ["", "CRAFTING WRITS"]
    if not crafts:
        lines.append("  none")
    for w in crafts:
        lines.append(f"  {w.get('id')}  {w.get('product')} x{w.get('qty')}  pay {w.get('pay')}  pieces {len(w.get('pieces') or [])}")
    show_output(stdscr, "Writs", "\n".join(lines))
    if not fillable:
        return
    if not confirm(stdscr, "Fill a Court writ now?"):
        return
    labels = [f"{w.get('material')} x{w.get('qty')}  pay {w.get('pay')}  {w.get('id')}" for w in fillable[:30]] + ["Back"]
    i = menu(stdscr, "Fill Court writ", "own/bought Stores only", labels)
    if i < 0 or i == len(labels) - 1:
        return
    w = fillable[i]
    try:
        r = api("POST", "/v1/writs/deliver", {"character": char, "id": w.get("id"), "rid": rid()})
        show_output(stdscr, "Writ filled", json.dumps(r, indent=2))
        global _player_cache
        _player_cache = None
    except Exception as e:
        show_output(stdscr, "Writ refused", str(e))


def current_pixel(char):
    save = api("GET", f"/v1/realm/{char}/data")
    wp = (save.get("world") or {}).get("pixel") or (save.get("anchorPosition") or {}).get("pixel")
    return (int(wp["x"]), int(wp["y"])) if wp else (975, 273)


def remote_gather_screen(stdscr):
    char = character_id()
    if not char:
        wait_key(stdscr, "no character found")
        return
    try:
        px, py = current_pixel(char)
    except Exception as e:
        show_output(stdscr, "Pixel read failed", str(e))
        return
    busy(stdscr, f"Reading pixels around {px},{py}…")
    grid = [(px + dx, py + dy) for dx in range(-2, 3) for dy in range(-2, 3)]
    try:
        facts = api("POST", "/v1/prof/pixels", {"character": char, "pixels": grid}).get("pixels") or []
    except Exception as e:
        show_output(stdscr, "Pixels failed", str(e))
        return
    usable = [p for p in facts if p.get("climate") is not None and p.get("region") is not None]
    if not usable:
        show_output(stdscr, "Remote gather", "No pixel with a climate/region in the 5x5 around the character.")
        return
    labels = [f"{p.get('x')},{p.get('y')}  {p.get('state')}  climate {p.get('climate')}  region {p.get('region')}" for p in usable] + ["Back"]
    i = menu(stdscr, "Remote gather — pixel", "the service checks the node, not your position", labels)
    if i < 0 or i == len(labels) - 1:
        return
    p = usable[i]
    node_kind = prompt(stdscr, "node kind (herb/tree/vein/boulder)", "herb")
    if not node_kind:
        return
    node_kind = node_kind.strip().lower()
    if node_kind not in ("herb", "tree", "vein", "boulder"):
        wait_key(stdscr, "herb, tree, vein or boulder")
        return
    slot = prompt(stdscr, "slot", "0")
    if slot is None:
        return
    try:
        slot = int(slot)
    except ValueError:
        wait_key(stdscr, "slot must be a number")
        return
    kind = {"herb": "herbs", "tree": "logs", "vein": "ore", "boulder": "stone"}[node_kind]
    day = int(time.time() // 86400)
    at = int(time.time())
    node = f"{node_kind}:{p['x']}:{p['y']}:{day}:{slot}"
    if not confirm(stdscr, f"Harvest {node} ({kind})?"):
        return
    busy(stdscr, "Harvesting…")
    try:
        r = api("POST", "/v1/prof/harvest", {"character": char, "node": node, "kind": kind, "climate": p["climate"], "region": p["region"], "at": at, "rid": rid()})
        show_output(stdscr, "Harvest", json.dumps(r, indent=2))
        global _player_cache
        _player_cache = None
    except Exception as e:
        show_output(stdscr, "Harvest refused", str(e))


def earn_screen(stdscr):
    opts = [
        "Claim daily finds (Marks)",
        "Fill a market buy order",
        "Buy a material listing with Marks",
        "Claim an Aurum cache (id + relay proof)",
        "Writs board / fill a Court writ",
        "Remote gather (harvest a pixel)",
        "Gather note",
        "Back",
    ]
    while True:
        i = menu(stdscr, "Earn / market / writs", "Marks, Aurum and Stores", opts)
        if i < 0 or i == len(opts) - 1:
            return
        if i == 0:
            finds_screen(stdscr)
        elif i == 1:
            market_fill_screen(stdscr)
        elif i == 2:
            market_buy_screen(stdscr)
        elif i == 3:
            cache_screen(stdscr)
        elif i == 4:
            writs_screen(stdscr)
        elif i == 5:
            remote_gather_screen(stdscr)
        elif i == 6:
            show_output(stdscr, "Gather", "\n".join([
                "Remote gather is the action above: the service checks the node's",
                "day, pixel climate/region and slot, not your character's position.",
                "The 10% gather find pays 2-5 Marks, at most 30 marks a UTC day.",
                "Tree logs, vein ore and herb twigs can all come from it; the arrow",
                "recipe needs one iron ingot, four twigs and a pine plank.",
                "If the node is above your rank the service answers prof-rank;",
                "try another slot or a lower-tier pixel.",
            ]))


# ── one-click automation ────────────────────────────────────────────
def marks_card():
    return api("POST", "/v1/marks/balance", {})


def claim_all_finds():
    global _player_cache
    m = marks_card()
    today = m.get("today") or {}
    found, fmax = int(today.get("found") or 0), int(today.get("findMax") or 20)
    total = 0
    for _ in range(max(0, fmax - found)):
        r = api("POST", "/v1/marks/find", {"kind": "pile", "rid": rid()})
        struck = int(r.get("struck") or 0)
        total += struck
        if struck <= 0 or int((r.get("today") or {}).get("found") or 0) >= fmax:
            break
    _player_cache = None
    return f"struck {total} Marks; balance {marks_card().get('balance')}"


def remote_gather_some(limit=4):
    global _player_cache
    char = character_id()
    if not char:
        return "no character"
    px, py = current_pixel(char)
    grid = [(px + dx, py + dy) for dx in range(-2, 3) for dy in range(-2, 3)]
    facts = api("POST", "/v1/prof/pixels", {"character": char, "pixels": grid}).get("pixels") or []
    usable = [p for p in facts if p.get("climate") is not None and p.get("region") is not None]
    if not usable:
        return "no pixel with climate/region"
    p = usable[0]
    day = int(time.time() // 86400)
    at = int(time.time())
    lines = []
    done = 0
    for slot in range(0, 6):
        if done >= limit:
            break
        node = f"herb:{p['x']}:{p['y']}:{day}:{slot}"
        try:
            r = api("POST", "/v1/prof/harvest", {"character": char, "node": node, "kind": "herbs", "climate": p["climate"], "region": p["region"], "at": at, "rid": rid()})
            lines.append(f"{node}: {r.get('material')} x{r.get('qty')}  marks={json.dumps(r.get('marks'))}")
            done += 1
        except Exception as e:
            lines.append(f"{node}: {e}")
            break
    _player_cache = None
    return "\n".join(lines) or "nothing harvested"


def ensure_custom_json():
    path = Path("/tmp/opencode/custom-classic.json")
    if path.exists():
        return path
    def row():
        return {"type": 2, "param": 0, "durationBase": 999, "durationMod": 0, "durationPerLevel": 0,
                "chanceBase": 100, "chanceMod": 0, "chancePerLevel": 0,
                "magnitudeBaseLow": 999, "magnitudeBaseHigh": 999,
                "magnitudeLevelBase": 1, "magnitudeLevelHigh": 1, "magnitudePerLevel": 0}
    none = {"type": -1, "param": -1, "durationBase": 0, "durationMod": 0, "durationPerLevel": 0,
            "chanceBase": 0, "chanceMod": 0, "chancePerLevel": 0,
            "magnitudeBaseLow": 0, "magnitudeBaseHigh": 0,
            "magnitudeLevelBase": 0, "magnitudeLevelHigh": 0, "magnitudePerLevel": 0}
    item = {"group": "Weapons", "templateIndex": 113, "material": 9, "name": "Dagger",
            "maxCondition": 12800, "currentCondition": 12800, "value": 0,
            "enchantments": [row() for _ in range(9)] + [none]}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(item, indent=2), encoding="utf-8")
    return path


def automation_char(ship_sale):
    global _player_cache
    args = ["live-player-edit.mjs", "--max-character",
            "--faction", "9=100", "--legal", "17=0",
            "--clear-loans", "--region-price", "17=-100",
            "--spell-buff", "Arcane Arrow", "--spell-factor", "5"]
    if ship_sale:
        args += ["--ship", "1", "--sell-ship"]
    code, out, err = run_node(args + ["--apply"], 300)
    _player_cache = None
    return (out + ("\n" + err if err else "")).strip() or f"exit {code}"


def automation_item():
    bal = int(marks_card().get("balance") or 0)
    if bal < 6:
        return f"skipped: {bal} Marks, one staff needs 6"
    path = ensure_custom_json()
    code, out, err = run_node(["live-arrived-worth.mjs", "--give-json", str(path), "--apply"], 300)
    return (out + ("\n" + err if err else "")).strip() or f"exit {code}"


def automation_gold():
    bal = int(marks_card().get("balance") or 0)
    crafts = bal // 6
    if crafts < 1:
        return f"skipped: {bal} Marks, no full staff"
    crafts = min(30, crafts)
    code, out, err = run_node(["live-arrived-worth.mjs", "--crafts", str(crafts), "--bank", str(crafts * 11000), "--apply"], 300)
    return (out + ("\n" + err if err else "")).strip() or f"exit {code}"


def automation_gun():
    global _player_cache
    bal = int(marks_card().get("balance") or 0)
    if bal < 12:
        return f"skipped: {bal} Marks; an Iron Thunderlock + 100 pellets needs 12 (two staffs)"
    logs = []
    for name, args in [
        ("Iron Thunderlock", ["--give", "560", "--give-material", "iron"]),
        ("100 Dwemer Pellets", ["--give", "561", "--give-stack", "100"]),
    ]:
        code, out, err = run_node(["live-arrived-worth.mjs", *args, "--apply"], 300)
        logs.append(f"### {name}\n" + ((out + ("\n" + err if err else "")).strip() or f"exit {code}"))
    _player_cache = None
    return "\n\n".join(logs)


def automation_max_items():
    global _player_cache
    code, out, err = run_node(["make-max-items.mjs", "--max-gear", "--apply"], 300)
    _player_cache = None
    return (out + ("\n" + err if err else "")).strip() or f"exit {code}"


def automation_max_wearables():
    global _player_cache
    code, out, err = run_node(["make-max-wearables.mjs", "--apply"], 300)
    _player_cache = None
    return (out + ("\n" + err if err else "")).strip() or f"exit {code}"


def run_automation(stdscr, title, steps):
    logs = []
    for name, fn in steps:
        busy(stdscr, f"{title}\n{name}…")
        try:
            log = fn()
        except Exception as e:
            log = f"ERROR: {type(e).__name__}: {e}"
        logs.append(f"### {name}\n{log}")
    text = "\n\n".join(logs)
    path = Path("/tmp/opencode") / f"dfo-automation-{int(time.time())}.log"
    try:
        path.write_text(text, encoding="utf-8")
        text += f"\n\nlog: {path}"
    except OSError:
        pass
    show_output(stdscr, title, text)


def automation_screen(stdscr):
    global _player_cache
    opts = [
        "Everything: character + ship sale + finds/gather + custom item + gold",
        "Clean character: max stats/skills/level/pools/effects, no ship sale",
        "Character + ship sale only (170k bank; measure finding)",
        "Economy only: finds, remote gather, custom item, gold",
        "Max items: Thunderlock + Oath + Ring + Katana (no staff)",
        "Max wearables: full Daedric armour + jewellery + weapons",
        "Gun: Iron Thunderlock + 100 pellets (12 Marks)",
        "Back",
    ]
    i = menu(stdscr, "AUTOMATION — one click", "all Node scripts run --apply; reads the plan first", opts)
    if i < 0 or i == len(opts) - 1:
        return
    if i == 0:
        steps = [
            ("Character + ship sale", lambda: automation_char(True)),
            ("Daily finds", claim_all_finds),
            ("Remote gather", remote_gather_some),
            ("Custom classic item", automation_item),
            ("Gold with remaining Marks", automation_gold),
        ]
        title = "Everything"
    elif i == 1:
        steps = [("Character", lambda: automation_char(False))]
        title = "Clean character"
    elif i == 2:
        steps = [("Character + ship sale", lambda: automation_char(True))]
        title = "Character + ship sale"
    elif i == 3:
        steps = [
            ("Daily finds", claim_all_finds),
            ("Remote gather", remote_gather_some),
            ("Custom classic item", automation_item),
            ("Gold with remaining Marks", automation_gold),
        ]
        title = "Economy"
    elif i == 4:
        steps = [("Maxed Thunderlock + Dragonfire Oath", automation_max_items)]
        title = "Max items"
    elif i == 5:
        steps = [("Full Daedric wearable set", automation_max_wearables)]
        title = "Max wearables"
    else:
        steps = [("Iron Thunderlock + 100 pellets", automation_gun)]
        title = "Gun"
    plan = "\n".join(f"- {name}" for name, _ in steps)
    if title == "Gun":
        hint = "Two give runs: one staff (6 Marks) covers the Iron gun, another covers 100 pellets. Each run joins the realm and displaces the game tab."
    elif title == "Max items":
        hint = "Appends the Daedric Thunderlock with nine Gods' Fire rows, 65,535 pellets, the Gilded Dragonfire Oath, the Ring of the Eight (nine CastWhenHeld rows) and the maxed Dai-Katana in one checkpoint. No staffs or Marks. Skips an item already held."
    elif title == "Max wearables":
        hint = "Appends the full Daedric set: seven armour pieces, Tower Shield, ten jewellery pieces, nineteen weapons with nine Gods' Fire rows, and 65,535 arrows. No staffs or Marks."
    else:
        hint = "The ship sale adds 170,000 bank and is an unexplained gain: measure finding when enforcement is off, hold when on. The custom item costs one staff (6 Marks)."
    show_output(stdscr, f"{title} — plan", plan + "\n\n" + hint)
    if not confirm(stdscr, f"Run {title} now? Writes the live save."):
        return
    run_automation(stdscr, title, steps)
    _player_cache = None


# ── info screens ────────────────────────────────────────────────────
def dragon_screen(stdscr):
    try:
        data = load_player()
        acct = data.get("account") or {}
    except Exception:
        acct = {}
    d = acct.get("dragons") or {}
    lines = [
        "DWARVEN DRAGON — TAMED MOUNT",
        "",
        f"slain: {d.get('slain', 0)}   tamed: {d.get('tamed', 0)}",
        "",
        "The tamed dragon is not a save-side item. A lawful one needs a",
        "dragonId the service drew into dragon_mounts for this account and",
        "character. A bare template 1820 is flagged 'dragon'; an invented id",
        "is flagged 'dragon-tame'. The checkpoint holds and the item is removed.",
        "",
        "Ways to get one:",
        "  1. Tame one in-game: a dealing Dwarven Dragon kill, 1 in 100,",
        "     for a character that holds no dragon.",
        "  2. A staff/operator database grant.",
        "  3. A separate audit of the claim path; the receipt is signed.",
        "",
        "The save exploit cannot create the tame row. Do not repeat fake 1820",
        "writes; each persist-hold is a law strike.",
    ]
    show_output(stdscr, "Dwarven Dragon", "\n".join(lines))


def currency_screen(stdscr):
    try:
        data = load_player()
        acct = data.get("account") or {}
    except Exception:
        acct = {}
    lines = [
        "CURRENCIES",
        "",
        f"gold (character)  {acct.get('gold')} purse / {acct.get('bank')} bank",
        f"silver (Marks)    {acct.get('silver')}",
        f"Aurum             {acct.get('aurum')}",
        f"Sigil Stones      {acct.get('sigilStones')}",
        "",
        "Gold is the character save's: live-arrived-worth.mjs writes it.",
        "Silver/Marks and Aurum are account ledgers: no client grant route.",
        "Sigil Stones are the Broker's purse, off closed gates and serpents.",
        "",
        "Gold: the crafted-arrival witness caps a clean run at crafts x 11,000",
        "(30 crafts = 330,000). The arrow recipe can witness 760,730,280 with",
        "a 65,535 stack, but needs iron and twigs.",
        "",
        "Silver: earn via combat/finds/gather/writs; daily caps apply.",
        "Aurum: earn via caches/deeds/challenges, or buy packs with money.",
    ]
    show_output(stdscr, "Currencies", "\n".join(lines))


def help_screen(stdscr):
    lines = [
        "FILES",
        "",
        f"{ROOT}",
        "  live-arrived-worth.mjs     gold / bank / item give",
        "  live-player-edit.mjs       stats / skills / level / pools / spells",
        "  item-catalog.mjs           lawful item catalogue",
        "  player-catalog.mjs         account wardrobe and currencies (read only)",
        "  dfo_tui.py                 this panel",
        "",
        "SAFETY",
        "  • Every Node editor is dry-run by default. This TUI shows the dry run",
        "    and only sends when you press 'a' and confirm on the output screen.",
        "  • Item gives and gold moves join the realm and displace the game tab.",
        "  • Rejoin the character in game after a write.",
        "  • Account things (titles, glyphs, auras, icons, effects, armory,",
        "    silver, Aurum, Sigil Stones, dragon tames) are service-side.",
        "    The Account screen can wear held things and buy with Aurum only.",
        "",
        "ITEM GIVE",
        "  'g' sends the selected row through --give-json and buys staffs for its",
        "  worth. 'i' appends the same exact item with live-player-edit --append-item:",
        "  no staff. The checkpoint's wealth measure still sees the item's worth;",
        "  with budget.enforce off it passes as a measure finding, with it on a hold.",
        "  The custom classic builder asks which of the two paths to use.",
        "  Press 'c' in Items for a custom item: nine effect rows + one None.",
        "",
        "GUNS",
        "  Dwarven Thunderlock 560 and Dwarven Pistolet 562 both spend the",
        "  Dwemer Pellet 561. Items -> / Thunderlock -> g; then Pellet -> g",
        "  and a stack of 100. One staff (6 Marks) covers an Iron gun and",
        "  another covers 100 pellets. Gilded: volendrungs-echo (24 Marks),",
        "  the-ketchmasters-word (18 Marks). The Hourlock is a Long Bow (130)",
        "  in the current mint; its old gun shape (560) is lawful only as minted.",
        "",
        "MAX ITEMS / APPEND",
        "  make-max-items.mjs appends a Daedric Thunderlock with nine Gods'",
        "  Fire rows, 65,535 pellets and the Gilded Dragonfire Oath in one",
        "  checkpoint. --max-gear adds the Ring of the Eight (nine CastWhenHeld",
        "  rows) and a maxed Dai-Katana. make-max-wearables.mjs adds the full",
        "  Daedric set: armour, Tower Shield, jewellery and nineteen weapons.",
        "  No staffs or Marks. It skips what is already held; --force duplicates.",
        "  'i' in Items appends any selected row directly.",
        "",
        "BANK / DEEDS / PRICES",
        "  Player edit -> Clear loans, Ship deed + sell, House deed, Local price.",
        "  Ship deed + sell writes the bank's own 85/170k sale price into bank 17",
        "  and sets ownedShip -1, repeatable. A house deed sets houses.<region>;",
        "  sell it at the bank in game. Clearing loans zeros the loan and default.",
        "",
        "CARRY WEIGHT",
        "  Player edit -> Carry weight writes a permanent fortify-strength",
        "  activeEffect. Strength gives 1.5 kg each; 1000 kg asks for strength 667.",
        "  The effect carries statMaxMods, which lifts the 100 stat cap. The",
        "  character judge does not read activeEffects.",
        "",
        "EARN / MARKET / WRITS",
        "  Daily finds: 1-4 Marks each, 20/day, client-trusted (no loot check).",
        "  Remote gather: harvest a node by pixel; the service checks the node,",
        "  not your position. 2-5 Marks on a 10% find, 30/day, plus goods.",
        "  Market: fill a buy order from own/bought Stores; buy a listing in Marks.",
        "  Loose units are station-only and do not fill orders.",
        "  Aurum cache: needs a cache id and the relay's proof.",
        "  Writs: Court writs fill from own/bought Stores; craft writs are shown.",
        "",
        "PLAYER EDIT",
        "  Level is judged 1..45, stats 0..100, skills 0..200. maxHealth,",
        "  maxMagicka, spells, activeEffects, factionRep and legalRep are not",
        "  in the character judge. --max-character sets level 45, stats 100,",
        "  skills 200, pools 5000 and permanent stat effects in one edit.",
        "  'Everything' in Player edit uses it. 'Add Instakill spell' appends",
        "  a 1,000,000 Damage Health spell at cost 0 (the game's floor is 5).",
        "",
        "DRAGON",
        "  1820 needs a service tame row. There is no save-side grant.",
    ]
    show_output(stdscr, "Help", "\n".join(lines))


# ── main ────────────────────────────────────────────────────────────
def main(stdscr):
    curses.curs_set(0)
    stdscr.keypad(True)
    init_colors()
    opts = [
        "AUTOMATION — run everything",
        "Status / balances",
        "Items — search & give",
        "Gold & bank",
        "Earn / market / writs",
        "Player save edit",
        "Account cosmetics — wear / buy",
        "Dwarven Dragon — status / why blocked",
        "Currencies — gold, silver, Aurum",
        "Help / files / safety",
        "Quit",
    ]
    while True:
        i = menu(stdscr, "DFO control panel", "own account only — private testing", opts)
        if i < 0 or i == len(opts) - 1:
            return
        try:
            if i == 0:
                automation_screen(stdscr)
            elif i == 1:
                status_screen(stdscr)
            elif i == 2:
                items_screen(stdscr)
            elif i == 3:
                gold_screen(stdscr)
            elif i == 4:
                earn_screen(stdscr)
            elif i == 5:
                player_edit_screen(stdscr)
            elif i == 6:
                account_screen(stdscr)
            elif i == 7:
                dragon_screen(stdscr)
            elif i == 8:
                currency_screen(stdscr)
            elif i == 9:
                help_screen(stdscr)
        except KeyboardInterrupt:
            return
        except Exception as e:
            show_output(stdscr, "Error", f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    try:
        curses.wrapper(main)
    except KeyboardInterrupt:
        pass
