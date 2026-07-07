#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display alert "Node.js required" message "Please install Node.js from https://nodejs.org, then double-click this again."'
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)..."
  npm install
fi

(sleep 1 && open "http://localhost:3141") &
node server.js
