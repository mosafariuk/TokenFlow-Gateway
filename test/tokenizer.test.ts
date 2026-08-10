import { describe, expect, it } from "vitest";
import { countTokens, estimatePromptTokens, estimateRequestWeight } from "../src/tokenizer.js";

describe("countTokens", () => {
  it("returns 0 for empty text", () => {
    expect(countTokens("")).toBe(0);
  });

  it("is deterministic and roughly proportional to length", () => {
    const short = countTokens("Hello world");
    const long = countTokens("Hello world ".repeat(100));
    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(short * 50);
    expect(countTokens("Hello world")).toBe(short);
  });
});

describe("estimatePromptTokens", () => {
  it("counts chat messages with per-message overhead", () => {
    const single = estimatePromptTokens({
      model: "m",
      messages: [{ role: "user", content: "Hi there" }]
    });
    const double = estimatePromptTokens({
      model: "m",
      messages: [
        { role: "user", content: "Hi there" },
        { role: "assistant", content: "Hi there" }
      ]
    });
    expect(single).toBeGreaterThan(countTokens("Hi there"));
    expect(double).toBeGreaterThan(single);
  });

  it("handles string and array prompts", () => {
    const one = estimatePromptTokens({ model: "m", prompt: "some text here" });
    const two = estimatePromptTokens({ model: "m", prompt: ["some text here", "some text here"] });
    expect(two).toBe(one * 2);
  });

  it("handles multi-part message content", () => {
    const t = estimatePromptTokens({
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }] }]
    });
    expect(t).toBeGreaterThan(countTokens("part one part two"));
  });
});

describe("estimateRequestWeight", () => {
  it("adds max_tokens as the output budget", () => {
    const r = estimateRequestWeight({ model: "m", prompt: "hello", max_tokens: 500 }, 1024);
    expect(r.outputBudget).toBe(500);
    expect(r.weight).toBe(r.promptTokens + 500);
  });

  it("falls back to the default output budget", () => {
    const r = estimateRequestWeight({ model: "m", prompt: "hello" }, 1024);
    expect(r.outputBudget).toBe(1024);
  });
});
