#!/bin/bash

set -euo pipefail

echo "maikBot setup (Telegram + Ollama + MCP)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is missing. Please install Node.js 22+."
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d'.' -f1)
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Warning: detected Node.js $(node -v), recommended is 22+"
fi

cd "$(dirname "$0")/backend"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created backend/.env from .env.example. Please set your values."
fi

npm install

echo ""
echo "Done. Next steps:"
echo "1) Configure backend/.env"
echo "2) npm run dev"
