import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerQuestion, ProviderError } from "../lib/answer";
import { demoKnowledge } from "../lib/knowledge";
import { UNKNOWN_ANSWER } from "../lib/retrieval";
import type { ChatRequest } from "../lib/types";

const request: ChatRequest = { question: "Какие условия гарантии?", history: [], knowledge: demoKnowledge };
function responseFor(value: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
}
beforeEach(() => {
  vi.stubEnv("LLM_API_KEY", "");
  vi.stubEnv("LLM_BASE_URL", "https://api.example.invalid/v1");
  vi.stubEnv("LLM_MODEL", "test-model");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("local extractive mode", () => {
  it("quotes a real source verbatim and labels the mode", async () => {
    const answer = await answerQuestion(request);
    expect(answer.mode).toBe("local");
    expect(answer.status).toBe("answered");
    expect(answer.answer).toBe(demoKnowledge[3].content);
    expect(answer.sources.map(({ id }) => id)).toEqual(["faq-4"]);
  });

  it("does not invent an unsupported answer", async () => {
    const answer = await answerQuestion({ ...request, question: "Какая погода завтра?" });
    expect(answer).toEqual({ answer: UNKNOWN_ANSWER, mode: "local", status: "unknown", sources: [] });
  });

  it("clarifies a greeting without presenting a fake source", async () => {
    const answer = await answerQuestion({ ...request, question: "Здравствуйте!" });
    expect(answer.status).toBe("clarification");
    expect(answer.sources).toEqual([]);
  });

  it("preserves the prior source when the customer says a step failed", async () => {
    const answer = await answerQuestion({
      ...request,
      question: "А если это не помогло?",
      history: [{ role: "assistant", content: demoKnowledge[6].content, sourceIds: ["faq-7"] }],
    });
    expect(answer.status).toBe("clarification");
    expect(answer.sources.map(({ id }) => id)).toEqual(["faq-7"]);
    expect(answer.answer).toContain(demoKnowledge[6].content);
  });
});

describe("server-side model adapter", () => {
  beforeEach(() => vi.stubEnv("LLM_API_KEY", "test-key-not-a-credential"));

  it("sends grounded context and history, and accepts an answer citing a retrieved source", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseFor({ status: "answered", answer: "Гарантия — 12 месяцев.", sourceIds: ["faq-4"] }));
    vi.stubGlobal("fetch", fetchMock);
    const answer = await answerQuestion({ ...request, history: [{ role: "user", content: "Я приобрёл TL-100" }] });
    expect(answer).toMatchObject({ answer: "Гарантия — 12 месяцев.", mode: "llm", status: "answered" });
    expect(answer.sources.map(({ id }) => id)).toEqual(["faq-4"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.example.invalid/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer test-key-not-a-credential");
    const payload = JSON.parse(init.body);
    expect(payload.model).toBe("test-model");
    expect(payload.messages[0].content).toContain(demoKnowledge[3].content);
    expect(payload.messages[1]).toEqual({ role: "user", content: "Я приобрёл TL-100" });
    expect(payload.messages.at(-1)).toEqual({ role: "user", content: request.question });
    expect(payload.response_format).toEqual({ type: "json_object" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("never calls the model for an entirely unsupported question", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const answer = await answerQuestion({ ...request, question: "Расскажи анекдот" });
    expect(answer.status).toBe("unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { status: "answered", answer: "Гарантия — 12 месяцев.", sourceIds: [] },
    { status: "answered", answer: "Гарантия — 12 месяцев.", sourceIds: ["invented-source"] },
    { status: "answered", answer: "Гарантия — 12 месяцев." },
    { status: "answered", answer: "", sourceIds: ["faq-4"] },
    { status: "unrecognized", answer: "Ответ", sourceIds: ["faq-4"] },
  ])("rejects malformed or ungrounded model output: %j", async (value) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFor(value)));
    await expect(answerQuestion(request)).rejects.toBeInstanceOf(ProviderError);
  });

  it("replaces an unknown response with the safe standard fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFor({ status: "unknown", answer: "Maybe you should replace the router.", sourceIds: [] })));
    const answer = await answerQuestion(request);
    expect(answer.answer).toBe(UNKNOWN_ANSWER);
    expect(answer.sources).toEqual([]);
    expect(answer.status).toBe("unknown");
  });

  it("accepts a clarification that makes no unsupported factual claim", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFor({ status: "clarification", answer: "Уточните дату покупки.", sourceIds: [] })));
    expect(await answerQuestion(request)).toMatchObject({ status: "clarification", sources: [], mode: "llm" });
  });

  it.each([401, 403, 429, 500])("handles provider HTTP %i without exposing its response", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("sensitive-provider-details", { status })));
    await expect(answerQuestion(request)).rejects.toBeInstanceOf(ProviderError);
    await expect(answerQuestion(request)).rejects.not.toThrow("sensitive-provider-details");
  });

  it("turns a network timeout into a user-facing provider error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("Timed out", "TimeoutError")));
    await expect(answerQuestion(request)).rejects.toThrow("Модель не ответила вовремя");
  });

  it.each(["http://api.example.invalid/v1", "https://user:password@example.invalid/v1", "not-a-url"]) (
    "rejects an unsafe configured provider URL before sending the key: %s", async (baseUrl) => {
      vi.stubEnv("LLM_BASE_URL", baseUrl);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(answerQuestion(request)).rejects.toBeInstanceOf(ProviderError);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
