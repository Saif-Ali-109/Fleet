import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// ---- openai mock (no real HTTP anywhere in this suite) ----

const { FakeOpenAI, ctorCalls } = vi.hoisted(() => {
  const ctorCalls: Record<string, unknown>[] = [];
  class FakeOpenAI {
    opts: Record<string, unknown>;
    models: { list: () => AsyncIterable<never> };
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      ctorCalls.push(opts);
      this.models = {
        list: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              throw new Error("network down");
            },
          }),
        }),
      };
    }
  }
  return { FakeOpenAI, ctorCalls };
});

vi.mock("openai", () => ({ default: FakeOpenAI }));

// ---- env-isolated registry import (OLLAMA_BASE_URL is read at module load) ----

let registry: typeof import("../providers/registry.ts");

const ENV_KEYS = ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "OLLAMA_BASE_URL", "FLEET_PROVIDERS"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  registry = await import("../providers/registry.ts");
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

// ---- provider defs ----

describe("getProviderDef", () => {
  it("exposes the exact SPEC §4 baseURLs", () => {
    expect(registry.getProviderDef("gemini").baseURL).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/",
    );
    expect(registry.getProviderDef("openrouter").baseURL).toBe("https://openrouter.ai/api/v1");
  });

  it("defaults ollama to the local OpenAI-compatible endpoint", () => {
    expect(registry.getProviderDef("ollama").baseURL).toBe("http://localhost:11434/v1");
  });

  it("honors OLLAMA_BASE_URL at module load", async () => {
    vi.resetModules();
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9999/v1";
    const fresh = await import("../providers/registry.ts");
    expect(fresh.getProviderDef("ollama").baseURL).toBe("http://127.0.0.1:9999/v1");
    delete process.env.OLLAMA_BASE_URL;
  });

  it("maps apiKeyEnv per provider (ollama needs none)", () => {
    expect(registry.getProviderDef("gemini").apiKeyEnv).toBe("GEMINI_API_KEY");
    expect(registry.getProviderDef("openrouter").apiKeyEnv).toBe("OPENROUTER_API_KEY");
    expect(registry.getProviderDef("ollama").apiKeyEnv).toBeNull();
  });
});

// ---- key resolution ----

describe("getApiKeyForProvider", () => {
  it("reads the provider's key from env", () => {
    process.env.GEMINI_API_KEY = "g-key";
    process.env.OPENROUTER_API_KEY = "o-key";
    expect(registry.getApiKeyForProvider("gemini")).toBe("g-key");
    expect(registry.getApiKeyForProvider("openrouter")).toBe("o-key");
  });

  it("returns undefined when the env var is unset", () => {
    expect(registry.getApiKeyForProvider("gemini")).toBeUndefined();
    expect(registry.getApiKeyForProvider("openrouter")).toBeUndefined();
  });

  it("always returns undefined for ollama even if a stray var exists", () => {
    process.env.OLLAMA_BASE_URL = "http://x";
    expect(registry.getApiKeyForProvider("ollama")).toBeUndefined();
  });
});

// ---- fleet ordering ----

