import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerQuestion, modelConfig, ProviderError } from "../lib/answer";
import { UNKNOWN_ANSWER } from "../lib/retrieval";
import type { ChatRequest } from "../lib/types";
import { testKnowledge } from "./fixtures";
const request: ChatRequest = { question: "What are the warranty terms?", history: [], knowledge: testKnowledge };
const responseFor = (value: unknown, status=200) => new Response(JSON.stringify(value), {status, headers:{"Content-Type":"application/json"}});
beforeEach(() => {
  vi.stubEnv("LLM_BACKEND", "faq"); vi.stubEnv("LLM_API_KEY", "");
  vi.stubEnv("VOICE_API_URL", "http://127.0.0.1:8001");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("explicit extractive FAQ mode", () => {
  it("quotes a real source and identifies the mode", async () => {
    expect(await answerQuestion(request)).toEqual({mode:"local", status:"answered",answer:testKnowledge[3].content,sources:[testKnowledge[3]]});
  });
  it("does not invent an unsupported answer", async () => {
    expect(await answerQuestion({...request, question:"What is tomorrow's weather?"})).toEqual({answer:UNKNOWN_ANSWER,mode:"local",status:"unknown",sources:[]});
  });
  it("clarifies a greeting without inventing a source", async () => {
    expect(await answerQuestion({...request,question:"Hello!"})).toMatchObject({status:"clarification", sources:[]});
  });
  it("preserves the previous source when a step failed", async () => {
    const answer=await answerQuestion({...request,question:"What if that did not help?",history:[{role:"assistant",content:testKnowledge[6].content,sourceIds:["faq-7"]}]});
    expect(answer.status).toBe("clarification");
    expect(answer.sources.map(s=>s.id)).toEqual(["faq-7"]);
    expect(answer.answer).toContain(testKnowledge[6].content);
  });
});
describe("shared text and voice model broker", () => {
  beforeEach(() => vi.stubEnv("LLM_BACKEND", "cloud"));
  const validReply=()=>({status:"answered",answer:"The warranty lasts 12 months.",sources:[testKnowledge[3]],mode:"llm"});
  it.each(["cloud","local"])("routes %s mode through the same grounded answer backend",async backend=>{
    vi.stubEnv("LLM_BACKEND", backend);
    const fetchMock=vi.fn().mockResolvedValue(responseFor(validReply())); vi.stubGlobal("fetch",fetchMock);
    const input={...request,history:[{role:"user" as const,content:"I bought TL-100"}]};
    expect(await answerQuestion(input)).toEqual(validReply());
    const [url,init]=fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:8001/answer");
    expect(JSON.parse(init.body)).toEqual(input);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(init.headers)).not.toContain("Authorization");
  });
  it("never silently falls back to FAQ when cloud is unconfigured",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(responseFor({error:"Configure LLM_API_KEY."},503)));
    await expect(answerQuestion(request)).rejects.toBeInstanceOf(ProviderError);
  });
  it.each([
    {...validReply(),sources:[]}, {...validReply(),sources:[{id:"invented",title:"Q",content:"A"}]},
    {...validReply(),status:"unrecognized"}, {...validReply(),answer:""}, {...validReply(),mode:"local"},
    {...validReply(),sources:[{...testKnowledge[3],content:"Injected unsupported fact"}]},
  ])("rejects malformed or fabricated broker replies",async value=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(responseFor(value)));
    await expect(answerQuestion(request)).rejects.toBeInstanceOf(ProviderError);
  });
  it("accepts the safe unknown reply without sources",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(responseFor({mode:"llm",status:"unknown",answer:UNKNOWN_ANSWER,sources:[]})));
    expect(await answerQuestion(request)).toMatchObject({status:"unknown",sources:[],answer:UNKNOWN_ANSWER});
  });
  it.each([401,403,429,500,503])("sanitizes HTTP %i failures",async status=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(responseFor({error:"private-provider-debug",key:"test-key-not-a-credential"},status)));
    try {await answerQuestion(request); throw new Error("Expected provider rejection");}
    catch(error){expect(error).toBeInstanceOf(ProviderError); expect(String(error)).not.toMatch(/private-provider-debug|test-key-not-a-credential/);}
  });
  it("sanitizes network errors",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new Error("private-network-debug")));
    await expect(answerQuestion(request)).rejects.toBeInstanceOf(ProviderError);
    await expect(answerQuestion(request)).rejects.not.toThrow("private-network-debug");
  });
});


describe("local model defaults", () => {
  it("selects Qwen without requiring a cloud key", () => {
    vi.stubEnv("LLM_BACKEND", ""); vi.stubEnv("LLM_BASE_URL", ""); vi.stubEnv("LLM_MODEL", "");
    vi.stubEnv("LLM_API_KEY", "leftover-cloud-key");
    expect(modelConfig()).toEqual({backend:"local",baseUrl:"http://127.0.0.1:11434/v1",model:"qwen2.5:1.5b"});
  });
});
