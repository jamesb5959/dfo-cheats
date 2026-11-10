#!/usr/bin/env bash
# Get a DFO session token and save it to .config.
#
#   ./dfo-token.sh
#   ./dfo-token.sh --handle you
#   DFO_HANDLE=you DFO_PASSWORD='...' ./dfo-token.sh
#
# The token is the `secret` from POST /v1/auth/login.
# Both Node scripts read .config automatically.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${DFO_BASE_URL:-https://daggerfall-accounts.mackcothran.workers.dev}"
HANDLE="${DFO_HANDLE:-}"
OUT="${DFO_CONFIG:-$HERE/.config}"

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:?--base needs a value}"; shift 2 ;;
    --handle) HANDLE="${2:?--handle needs a value}"; shift 2 ;;
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }

if [ -z "$HANDLE" ]; then
  read -r -p "handle: " HANDLE
fi
if [ -z "${DFO_PASSWORD:-}" ]; then
  read -r -s -p "password: " DFO_PASSWORD
  echo
fi

BODY=$(printf '%s\n%s' "$HANDLE" "$DFO_PASSWORD" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  const at = s.indexOf("\n");
  process.stdout.write(JSON.stringify({ handle: s.slice(0, at), password: s.slice(at + 1), label: "dfo-token" }));
});
')
unset DFO_PASSWORD

ANSWER=$(curl -sS -X POST "$BASE/v1/auth/login" \
  -H 'content-type: application/json' \
  --data "$BODY") || { echo "login request failed" >&2; exit 1; }

SECRET=$(printf '%s' "$ANSWER" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(s);
    if (typeof j.secret !== "string" || !j.secret) process.exit(1);
    process.stdout.write(j.secret);
  } catch { process.exit(1); }
});
') || { echo "login refused (check handle/password): $ANSWER" >&2; exit 1; }

case "$SECRET" in
  *"'"*|*$'\n'*|*$'\r'*) echo "unexpected token format; not saved" >&2; exit 1 ;;
esac

umask 077
{
  printf "DFO_TOKEN='%s'\n" "$SECRET"
  printf "DFO_BASE_URL='%s'\n" "$BASE"
} > "$OUT"
chmod 600 "$OUT"

echo "saved token to $OUT"
echo "run from this folder: node list-character-ids.mjs"