describe("getFleetProviders", () => {
  it("falls back to the default order when unset", () => {
    expect(registry.getFleetProviders()).toEqual(["gemini", "openrouter", "ollama"]);
  });

  it("falls back to the default order when empty/whitespace", () => {
    process.env.FLEET_PROVIDERS = "";
    expect(registry.getFleetProviders()).toEqual(["gemini", "openrouter", "ollama"]);
    process.env.FLEET_PROVIDERS = "   ";
    expect(registry.getFleetProviders()).toEqual(["gemini", "openrouter", "ollama"]);
  });

  it("parses a valid subset preserving order", () => {
    process.env.FLEET_PROVIDERS = "ollama,gemini";
    expect(registry.getFleetProviders()).toEqual(["ollama", "gemini"]);
  });

  it("skips invalid names with a warning and drops duplicates", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.FLEET_PROVIDERS = "gemini,bogus,gemini,ollama";
    expect(registry.getFleetProviders()).toEqual(["gemini", "ollama"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping unknown provider "bogus"'));
    warn.mockRestore();
  });
});

// ---- missing-key skip ----

describe("hasProviderKey / providersWithKeys", () => {
  it("only ollama qualifies when no key env vars are set", () => {
    expect(registry.hasProviderKey("ollama")).toBe(true);
    expect(registry.hasProviderKey("gemini")).toBe(false);
    expect(registry.hasProviderKey("openrouter")).toBe(false);
    expect(registry.providersWithKeys(["gemini", "openrouter", "ollama"])).toEqual(["ollama"]);
  });

  it("keeps fleet order once keys are present", () => {
    process.env.GEMINI_API_KEY = "g";
    expect(registry.providersWithKeys()).toEqual(["gemini", "ollama"]);
    process.env.OPENROUTER_API_KEY = "o";
    expect(registry.providersWithKeys()).toEqual(["gemini", "openrouter", "ollama"]);
  });
});

// ---- fallback walk (fake attempt fns — no network) ----

describe("withProviderFallback", () => {
  it("fails fast with model:'none' when no candidate provider has keys", async () => {
    // ollama always qualifies, so the zero-keyed state is only reachable when
    // the fleet list itself excludes it (FLEET_PROVIDERS subset without keys).
    process.env.FLEET_PROVIDERS = "gemini,openrouter";
    const attempt = vi.fn(async () => ({ model: "m", ok: true as const }));
    const res = await registry.withProviderFallback("coder", attempt);
    expect(res.ok).toBe(false);
    expect(res.provider).toBeNull();
    expect(res.model).toBe("none");
    expect(res.error).toBe("no provider keys configured");
    expect(res.attempts).toEqual([
      { provider: null, model: "none", ok: false, error: "no provider keys configured" },
    ]);
    expect(attempt).not.toHaveBeenCalled();
  });

  it("returns the first successful attempt and stops the walk", async () => {
    process.env.GEMINI_API_KEY = "g";
    const order: string[] = [];
    const res = await registry.withProviderFallback("coder", async (provider) => {
      order.push(provider);
      return { model: `m-${provider}`, ok: true, value: 42 };
    });
    expect(res.ok).toBe(true);
    expect(res.provider).toBe("gemini");
    expect(res.model).toBe("m-gemini");
    expect(res.value).toBe(42);
    expect(order).toEqual(["gemini"]);
    expect(res.attempts).toEqual([{ provider: "gemini", model: "m-gemini", ok: true }]);
  });

  it("walks left→right on runtime failure, skipping missing keys", async () => {
    process.env.OPENROUTER_API_KEY = "o"; // gemini has no key → skipped
    const tried: string[] = [];
    const res = await registry.withProviderFallback("tester", async (provider) => {
      tried.push(provider);
      if (provider === "openrouter") return { model: "m-or", ok: false, error: "503" };
      return { model: "m-ol", ok: true, value: "done" };
    });
    // gemini skipped pre-call; openrouter failed at runtime → ollama succeeds
    expect(tried).toEqual(["openrouter", "ollama"]);
    expect(res.ok).toBe(true);
    expect(res.provider).toBe("ollama");
    expect(res.attempts).toEqual([
      { provider: "openrouter", model: "m-or", ok: false, error: "503" },
      { provider: "ollama", model: "m-ol", ok: true },
    ]);
  });

  it("records every attempt and fails when all providers fail", async () => {
    process.env.GEMINI_API_KEY = "g";
    const res = await registry.withProviderFallback("analyzer", async () => ({
      model: "m",
      ok: false,
      error: "quota exhausted",
    }));
    expect(res.ok).toBe(false);
    expect(res.provider).toBe("ollama");
    expect(res.model).toBe("m");
    expect(res.error).toBe("quota exhausted");
    expect(res.attempts.map((a) => a.provider)).toEqual(["gemini", "ollama"]);
    for (const a of res.attempts) expect(a.ok).toBe(false);
  });

  it("captures thrown errors as failed attempts", async () => {
    const res = await registry.withProviderFallback("pr", async () => {
      throw new Error("connection refused");
    });
    // ollama is the only keyed candidate and its attempt throws
    expect(res.ok).toBe(false);
    expect(res.provider).toBe("ollama");
    expect(res.model).toBe("none");
    expect(res.error).toBe("connection refused");
    expect(res.attempts).toEqual([
      { provider: "ollama", model: "unknown", ok: false, error: "connection refused" },
    ]);
  });
});

// ---- client factory ----

describe("getClientForProvider", () => {
  it("memoizes one client instance per provider and constructs with the expected gemini opts", () => {
    process.env.GEMINI_API_KEY = "secret-g";
    ctorCalls.length = 0;
    const a = registry.getClientForProvider("gemini");
    expect(ctorCalls).toHaveLength(1);
    const first = ctorCalls[0]!;
    expect(first).toMatchObject({
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      apiKey: "secret-g",
    });
    const b = registry.getClientForProvider("gemini");
    expect(b).toBe(a);
    expect(ctorCalls).toHaveLength(1);
  });

  it("constructs openrouter with an empty apiKey when unset and stamps the recommended headers", () => {
    ctorCalls.length = 0;
    registry.getClientForProvider("openrouter");
    const first = ctorCalls[0]!;
    expect(first).toMatchObject({ baseURL: "https://openrouter.ai/api/v1", apiKey: "" });
    const headers = first.defaultHeaders as Record<string, string>;
    expect(headers["HTTP-Referer"]).toContain("fleet");
    expect(headers["X-Title"]).toBe("Fleet");
  });

  it("constructs ollama without special headers and a placeholder apiKey", () => {
    ctorCalls.length = 0;
    registry.getClientForProvider("ollama");
    expect(ctorCalls[0]).toMatchObject({
      baseURL: "http://localhost:11434/v1",
      apiKey: "ollama",
    });
    expect(ctorCalls[0]!.defaultHeaders).toBeUndefined();
  });
});

// ---- live listing ----

describe("listModelsForProvider", () => {
  it("returns [] when the /models call throws (no crash)", async () => {
    const ids = await registry.listModelsForProvider("gemini");
    expect(ids).toEqual([]);
  });
});
