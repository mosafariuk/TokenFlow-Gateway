# Benchmark results — 2026-08-10 (v1.0, distributed admission control)

**Headline: admission control is now atomic across workers.** v1.0 moves backend
capacity reservations from per-process memory into atomic Redis Lua check-and-reserve
scripts. The overload burst that bypassed admission in the pre-fix 48-worker cluster
(200 heavy requests dumped on one backend) now behaves identically to a single process:
**peak 16 concurrent heavy requests per backend — exactly the capacity cap — with 168
requests correctly queued**, validated under 48 workers admitting concurrently.

Configurations measured:

1. **EPYC / native PM2 cluster ×48** — gateway native under PM2 (one worker per
   hardware thread); Redis/Postgres/mocks in Docker on loopback.
2. **EPYC / Docker single process** — entire stack containerized.
3. **Apple M1 laptop / Docker single process** — commodity-hardware reference.

**What these numbers measure:** the gateway's own overhead — auth, tokenization,
Lua rate limiting, cache lookup, atomic admission, proxying, usage logging — not GPU
inference. The bundled mock vLLM backend makes that isolation possible.

## Environments

| | Bare metal | Laptop reference |
|---|---|---|
| CPU | **AMD EPYC 9254** (24 cores / 48 threads) | Apple M1 (8 cores) |
| RAM | 188 GB | 8 GB |
| OS | Ubuntu 24.04.4 LTS (kernel 6.17) | macOS (Darwin 25.5.0) |
| Node / Docker | 20.20.2 native, Docker 29.1.3 | Docker 29.3.1 |
| Host tuning | `somaxconn=65535`, `tcp_max_syn_backlog=65535`, ephemeral ports `1024–65000`, `tcp_tw_reuse=1`, `fs.file-max=2M`, `ulimit -n 1M`, Postgres `max_connections=600` | defaults |
| Topology | Stack + load generator on the host, loopback | same |

Load tools: autocannon 8.x — **8 worker threads** for ≥500-connection runs so the
generator is never the bottleneck; `scripts/burst.mjs` for scenario C.
Backends: 2 × mock vLLM, `capacityTokens=32768` each.

## Scenario C — overload burst: the admission-control validation

200 concurrent unique requests, ~2,010 tokens weight each ≈ **6× total admission
capacity** (2 × 32,768 tokens), realistic backend profile (15 ms/token). A sampler
recorded each backend's `num_requests_running` at 100 ms resolution. Capacity math
caps concurrent heavy requests at **16 per backend**.

| Metric | PM2 ×48 **v1.0 (Redis Lua)** | PM2 ×48 pre-fix (in-memory) | Docker ×1 |
|---|---|---|---|
| Succeeded / failed (HTTP) | **200 / 0** | 200 / 0 | 200 / 0 |
| Queued by gateway | **168** | 0 ⚠ | 168 |
| Peak concurrent per backend | **16 / 16 — at the cap** | **200 on one backend** ⚠ | 16 |
| Backend split | 116 / 84 | 200 / 0 ⚠ | 106 / 94 |
| Queue wait p50 / max | 6.6 s / 14.9 s (30 s budget) | — | 6.2 s / 13.1 s |
| Wall clock | 17.0 s (waves draining) | 2.1 s (herd, no control) | 15.2 s |

The pre-fix cluster forwarded ~402k tokens of KV demand into a 32,768-token backend at
once — the exact OOM scenario the gateway exists to prevent, hidden behind a healthy
"200/200". v1.0's atomic check-and-reserve makes 48 concurrent workers produce the
same admission schedule as one process. Reservations carry a TTL
(`RESERVATION_TTL_SECONDS`, default 120 s) as a crash backstop; an orphaned
reservation can only make the gateway *more* conservative (extra queueing) until it
expires — the failure direction is always safe.

## Scenario A — cache-hit path

Identical `temperature: 0` request (primed); auth → estimate → rate limit → Redis exact
cache. Cache hits never take a reservation, so the fix costs this path nothing.

| Configuration | Conns | Req/s avg | Peak 1 s | p50 | p99 | Total (15 s) | Errors |
|---|---|---|---|---|---|---|---|
| EPYC, PM2 ×48 (v1.0) | 1,000 | **30,618** | 32,942 | 30 ms | 40 ms | 459,244 | 0 |
| EPYC, PM2 ×48 (pre-fix) | 1,000 | 31,135 | 32,741 | 31 ms | 38 ms | 467,045 | 0 |
| EPYC, PM2 ×48 (pre-fix) | 500 | 27,686 | 29,125 | 17 ms | 26 ms | 415,261 | 0 |
| EPYC, PM2 ×48 (pre-fix) | 100 | 17,718 | 19,637 | 5 ms | 9 ms | 265,786 | 0 |
| EPYC, Docker ×1 | 100 | 5,058 | 5,704 | 18 ms | 35 ms | 75,863 | 0 |
| M1, Docker ×1 | 100 | 3,100 | 3,847 | 28 ms | 109 ms | 46,496 | 0 |

## Scenario B — full proxy path (zero-delay backend)

`temperature: 0.7` (cache-bypassing), `max_tokens: 8`, mocks at `TOKEN_DELAY_MS=0`.
Everything in A **plus** cache miss, candidate ordering, **atomic Redis reservation**,
upstream proxy, release, usage reconciliation, request logging.

| Configuration | Conns | Req/s avg | Peak 1 s | p50 | p99 | Total (15 s) | Errors |
|---|---|---|---|---|---|---|---|
| EPYC, PM2 ×48 (v1.0) | 500 | **18,598** | 19,142 | 25 ms | 38 ms | 278,972 | 0 |
| EPYC, PM2 ×48 (v1.0) | 100 | **12,432** | 13,204 | 7 ms | 12 ms | 186,473 | 0 |
| EPYC, PM2 ×48 (pre-fix) | 500 | 18,351 | 19,498 | 27 ms | 38 ms | 275,256 | 0 |
| EPYC, PM2 ×48 (pre-fix) | 100 | 16,899 | 17,840 | 5 ms | 9 ms | 253,479 | 0 |
| EPYC, Docker ×1 | 100 | 3,559 | 3,769 | 27 ms | 44 ms | 53,385 | 0 |
| M1, Docker ×1 | 100 | 2,244 | 2,864 | 38 ms | 111 ms | 33,656 | 0 |

**Cost of correctness:** the atomic reservation adds 2–3 Redis round trips per proxied
request. At saturation this is free (18.6k req/s, unchanged — the bottleneck is
elsewhere); at low concurrency it costs ~2 ms p50 (5 → 7 ms) and shows up as lower
throughput in latency-bound runs (16.9k → 12.4k req/s at 100 conns). Given that the
alternative was silently broken multi-worker admission, this is the right trade — and
single-process deployments keep the same correctness with the same overhead.

## Raw data

- `raw-pm2/*-fixed.json` — v1.0 (atomic admission) runs
- `raw-pm2/*.json` — pre-fix cluster runs (kept for the before/after comparison)
- `raw-epyc9254/` — EPYC Docker single-process
- `raw/` — Apple M1 Docker single-process
