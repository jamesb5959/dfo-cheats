#!/usr/bin/env bash
# One-command setup for the private own-account toolkit.
set -euo pipefail
cd "$(dirname "$0")"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1" >&2; exit 1; }; }
need node
need python3
need curl

if [ ! -d ../daggerfall-js-source ]; then
  echo "The game source checkout is missing." >&2
  echo "Place this repository next to the 'daggerfall-js-source' directory:" >&2
  echo "  parent/" >&2
  echo "    daggerfall-js-source/" >&2
  echo "    $(basename "$PWD")/" >&2
  exit 1
fi

chmod +x dfo-tui dfo-token.sh

if [ ! -f .config ]; then
  echo "No .config yet. The next step asks for your handle and password."
  ./dfo-token.sh
fi

echo
echo "Setup complete."
echo "Start the control panel with:  ./dfo-tui"
echo "The token is stored in .config (ignored by git; never share it)."
