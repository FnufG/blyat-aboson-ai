import { validateKnowledge } from "./knowledge";
import type { ChatRequest } from "./types";

export class InputError extends Error {}
export function parseChatRequest(value: unknown): ChatRequest {
  if (!value || typeof value !== "object") throw new InputError("Invalid request.");
  const input = value as Record<string, unknown>;
  if (typeof input.question !== "string" || !input.question.trim() || input.question.length > 2000) {
    throw new InputError("Enter a question between 1 and 2000 characters.");
  }
  const knowledgeError = validateKnowledge(input.knowledge);
  if (knowledgeError) throw new InputError(knowledgeError);
  if (!Array.isArray(input.history) || input.history.length > 20) throw new InputError("History must contain no more than 20 messages.");
  for (const message of input.history) {
    if (!message || typeof message !== "object" || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" || !message.content.trim() || message.content.length > 6000) {
      throw new InputError("Invalid history message.");
    }
    if (message.sourceIds !== undefined && (!Array.isArray(message.sourceIds) || message.sourceIds.length > 3 || message.sourceIds.some((id: unknown) => typeof id !== "string" || id.length > 80))) {
      throw new InputError("Invalid source references.");
    }
  }
  return { question: input.question.trim(), knowledge: input.knowledge as ChatRequest["knowledge"], history: input.history.map(({ role, content, sourceIds }) => ({ role, content, ...(sourceIds ? { sourceIds } : {}) })) };
}
