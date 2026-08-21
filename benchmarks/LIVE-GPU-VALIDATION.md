# Live GPU validation — real vLLM backend (2026-08-21)

Everything else in this folder uses the bundled mock backend. This run put the gateway
in front of a **real vLLM engine on a real GPU** to validate the integration end to end.

## Environment

| | |
|---|---|
| GPU | NVIDIA RTX A6000, 49,140 MiB (ThunderCompute instance, 6 vCPU, 48 GB RAM) |
| Driver / OS | 610.43.02 / Ubuntu 22.04.5, Python 3.12 |
| Engine | **vLLM 0.27.1**, `microsoft/Phi-3-mini-4k-instruct`, `--max-model-len 4096 --gpu-memory-utilization 0.90` |
| Engine-reported capacity | `GPU KV cache size: 94,048 tokens` → `capacityTokens: 94048` |
| Gateway | v1.0 native, PM2 cluster ×4, Redis 6 + PostgreSQL 14 standalone on the same host |

Note for virtualized GPUs (ThunderCompute and similar): vLLM 0.27's default model runner
maps pinned host memory into the GPU address space (`cudaHostGetDevicePointer`), which
the virtualization layer rejects. `VLLM_USE_V2_MODEL_RUNNER=0` selects the established
runner and works.

## What was verified

| Check | Result |
|---|---|
| `/healthz` sees the real backend | `{"name":"vllm-a6000","healthy":true}` |
| Telemetry polling | Gateway-polled `kvCacheUsage` tracked vLLM's native `vllm:kv_cache_usage_perc` throughout a burst (peaks 0.067 vs 0.061, 1 s poll) |
| Pre-flight estimation | cl100k estimate **15** vs Phi-3 tokenizer actual **11** for the smoke prompt — errs conservative (over-reserves), the safe direction |
| Chat completion through gateway | Real Phi-3 output, real `usage` from the engine recorded in `request_logs` |
| Exact cache on repeat | `x-cache: exact`, zero GPU work |
| SSE streaming through gateway | Byte-for-byte passthrough incl. vLLM's usage chunk (`system_fingerprint: vllm-0.27.1`) enabled by the gateway's `include_usage` injection |
| Smoke suite (`MODEL=microsoft/Phi-3-mini-4k-instruct ./scripts/smoke.sh`) | **SMOKE OK** |

## Overload burst on the real GPU

40 concurrent requests, `max_tokens: 3000` (~3,060 tokens weight) against 94,048 tokens of
engine capacity → admission math allows 30 concurrent.

| Metric | Value |
|---|---|
| Succeeded / failed | **40 / 0** |
| Queued by gateway | 9 (peak queue depth 9, max wait 5.5 s) |
| Peak `num_requests_running` at vLLM | 31 |
| Peak Redis reservation ledger | **93,465 / 94,048 tokens (99.4%)** |
| Wall clock | 15.8 s |

## Two real-hardware findings

1. **Metric rename (bug, fixed).** vLLM 0.27 exports `vllm:kv_cache_usage_perc`; the
   gateway only matched the older `vllm:gpu_cache_usage_perc` and would have read 0% forever
   against a current engine. The parser now accepts both. The mock could never have caught
   this — it is exactly why this validation exists.
2. **Reservation vs. actual usage gap (design trade-off, documented).** Reservations peaked
   at 99% of capacity while the engine's real KV usage peaked near 6%: the gateway budgets the
   full `max_tokens` up front, but vLLM allocates KV incrementally and Phi-3 reached EOS far
   below 3,000 tokens. This is conservative by construction — it can only under-admit, never
   over-admit — but clients that set large `max_tokens` and generate short outputs leave GPU
   headroom idle. Mitigations today: realistic `max_tokens` from clients, lower
   `DEFAULT_MAX_TOKENS`. Roadmap: adaptive output budgets from observed completion lengths.

---

# Consumer hardware (24 GB): RTX 3090 — 2026-08-22

Same suite, on the card most of r/LocalLLaMA actually owns.

| | |
|---|---|
| GPU | **NVIDIA GeForce RTX 3090, 24,576 MiB** (Vast.ai on-demand, $0.113/hr) |
| Driver / OS | 580.159.03 / Ubuntu 22.04.5 (`vllm/vllm-openai:latest` image) |
| Engine | vLLM 0.27.1, `microsoft/Phi-3-mini-4k-instruct`, `--max-model-len 4096 --gpu-memory-utilization 0.90`, default model runner (no workaround needed on bare GPU) |
| Engine-reported capacity | **`GPU KV cache size: 36,943 tokens`** → `capacityTokens: 36943` (9.02× concurrency at 4,096) |
| Gateway | v1.0 native, PM2 cluster ×4, Redis + PostgreSQL 14 on the same host |

Operational note: the first model download failed on Hugging Face's Xet transfer path
(`ConnectionError … xet-read-token`); `HF_HUB_DISABLE_XET=1` falls back to plain HTTP and
worked first time. Worth knowing for any container-hosted vLLM.

## Verification

| Check | Result |
|---|---|
| `MODEL=microsoft/Phi-3-mini-4k-instruct ./scripts/smoke.sh` | **SMOKE OK** — real completion, `x-cache: exact` on repeat, SSE passthrough with vLLM's usage chunk |
| Telemetry polling | gateway `kvCacheUsage` tracked native `vllm:kv_cache_usage_perc` (peaks 0.081 vs 0.077) |

## Overload burst on the RTX 3090

30 concurrent requests, `max_tokens: 3000` (~3,015 tokens weight) against 36,943 tokens of
engine capacity → admission math allows **12** concurrent.

| Metric | Value |
|---|---|
| Succeeded / failed | **30 / 0** |
| Queued by gateway | **18** (exactly as computed; peak queue depth 18) |
| Peak `num_requests_running` at vLLM | **12 — the cap** |
| Peak Redis reservation ledger | **36,180 / 36,943 tokens (97.9%)** |
| Queue wait p50 / max | 4.3 s / 9.3 s (30 s budget) |
| Wall clock | 20.3 s |

## A6000 (48 GB) vs RTX 3090 (24 GB) side by side

| | A6000 48 GB | RTX 3090 24 GB |
|---|---|---|
| Engine KV capacity (Phi-3-mini, 4k ctx) | 94,048 tokens | 36,943 tokens |
| Heavy requests admitted concurrently (3k-token weight) | 30 | 12 |
| Burst outcome | 40/40, 9 queued, 0 failures | 30/30, 18 queued, 0 failures |
| Reservation ledger peak vs capacity | 99.4% | 97.9% |

Same gateway, same config shape, one number changed (`capacityTokens`, read from the
engine's own startup log) — and the admission schedule adapted exactly to the smaller
card. That is the hardware-agnostic claim, measured.
