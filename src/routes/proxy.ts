import { request as undiciRequest } from "undici";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { authenticate } from "../auth.js";
import { logRequest } from "../db.js";
import { orderCandidates } from "../balancer.js";
import type { BackendState } from "../backends.js";
import { QueueTimeoutError, QueueAbortedError } from "../queue.js";
import { estimateRequestWeight, countTokens } from "../tokenizer.js";
import { isCacheable, cacheKey } from "../cache.js";
import type { GatewayContext } from "../server.js";
import type { CompletionRequest, Usage, CacheHit } from "../types.js";

interface NormalizedResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<Record<string, unknown>>;
  usage?: Usage;
}

export function registerProxyRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.post("/v1/chat/completions", (req, reply) => handleProxy(req, reply, ctx, "chat"));
  app.post("/v1/completions", (req, reply) => handleProxy(req, reply, ctx, "completion"));

  // Convenience passthrough so OpenAI SDKs can list models.
  app.get("/v1/models", async (_req, reply) => {
    const backend = ctx.registry.backends.find((b) => b.healthy);
    if (!backend) return reply.code(503).send({ error: "no healthy backends" });
    const res = await undiciRequest(`${backend.url}/v1/models`);
    reply.code(res.statusCode).send(await res.body.json());
  });
}

