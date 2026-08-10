import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";
import type { ChatMessage, CompletionRequest } from "./types.js";

// One shared encoder instance; cl100k is a close-enough estimator for most
// open models — admission control needs speed and consistency, not exactness.
const encoder = new Tiktoken(cl100k_base);

// Per-message overhead for chat-template scaffolding (<|im_start|>role ... <|im_end|>)
const MESSAGE_OVERHEAD_TOKENS = 4;

export function countTokens(text: string): number {
  if (!text) return 0;
  return encoder.encode(text).length;
}

function messageText(m: ChatMessage): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content.map((p) => p.text ?? "").join("");
  }
  return "";
}

export function estimatePromptTokens(body: CompletionRequest): number {
  if (body.messages && body.messages.length > 0) {
    let total = 3; // reply priming
    for (const m of body.messages) {
      total += MESSAGE_OVERHEAD_TOKENS + countTokens(m.role) + countTokens(messageText(m));
    }
    return total;
  }
  const prompts = Array.isArray(body.prompt) ? body.prompt : [body.prompt ?? ""];
  return prompts.reduce((sum, p) => sum + countTokens(p ?? ""), 0);
}

/**
 * The "weight" of a request for admission control and routing:
 * prompt tokens plus the output budget the backend must reserve KV space for.
 */
export function estimateRequestWeight(body: CompletionRequest, defaultMaxTokens: number): {
  promptTokens: number;
  outputBudget: number;
  weight: number;
} {
  const promptTokens = estimatePromptTokens(body);
  const outputBudget = typeof body.max_tokens === "number" ? body.max_tokens : defaultMaxTokens;
  return { promptTokens, outputBudget, weight: promptTokens + outputBudget };
}
