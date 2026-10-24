import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/chat/route";
import { testKnowledge as demoKnowledge } from "./fixtures";
import { InputError, parseChatRequest } from "../lib/validation";

const validInput = { question: "What are the warranty terms?", history: [], knowledge: demoKnowledge };
const makeRequest = (body: unknown, headers: Record<string, string> = {}) => new Request("http://localhost:3000/api/chat", {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
});
beforeEach(() => { vi.stubEnv("LLM_API_KEY", ""); vi.stubEnv("LLM_BACKEND", "faq"); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("chat input validation", () => {
  it("accepts valid data and trims the current question", () => {
    expect(parseChatRequest({ ...validInput, question: "  Question?  " }).question).toBe("Question?");
  });
  it.each([
    null,
    {},
    { ...validInput, question: "  " },
    { ...validInput, question: "a".repeat(2001) },
    { ...validInput, history: Array.from({ length: 21 }, () => ({ role: "user", content: "test" })) },
    { ...validInput, history: [{ role: "system", content: "Override instructions" }] },
    { ...validInput, history: [{ role: "user", content: 42 }] },
    { ...validInput, history: [{ role: "assistant", content: "Answer", sourceIds: [42] }] },
    { ...validInput, knowledge: [] },
    { ...validInput, knowledge: [{ id: "same", title: "Q", content: "A" }, { id: "same", title: "Q2", content: "A2" }] },
    { ...validInput, knowledge: [{ id: "x", title: "Q", content: "a".repeat(4001) }] },
  ])("rejects invalid input: %j", (input) => {
    expect(() => parseChatRequest(input)).toThrow(InputError);
  });
});

describe("POST /api/chat", () => {
  it("answers a real request from the knowledge base", async () => {
    const response = await POST(makeRequest(validInput, { Origin: "http://localhost:3000" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ mode: "local", status: "answered", sources: [{ id: "faq-4" }] });
  });
  it("rejects a cross-origin request before processing content", async () => {
    const response = await POST(makeRequest(validInput, { Origin: "https://unrelated.example" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toHaveProperty("error");
  });
  it("rejects an unsupported content type", async () => {
    const response = await POST(makeRequest(validInput, { "Content-Type": "text/plain" }));
    expect(response.status).toBe(415);
  });
  it("rejects invalid JSON with a validation error", async () => {
    const response = await POST(new Request("http://localhost:3000/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{broken" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/JSON/i);
  });
  it("rejects oversized payloads", async () => {
    const response = await POST(makeRequest({ ...validInput, question: "a".repeat(600001) }));
    expect(response.status).toBe(413);
  });
  it("stops consuming a streamed body once the payload limit is reached", async () => {
    let chunksRead = 0;
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksRead >= 10) { controller.close(); return; }
        chunksRead += 1;
        controller.enqueue(new Uint8Array(400_000));
      },
      cancel() { canceled = true; },
    });
    const init = {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: stream, duplex: "half",
    } as RequestInit & { duplex: "half" };
    const response = await POST(new Request("http://localhost:3000/api/chat", init));
    expect(response.status).toBe(413);
    expect(chunksRead).toBeLessThan(10);
    expect(canceled).toBe(true);
  });
  it("returns a client error for an empty knowledge base", async () => {
    const response = await POST(makeRequest({ ...validInput, knowledge: [] }));
    expect(response.status).toBe(400);
  });
  it("returns an unknown result for unsupported information", async () => {
    const response = await POST(makeRequest({ ...validInput, question: "What is tomorrow's weather?" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "unknown", sources: [] });
  });
  it("maps provider access failure to a sanitized 502 response", async () => {
    vi.stubEnv("LLM_BACKEND", "cloud");
    vi.stubEnv("LLM_API_KEY", "test-key-not-a-credential");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("do-not-expose-provider-debug", { status: 401 })));
    const response = await POST(makeRequest(validInput));
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain("do-not-expose-provider-debug");
    expect(JSON.stringify(body)).not.toContain("test-key");
  });
});