async function handleProxy(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: GatewayContext,
  kind: "chat" | "completion"
): Promise<void> {
  const startedAt = Date.now();

  // --- 1. Authentication ---
  const apiKey = await authenticate(req.headers.authorization);
  if (!apiKey) {
    return reply.code(401).send({ error: { message: "Invalid or missing API key", type: "invalid_request_error" } });
  }

  const body = req.body as CompletionRequest;
  if (!body || typeof body !== "object" || !body.model) {
    return reply.code(400).send({ error: { message: "Request body must include a model", type: "invalid_request_error" } });
  }
  const streaming = body.stream === true;

  // --- 2. Pre-flight token estimation ---
  const { promptTokens, weight } = estimateRequestWeight(body, config.defaultMaxTokens);

  // --- 3. Rate limiting (RPM + TPM, charged on the estimate) ---
  const rl = await ctx.rateLimiter.check(apiKey, weight);
  reply.header("x-ratelimit-remaining-requests", rl.remainingRequests);
  reply.header("x-ratelimit-remaining-tokens", rl.remainingTokens);
  if (!rl.allowed) {
    return reply.code(429).send({
      error: {
        message: `Rate limit exceeded (${rl.limit === "tpm" ? "tokens" : "requests"} per minute)`,
        type: "rate_limit_error"
      }
    });
  }

  // --- 4. Cache lookup ---
  let cacheHit: CacheHit = "none";
  const cacheable = isCacheable(body);
  const key = cacheable ? cacheKey(body) : "";
  if (cacheable) {
    let cached = (await ctx.cache.getExact(key)) as NormalizedResponse | null;
    if (cached) {
      cacheHit = "exact";
    } else {
      cached = (await ctx.cache.getSemantic(body)) as NormalizedResponse | null;
      if (cached) cacheHit = "semantic";
    }
    if (cached) {
      const usage = cached.usage ?? { prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: promptTokens };
      await ctx.rateLimiter.reconcile(apiKey, weight, 0); // cache hits cost no backend tokens
      void logRequest({
        apiKeyId: apiKey.id, model: body.model, backend: null,
        promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
        queuedMs: 0, latencyMs: Date.now() - startedAt, cacheHit, status: 200
      }).catch((err) => req.log.error({ err }, "request log failed"));
      reply.header("x-cache", cacheHit);
      if (streaming) return replayAsSse(reply, cached, kind);
      return reply.code(200).send(cached);
    }
  }

  // --- 5. Admission control: pick a backend or wait in the priority queue ---
  const abort = new AbortController();
  req.raw.on("close", () => {
    if (!reply.raw.writableEnded) abort.abort();
  });

  // Admission = securing an atomic Redis reservation on some backend. The
  // pending snapshot orders candidates; the Lua reserve is the actual gate,
  // so no two workers can ever admit into the same headroom.
  const tryAdmit = async (): Promise<BackendState | null> => {
    const pending = await ctx.reservations.pendingFor(ctx.registry.backends);
    for (const b of orderCandidates(ctx.registry.backends, weight, config.heavyPromptThreshold, pending)) {
      if (await ctx.reservations.tryReserve(b, weight)) return b;
    }
    return null;
  };

  let queuedMs = 0;
  let backend = await tryAdmit();
  if (!backend) {
    try {
      const admitted = await ctx.queue.waitForTurn(apiKey.priority, tryAdmit, config.queueTimeoutMs, abort.signal);
      backend = admitted.value;
      queuedMs = admitted.queuedMs;
    } catch (err) {
      await ctx.rateLimiter.reconcile(apiKey, weight, 0);
      if (err instanceof QueueAbortedError) return; // client went away
      if (err instanceof QueueTimeoutError) {
        return reply.code(503).send({
          error: { message: "All backends at capacity; request timed out in queue", type: "overloaded_error" }
        });
      }
      throw err;
    }
  }

  // --- 6. Dispatch (reservation already held) ---
  reply.header("x-backend", backend.name);
  reply.header("x-queued-ms", queuedMs);

  const path = kind === "chat" ? "/v1/chat/completions" : "/v1/completions";
  const forwardBody: CompletionRequest = { ...body };
  if (streaming && !forwardBody.stream_options) {
    // Ask vLLM to append a usage chunk so we can meter streamed responses exactly.
    forwardBody.stream_options = { include_usage: true };
  }

  let status = 502;
  let usage: Usage | null = null;
  try {
    const res = await undiciRequest(`${backend.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(forwardBody),
      signal: abort.signal,
      headersTimeout: 30_000,
      bodyTimeout: 300_000
    });
    status = res.statusCode;

    if (status !== 200) {
      const errBody = await res.body.text();
      reply.code(status).header("content-type", "application/json");
      return reply.send(safeJson(errBody) ?? { error: { message: "Upstream error", type: "upstream_error" } });
    }

    if (streaming) {
      const result = await pipeSse(reply, res.body, kind, body.model);
      usage = result.usage ?? {
        prompt_tokens: promptTokens,
        completion_tokens: countTokens(result.content),
        total_tokens: promptTokens + countTokens(result.content)
      };
      if (cacheable && result.finished) {
        const normalized = normalizeStreamed(kind, body.model, result.content, usage);
        await ctx.cache.setExact(key, normalized);
        await ctx.cache.setSemantic(key, body, normalized);
      }
    } else {
      const json = (await res.body.json()) as NormalizedResponse;
      usage = json.usage ?? null;
      if (cacheable) {
        await ctx.cache.setExact(key, json);
        await ctx.cache.setSemantic(key, body, json);
      }
      reply.code(200).send(json);
    }
  } catch (err) {
    if (abort.signal.aborted) {
      req.log.info("client disconnected mid-request");
    } else {
      req.log.error({ err }, "backend request failed");
      if (!reply.sent) {
        reply.code(502).send({ error: { message: "Failed to reach inference backend", type: "upstream_error" } });
      }
    }
  } finally {
    await ctx.reservations.release(backend, weight);
    const actualTokens = usage ? usage.total_tokens : weight;
    await ctx.rateLimiter.reconcile(apiKey, weight, actualTokens);
    void logRequest({
      apiKeyId: apiKey.id, model: body.model, backend: backend.name,
      promptTokens: usage?.prompt_tokens ?? promptTokens,
      completionTokens: usage?.completion_tokens ?? 0,
      queuedMs, latencyMs: Date.now() - startedAt, cacheHit, status
    }).catch((err) => req.log.error({ err }, "request log failed"));
  }
}

/** Pipe an upstream SSE stream to the client, collecting content and usage as it passes. */
async function pipeSse(
  reply: FastifyReply,
  upstream: AsyncIterable<Buffer>,
  kind: "chat" | "completion",
  model: string
): Promise<{ content: string; usage: Usage | null; finished: boolean }> {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });

  let content = "";
  let usage: Usage | null = null;
  let finished = false;
  let pending = "";

  for await (const chunk of upstream) {
    reply.raw.write(chunk);
    pending += chunk.toString("utf8");
    // Parse complete SSE events for metering; partial lines stay in `pending`.
    let idx: number;
    while ((idx = pending.indexOf("\n\n")) !== -1) {
      const event = pending.slice(0, idx);
      pending = pending.slice(idx + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          finished = true;
          continue;
        }
        const parsed = safeJson(data) as {
          usage?: Usage;
          choices?: Array<{ delta?: { content?: string }; text?: string }>;
        } | null;
        if (!parsed) continue;
        if (parsed.usage) usage = parsed.usage;
        const choice = parsed.choices?.[0];
        if (kind === "chat" && choice?.delta?.content) content += choice.delta.content;
        if (kind === "completion" && choice?.text) content += choice.text;
      }
    }
  }
  reply.raw.end();
  return { content, usage, finished };
}

/** Serve a cached (non-stream) response body to a client that asked for SSE. */
function replayAsSse(reply: FastifyReply, cached: NormalizedResponse, kind: "chat" | "completion"): void {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  const created = Math.floor(Date.now() / 1000);
  const id = cached.id ?? "cached";
  const choice = cached.choices?.[0] ?? {};
  const text =
    kind === "chat"
      ? String((choice as { message?: { content?: string } }).message?.content ?? "")
      : String((choice as { text?: string }).text ?? "");

  const send = (payload: unknown) => reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);

  if (kind === "chat") {
    send({ id, object: "chat.completion.chunk", created, model: cached.model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    // Replay in a few coarse chunks — the tokens already exist, no need to trickle.
    for (const piece of splitChunks(text, 64)) {
      send({ id, object: "chat.completion.chunk", created, model: cached.model,
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
    }
    send({ id, object: "chat.completion.chunk", created, model: cached.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  } else {
    for (const piece of splitChunks(text, 64)) {
      send({ id, object: "text_completion", created, model: cached.model,
        choices: [{ index: 0, text: piece, finish_reason: null }] });
    }
    send({ id, object: "text_completion", created, model: cached.model,
      choices: [{ index: 0, text: "", finish_reason: "stop" }] });
  }
  reply.raw.write("data: [DONE]\n\n");
  reply.raw.end();
}

function normalizeStreamed(kind: "chat" | "completion", model: string, content: string, usage: Usage): NormalizedResponse {
  const created = Math.floor(Date.now() / 1000);
  if (kind === "chat") {
    return {
      id: "reconstructed", object: "chat.completion", created, model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage
    };
  }
  return {
    id: "reconstructed", object: "text_completion", created, model,
    choices: [{ index: 0, text: content, finish_reason: "stop" }],
    usage
  };
}

function splitChunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function safeJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
