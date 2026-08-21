// Overload-burst benchmark: N concurrent heavy, unique (cache-bypassing) requests.
// Usage: BENCH_KEY=tfg-... node scripts/burst.mjs [N] [maxTokens]
const N = Number(process.argv[2] ?? 200);
const MAX_TOKENS = Number(process.argv[3] ?? 2000);
const GATEWAY = process.env.GATEWAY ?? "http://localhost:8080";
const KEY = process.env.BENCH_KEY;
if (!KEY) {
  console.error("BENCH_KEY env var required");
  process.exit(1);
}

const t0 = Date.now();
const results = await Promise.all(
  Array.from({ length: N }, async (_, i) => {
    const start = Date.now();
    try {
      const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: process.env.MODEL ?? "mock-llm",
          temperature: 0.7,
          max_tokens: MAX_TOKENS,
          messages: [{ role: "user", content: `overload burst request number ${i}` }]
        })
      });
      await res.text();
      return {
        status: res.status,
        ms: Date.now() - start,
        queuedMs: Number(res.headers.get("x-queued-ms") ?? 0),
        backend: res.headers.get("x-backend")
      };
    } catch (e) {
      return { status: 0, ms: Date.now() - start, error: String(e) };
    }
  })
);

const ok = results.filter((r) => r.status === 200);
const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
const q = ok.map((r) => r.queuedMs).sort((a, b) => a - b);
const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
const byBackend = {};
for (const r of ok) byBackend[r.backend] = (byBackend[r.backend] ?? 0) + 1;

console.log(
  JSON.stringify(
    {
      totalRequests: N,
      succeeded: ok.length,
      failed: N - ok.length,
      wallClockMs: Date.now() - t0,
      latencyMs: { p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99), max: lat[lat.length - 1] },
      queuedMs: { p50: pct(q, 0.5), p95: pct(q, 0.95), p99: pct(q, 0.99), max: q[q.length - 1] },
      queuedCount: ok.filter((r) => r.queuedMs > 0).length,
      byBackend
    },
    null,
    2
  )
);
