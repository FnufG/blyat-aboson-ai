import type { ChatReply, ChatRequest, KnowledgeEntry } from "./types";
import { contextualMatches, UNKNOWN_ANSWER } from "./retrieval";

export function modelConfig() {
  return {
    backend: process.env.LLM_BACKEND || "cloud",
    baseUrl: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
    model: process.env.LLM_MODEL || "gpt-4.1-mini"
  };
}
export class ProviderError extends Error {}
const SAFE_ERRORS: Record<string, string> = {
  missing_llm_key: "Set LLM_API_KEY in .env.local and restart the application.",
  invalid_llm_config: "Check LLM_BASE_URL and LLM_MODEL in the server configuration. A cloud API requires HTTPS.",
  provider_auth: "The cloud model rejected access. Check LLM_API_KEY and model permissions.",
  provider_quota: "The cloud API limit was reached. Check your API billing and quota.",
  provider_timeout: "The language model timed out. Please try again.",
  provider_unavailable: "The language model is temporarily unavailable. Please try again.",
  invalid_model_reply: "The model did not return a valid answer with sources. Please rephrase your question.",
  knowledge_too_large: "The matching material is too large. Split the instructions into shorter sections."
};
function verifiedSources(value: unknown, knowledge: KnowledgeEntry[]): value is KnowledgeEntry[] {
  return Array.isArray(value) && value.length <= 3 && new Set(value.map(source => source?.id)).size === value.length && value.every(source =>
    source && knowledge.some(entry => entry.id === source.id && entry.title === source.title && entry.content === source.content));
}
export async function answerQuestion(request: ChatRequest): Promise<ChatReply> {
  if (modelConfig().backend !== "faq") {
    let response: Response;
    try {
      response = await fetch(`${process.env.VOICE_API_URL || "http://127.0.0.1:8001"}/answer`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(90_000)
      });
    } catch { throw new ProviderError("The answer service is unavailable. Check the application logs and cloud API configuration."); }
    if (!response.ok) {
      let code = "";
      try { code = (await response.json()).code; } catch { /* Never expose raw provider responses. */ }
      throw new ProviderError(SAFE_ERRORS[code] || "The answer service could not respond. Check the cloud API configuration and try again.");
    }
    try {
      const result = await response.json();
      if (typeof result.answer !== "string" || !result.answer.trim() || result.answer.length > 6000 || !["answered", "unknown", "clarification"].includes(result.status) || result.mode !== "llm" || !verifiedSources(result.sources, request.knowledge) || (result.status === "answered" && !result.sources.length) || (result.status === "unknown" && result.sources.length)) throw new Error();
      return result.status === "unknown" ? { ...result, answer: UNKNOWN_ANSWER } : result as ChatReply;
    } catch { throw new ProviderError(SAFE_ERRORS.invalid_model_reply); }
  }
  // Explicit extractive mode is only for offline UI checks; cloud failures never fall back to it.
  const { matches, followUp } = contextualMatches(request.question, request.history, request.knowledge);
  const sources = matches.map(match => match.entry);
  if (!sources.length) {
    const greeting = /^(hello|hi|hey|good morning|good afternoon|thank you|thanks)[!.\s]*$/i.test(request.question);
    return { answer: greeting ? "Hello! Ask a question about the company or describe your issue. I answer using the uploaded knowledge base." : UNKNOWN_ANSWER, sources: [], status: greeting ? "clarification" : "unknown", mode: "local" };
  }
  if (followUp) return { answer: "Please tell me which step you tried and what happened. FAQ search can show the supplied instructions, but cannot suggest unverified actions.\n\n" + sources[0].content, sources: [sources[0]], status: "clarification", mode: "local" };
  return { answer: sources[0].content, sources: [sources[0]], status: "answered", mode: "local" };
}
