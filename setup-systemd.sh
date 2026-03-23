#!/bin/bash
# Install maikBot as a systemd service (Debian/Ubuntu)
# Usage: sudo ./setup-systemd.sh [--install]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR" && pwd)"
BACKEND_DIR="$PROJECT_ROOT/backend"
SERVICE_NAME="maikbot"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# Use the user who owns the project (or SUDO_USER if running with sudo)
RUN_USER="${SUDO_USER:-$(whoami)}"
NODE_PATH="$(command -v node)"

echo "maikBot systemd setup"
echo "  Project: $PROJECT_ROOT"
echo "  User:    $RUN_USER"
echo "  Node:    $NODE_PATH"
echo ""

if [ ! -f "$BACKEND_DIR/package.json" ]; then
  echo "Error: backend/package.json not found. Run from maikBot project root."
  exit 1
fi

if [ ! -d "$BACKEND_DIR/dist" ]; then
  echo "Building backend..."
  (cd "$BACKEND_DIR" && npm run build)
fi

SERVICE_CONTENT="[Unit]
Description=maikBot (Telegram/WhatsApp assistant)
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$BACKEND_DIR
ExecStart=$NODE_PATH dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
"

if [ "${1:-}" = "--install" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "Run with sudo to install: sudo $0 --install"
    exit 1
  fi
  echo "Installing $SERVICE_FILE ..."
  echo "$SERVICE_CONTENT" > "$SERVICE_FILE"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  echo ""
  echo "Done. Start with: sudo systemctl start $SERVICE_NAME"
  echo "Status:  sudo systemctl status $SERVICE_NAME"
  echo "Logs:    journalctl -u $SERVICE_NAME -f"
else
  echo "Preview of $SERVICE_FILE:"
  echo "---"
  echo "$SERVICE_CONTENT"
  echo "---"
  echo ""
  echo "To install, run: sudo $0 --install"
fi
