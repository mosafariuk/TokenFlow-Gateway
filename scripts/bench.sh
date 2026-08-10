#!/usr/bin/env bash
# Reproducible benchmark suite. Requires: docker compose stack up, node, npx.
# Results land in benchmarks/raw/ and are summarized to stdout.
set -euo pipefail
cd "$(dirname "$0")/.."

GATEWAY="${GATEWAY:-http://localhost:8080}"
ADMIN_TOKEN="${ADMIN_TOKEN:-dev-admin-token}"
mkdir -p benchmarks/raw

echo "==> creating benchmark API key"
KEY=$(curl -fsS -X POST "$GATEWAY/admin/keys" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"bench","tpm_limit":2147483647,"rpm_limit":2147483647,"priority":1}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["key"])')

CACHED_BODY='{"model":"mock-llm","messages":[{"role":"user","content":"Benchmark: explain token-aware load balancing in one sentence."}],"max_tokens":64,"temperature":0}'
PROXY_BODY='{"model":"mock-llm","messages":[{"role":"user","content":"proxy path benchmark"}],"max_tokens":8,"temperature":0.7}'

echo "==> scenario A: cache-hit path (priming cache first)"
curl -fsS -o /dev/null -X POST "$GATEWAY/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$CACHED_BODY"
npx -y autocannon -m POST \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -b "$CACHED_BODY" -c 100 -d 15 --json "$GATEWAY/v1/chat/completions" \
  > benchmarks/raw/scenario-a-cache-hit.json

echo "==> scenario C: overload burst (realistic 15ms/token profile)"
BENCH_KEY=$KEY node scripts/burst.mjs 200 2000 | tee benchmarks/raw/scenario-c-burst.json

echo "==> scenario B: full proxy path (switching mocks to zero delay)"
TOKEN_DELAY_MS=0 docker compose up -d mock-vllm-0 mock-vllm-1 >/dev/null 2>&1
sleep 2
npx -y autocannon -m POST \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -b "$PROXY_BODY" -c 100 -d 15 --json "$GATEWAY/v1/chat/completions" \
  > benchmarks/raw/scenario-b-proxy.json
docker compose up -d mock-vllm-0 mock-vllm-1 >/dev/null 2>&1  # restore 15ms profile

echo "==> summary"
python3 - <<'PY'
import json
for name, label in [("scenario-a-cache-hit", "A cache-hit"), ("scenario-b-proxy", "B full-proxy")]:
    d = json.load(open(f"benchmarks/raw/{name}.json"))
    lat = d["latency"]
    print(f"{label}: {d['requests']['average']:.0f} req/s avg ({d['requests']['max']} peak), "
          f"p50 {lat['p50']}ms p99 {lat['p99']}ms, "
          f"{d['requests']['total']} reqs, errors {d['errors']} non2xx {d['non2xx']}")
c = json.load(open("benchmarks/raw/scenario-c-burst.json"))
print(f"C overload-burst: {c['succeeded']}/{c['totalRequests']} ok, {c['queuedCount']} queued, "
      f"max queue wait {c['queuedMs']['max']}ms, backends {c['byBackend']}")
PY
echo "BENCH DONE — raw output in benchmarks/raw/"
