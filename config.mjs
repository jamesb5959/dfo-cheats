// Reads DFO_TOKEN / DFO_BASE_URL from .config next to this file.
// Run ./dfo-token.sh to create it. DFO_CONFIG can point elsewhere.

import { readFileSync } from 'node:fs';

export function configValue(key) {
  const file = process.env.DFO_CONFIG || new URL('./.config', import.meta.url);
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return ''; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] !== key) continue;
    let v = m[2];
    if (v.length >= 2 && ((v[0] === "'" && v.endsWith("'")) || (v[0] === '"' && v.endsWith('"')))) v = v.slice(1, -1);
    return v;
  }
  return '';
}
