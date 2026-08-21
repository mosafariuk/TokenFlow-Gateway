#!/usr/bin/env bash
# End-to-end smoke test against a running stack (docker compose up).
set -euo pipefail

GATEWAY="${GATEWAY:-http://localhost:8080}"
MODEL="${MODEL:-mock-llm}"
ADMIN_TOKEN="${ADMIN_TOKEN:-dev-admin-token}"

echo "==> health"
curl -fsS "$GATEWAY/healthz" | python3 -m json.tool

echo "==> create api key"
KEY_JSON=$(curl -fsS -X POST "$GATEWAY/admin/keys" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"smoke-test","tpm_limit":50000,"rpm_limit":100,"priority":1}')
API_KEY=$(echo "$KEY_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["key"])')
echo "    key: ${API_KEY:0:12}..."

echo "==> non-streaming chat completion"
curl -fsS -X POST "$GATEWAY/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"'"$MODEL"'","messages":[{"role":"user","content":"What is a token-aware gateway?"}],"max_tokens":32,"temperature":0}' \
  | python3 -m json.tool | head -20

echo "==> repeat same request (expect x-cache: exact)"
curl -fsS -D - -o /dev/null -X POST "$GATEWAY/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"'"$MODEL"'","messages":[{"role":"user","content":"What is a token-aware gateway?"}],"max_tokens":32,"temperature":0}' \
  | grep -i -E "^(x-cache|x-backend|x-ratelimit)"

echo "==> streaming completion (first lines)"
STREAM=$(curl -fsS -N -X POST "$GATEWAY/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"'"$MODEL"'","messages":[{"role":"user","content":"stream me"}],"max_tokens":16,"stream":true}')
echo "$STREAM" | head -5
echo "$STREAM" | tail -3

echo "==> backend/queue status"
curl -fsS "$GATEWAY/admin/status" -H "Authorization: Bearer $ADMIN_TOKEN" | python3 -m json.tool

echo "==> usage report"
curl -fsS "$GATEWAY/admin/usage" -H "Authorization: Bearer $ADMIN_TOKEN" | python3 -m json.tool

echo "SMOKE OK"
