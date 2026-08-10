import { describe, expect, it } from "vitest";
import { cacheKey, isCacheable, promptText } from "../src/cache.js";

describe("isCacheable", () => {
  it("caches temperature-0 requests", () => {
    expect(isCacheable({ model: "m", prompt: "x", temperature: 0 })).toBe(true);
  });

  it("does not cache sampled (default-temperature) requests", () => {
    expect(isCacheable({ model: "m", prompt: "x" })).toBe(false);
    expect(isCacheable({ model: "m", prompt: "x", temperature: 0.9 })).toBe(false);
  });
});

describe("cacheKey", () => {
  it("is stable for identical requests", () => {
    const a = cacheKey({ model: "m", messages: [{ role: "user", content: "hi" }], temperature: 0 });
    const b = cacheKey({ model: "m", messages: [{ role: "user", content: "hi" }], temperature: 0 });
    expect(a).toBe(b);
  });

  it("differs by model, prompt, and max_tokens", () => {
    const base = { messages: [{ role: "user", content: "hi" }], temperature: 0 };
    const a = cacheKey({ model: "m1", ...base });
    expect(cacheKey({ model: "m2", ...base })).not.toBe(a);
    expect(cacheKey({ model: "m1", ...base, max_tokens: 5 })).not.toBe(a);
    expect(cacheKey({ model: "m1", messages: [{ role: "user", content: "yo" }], temperature: 0 })).not.toBe(a);
  });

  it("ignores irrelevant fields like stream", () => {
    const a = cacheKey({ model: "m", prompt: "x", temperature: 0, stream: true });
    const b = cacheKey({ model: "m", prompt: "x", temperature: 0, stream: false });
    expect(a).toBe(b);
  });
});

describe("promptText", () => {
  it("flattens chat messages", () => {
    expect(promptText({ model: "m", messages: [{ role: "user", content: "hi" }] })).toBe("user: hi");
  });

  it("joins array prompts", () => {
    expect(promptText({ model: "m", prompt: ["a", "b"] })).toBe("a\nb");
  });
});
