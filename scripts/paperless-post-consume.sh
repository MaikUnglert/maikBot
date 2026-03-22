#!/bin/bash
# Paperless-ngx post-consumption script: trigger maikBot document classification
#
# 1. Create this script (e.g. in /opt/paperless/scripts/paperless-post-consume.sh)
# 2. chmod +x paperless-post-consume.sh
# 3. In Paperless: Settings -> Mail -> Post-consumption script
#    Set to: /opt/paperless/scripts/paperless-post-consume.sh
#
# Env vars Paperless passes: DOCUMENT_ID, DOCUMENT_FILE_NAME, etc.
# See: https://docs.paperless-ngx.com/advanced_usage/#post-consumption-script

DOCUMENT_ID="${DOCUMENT_ID:?}"
# maikBot webhook URL - must be reachable from Paperless host (e.g. http://192.168.178.50:3080)
MAIKBOT_URL="${MAIKBOT_URL:-http://localhost:3080}"
WEBHOOK_SECRET="${PAPERLESS_CLASSIFY_WEBHOOK_SECRET:-}"

BODY=$(printf '{"documentId":%s}' "$DOCUMENT_ID")

HEADERS=(-H "Content-Type: application/json")
if [ -n "$WEBHOOK_SECRET" ]; then
  HEADERS+=(-H "Authorization: Bearer $WEBHOOK_SECRET")
fi

curl -sS -X POST "${MAIKBOT_URL}/api/paperless-classify" \
  "${HEADERS[@]}" \
  -d "$BODY" \
  --connect-timeout 10 \
  --max-time 120
