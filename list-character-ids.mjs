#!/usr/bin/env node
// DFO character-ID lister — read only.
//
// Run (your account):
//   ./dfo-token.sh          # once; saves the token to .config
//   node list-character-ids.mjs
//
// Or pass a token directly:
//   DFO_TOKEN='<session>' node list-character-ids.mjs
//
// Test (local service):
//   node list-character-ids.mjs --base http://127.0.0.1:8787 --token '<test-token>'
//
// All-server (Admin staff session; reads other accounts):
//   node list-character-ids.mjs --all-server --staff-session '<token>' --yes
//
// Offline-only characters and handleless guests are not listed.

import { readFileSync, writeFileSync } from 'node:fs';
import { configValue } from './config.mjs';

const DEFAULT_BASE = 'https://daggerfall-accounts.mackcothran.workers.dev';
const STAFF_PAGE_MAX = 10_000;

const HELP = `DFO character-ID lister — read only

Get a token once:
  ./dfo-token.sh

Run (your account):
  node list-character-ids.mjs
  DFO_TOKEN='<session>' node list-character-ids.mjs

Test (local service):
  node list-character-ids.mjs --base http://127.0.0.1:8787 --token '<test-token>'

All-server (Admin staff session):
  node list-character-ids.mjs --all-server --staff-session '<token>' --yes

Options:
  --base <url>         default: https://daggerfall-accounts.mackcothran.workers.dev
  --token <token>      session bearer
  --handle <handle>    sign in instead
  --password-file <f>  password from a file
  --all-server         page every account (needs --yes)
  --staff-session <t>  staff panel session
  --with-names         include names (all-server)
  --json               print JSON
  --out <file>         write JSON here
  --help               this text

Offline-only characters and handleless guests are not listed.
`;

const usage = () => HELP;
const die = (why, code = 2) => { console.error(`\nrefused: ${why}\n`); process.exit(code); };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all-server') out.allServer = true;
    else if (a === '--yes') out.yes = true;
    else if (a === '--with-names') out.withNames = true;
    else if (a === '--json') out.json = true;
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
if (args.help) { console.log(usage()); process.exit(0); }

const base = String(args.base ?? process.env.DFO_BASE_URL ?? configValue('DFO_BASE_URL') ?? DEFAULT_BASE).replace(/\/+$/, '') || DEFAULT_BASE;
let token = String(args.token ?? process.env.DFO_TOKEN ?? configValue('DFO_TOKEN') ?? '').trim();
const handle = String(args.handle ?? process.env.DFO_HANDLE ?? '').trim();
const staffSession = String(args['staff-session'] ?? process.env.DFO_STAFF_SESSION ?? '').trim();

let password = process.env.DFO_PASSWORD ?? '';
if (args['password-file']) {
  try { password = readFileSync(args['password-file'], 'utf8').replace(/\r?\n$/, ''); } catch (e) { die(`cannot read --password-file: ${e.message}`); }
}

if (!/^https?:\/\//i.test(base)) die('--base (or DFO_BASE_URL) must be an http(s) URL');
if (!args.allServer && !token && !(handle && password)) {
  die('own-account mode needs --token/DFO_TOKEN, or --handle with DFO_PASSWORD/--password-file');
}
if (args.allServer && !staffSession) die('--all-server needs --staff-session/DFO_STAFF_SESSION (an Admin staff panel session)');
if (args.allServer && !args.yes) {
  console.log('all-server mode is read-only, but it pages every registered account\'s realm characters.');
  console.log(`It would POST ${base}/v1/staff/players with header x-staff-session, 25 accounts a page,`);
  console.log('and print character IDs only (add --with-names to include names).');
  console.log('\nRe-run with --yes to send it. No request was sent.');
  process.exit(0);
}

async function request(method, path, { body, headers = {}, auth = false, staff = false } = {}) {
  const sent = { ...headers };
  if (auth) {
    if (!token) throw new Error('no session token');
    sent.authorization = `Bearer ${token}`;
  }
  if (staff) sent['x-staff-session'] = staffSession;
  const res = await fetch(base + path, {
    method,
    headers: sent,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok) {
    const why = typeof parsed === 'string' ? parsed.slice(0, 400) : JSON.stringify(parsed).slice(0, 400);
    throw new Error(`${method} ${path} -> ${res.status}: ${why}`);
  }
  return parsed;
}

async function signIn() {
  const signed = await request('POST', '/v1/auth/login', {
    body: { handle, password, label: 'list-character-ids' },
  });
  const secret = String(signed?.secret ?? '');
  if (!secret) throw new Error('login did not answer a session secret');
  token = secret;
  console.log(`signed in as ${signed.name ?? handle}`);
}

const levelOf = (c) => (Number.isInteger(c?.summary?.level) ? c.summary.level : null);

function printOwn(characters) {
  console.log(`\naccount realm characters (${characters.length})`);
  if (!characters.length) {
    console.log('  (none — an offline-only character is not kept by the account service)');
    return;
  }
  console.log('  ID                       NAME                 LEVEL  SEQ  BYTES  ONLINE  CUSTOMS');
  for (const c of characters) {
    const name = String(c.name ?? '').slice(0, 20).padEnd(20);
    const level = String(levelOf(c) ?? '?').padStart(5);
    console.log(`  ${c.id.padEnd(24)} ${name} ${level}  ${String(c.seq ?? 0).padStart(3)}  ${String(c.bytes ?? 0).padStart(5)}  ${c.playing ? 'yes   ' : 'no    '}  ${c.customs ? 'yes' : 'no'}`);
  }
}

function printAll(rows) {
  console.log(`\nrealm character IDs on ${base}: ${rows.length}`);
  for (const r of rows) console.log(`  ${r.id}${r.name ? `  ${r.name}` : ''}`);
}

try {
  if (args.allServer) {
    const seen = new Set();
    const rows = [];
    let cursor = '';
    let pages = 0;
    for (; pages < STAFF_PAGE_MAX; pages++) {
      const page = await request('POST', '/v1/staff/players', {
        body: { q: '', from: cursor, ban: 'all' },
        staff: true,
        headers: { 'content-type': 'application/json' },
      });
      const players = Array.isArray(page?.players) ? page.players : [];
      for (const p of players) {
        for (const c of Array.isArray(p?.characters) ? p.characters : []) {
          if (typeof c?.id !== 'string' || seen.has(c.id)) continue;
          seen.add(c.id);
          rows.push(args.withNames ? { id: c.id, name: c.name ?? null } : { id: c.id });
        }
      }
      const next = page?.next ?? null;
      if (!next) break;
      if (next === cursor) throw new Error('staff pagination did not advance');
      cursor = next;
    }
    if (pages >= STAFF_PAGE_MAX) throw new Error(`stopped after ${STAFF_PAGE_MAX} staff pages`);
    const pageCount = pages + 1;
    const result = { mode: 'all-server', base, pages: pageCount, count: rows.length, characters: rows };
    if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2) + '\n');
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      printAll(rows);
      console.log(`\n${pageCount} staff page(s). Guests without a handle and offline-only characters are not listed.`);
    }
  } else {
    if (!token) await signIn();
    const data = await request('GET', '/v1/realm', { auth: true });
    const characters = Array.isArray(data?.characters) ? data.characters : [];
    const result = { mode: 'own', base, count: characters.length, max: data?.max ?? null, characters };
    if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2) + '\n');
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printOwn(characters);
  }
} catch (e) {
  die(e.message, 1);
}
