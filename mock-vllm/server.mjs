// Mock vLLM server: OpenAI-compatible API + vLLM-style Prometheus metrics.
// Lets the whole gateway stack run and be load-tested without a GPU.
import http from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8000);
const MODEL = process.env.MODEL_NAME ?? "mock-llm";
const TOKEN_DELAY_MS = Number(process.env.TOKEN_DELAY_MS ?? 15);
const CAPACITY_TOKENS = Number(process.env.CAPACITY_TOKENS ?? 32768);
const EMBED_DIM = Number(process.env.EMBED_DIM ?? 384);

let inflightTokens = 0;
let runningRequests = 0;

const WORDS = ("the quick brown fox jumps over the lazy dog while a token aware gateway " +
  "routes prompts to the least loaded inference backend and streams responses").split(" ");

function fakeCompletion(promptLen, maxTokens) {
  const n = Math.max(8, Math.min(maxTokens ?? 64, 128));
  const words = [];
  for (let i = 0; i < n; i++) words.push(WORDS[(promptLen + i * 7) % WORDS.length]);
  return words;
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil((text ?? "").length / 4));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deterministic unit-norm embedding from text hash: identical text → identical
// vector, so exact/semantic cache plumbing is fully exercisable end to end.
function hashEmbedding(text) {
  const v = new Array(EMBED_DIM);
  let seedBuf = createHash("sha256").update(text).digest();
  let k = 0;
  for (let i = 0; i < EMBED_DIM; i++) {
    if (k >= seedBuf.length - 1) {
      seedBuf = createHash("sha256").update(seedBuf).digest();
      k = 0;
    }
    v[i] = (seedBuf.readInt16LE(k) / 32768);
    k += 2;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

async function handleCompletion(req, res, kind) {
  const body = await readBody(req);
  const promptText = kind === "chat"
    ? (body.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n")
    : (Array.isArray(body.prompt) ? body.prompt.join("\n") : body.prompt ?? "");
  const promptTokens = estimateTokens(promptText);
  const words = fakeCompletion(promptText.length, body.max_tokens);
  const completionTokens = words.length;
  const weight = promptTokens + completionTokens;
  const id = `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens
  };

  inflightTokens += weight;
  runningRequests += 1;
  const done = () => {
    inflightTokens = Math.max(0, inflightTokens - weight);
    runningRequests = Math.max(0, runningRequests - 1);
  };

  try {
    if (body.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (kind === "chat") {
        send({ id, object: "chat.completion.chunk", created, model: MODEL,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      }
      for (let i = 0; i < words.length; i++) {
        await sleep(TOKEN_DELAY_MS);
        if (res.destroyed) { done(); return; }
        const text = (i === 0 ? "" : " ") + words[i];
        if (kind === "chat") {
          send({ id, object: "chat.completion.chunk", created, model: MODEL,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
        } else {
          send({ id, object: "text_completion", created, model: MODEL,
            choices: [{ index: 0, text, finish_reason: null }] });
        }
      }
      const finishChunk = kind === "chat"
        ? { id, object: "chat.completion.chunk", created, model: MODEL,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
        : { id, object: "text_completion", created, model: MODEL,
            choices: [{ index: 0, text: "", finish_reason: "stop" }] };
      send(finishChunk);
      if (body.stream_options?.include_usage) {
        send({ id, object: kind === "chat" ? "chat.completion.chunk" : "text_completion",
          created, model: MODEL, choices: [], usage });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      await sleep(TOKEN_DELAY_MS * words.length);
      const text = words.join(" ");
      const payload = kind === "chat"
        ? { id, object: "chat.completion", created, model: MODEL,
            choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage }
        : { id, object: "text_completion", created, model: MODEL,
            choices: [{ index: 0, text, finish_reason: "stop" }], usage };
      json(res, 200, payload);
    }
  } finally {
    done();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { status: "ok" });
    if (req.method === "GET" && url.pathname === "/metrics") {
      const usage = Math.min(1, inflightTokens / CAPACITY_TOKENS);
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(
        `# HELP vllm:gpu_cache_usage_perc GPU KV-cache usage\n` +
        `vllm:gpu_cache_usage_perc ${usage.toFixed(6)}\n` +
        `vllm:kv_cache_usage_perc ${usage.toFixed(6)}\n` +
        `vllm:num_requests_running ${runningRequests}\n` +
        `vllm:num_requests_waiting 0\n`
      );
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return json(res, 200, { object: "list", data: [{ id: MODEL, object: "model", owned_by: "mock" }] });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") return handleCompletion(req, res, "chat");
    if (req.method === "POST" && url.pathname === "/v1/completions") return handleCompletion(req, res, "completion");
    if (req.method === "POST" && url.pathname === "/v1/embeddings") {
      const body = await readBody(req);
      const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
      return json(res, 200, {
        object: "list",
        model: body.model ?? "mock-embed",
        data: inputs.map((text, index) => ({ object: "embedding", index, embedding: hashEmbedding(String(text)) })),
        usage: { prompt_tokens: inputs.reduce((s, t) => s + estimateTokens(String(t)), 0), total_tokens: 0 }
      });
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`mock-vllm (${MODEL}) listening on :${PORT}, ${TOKEN_DELAY_MS}ms/token`);
});
