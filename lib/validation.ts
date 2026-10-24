import { validateKnowledge } from "./knowledge";
import type { ChatRequest } from "./types";

export class InputError extends Error {}
export function parseChatRequest(value: unknown): ChatRequest {
  if (!value || typeof value !== "object") throw new InputError("Некорректный запрос.");
  const input = value as Record<string, unknown>;
  if (typeof input.question !== "string" || !input.question.trim() || input.question.length > 2000) {
    throw new InputError("Вопрос должен содержать от 1 до 2000 символов.");
  }
  const knowledgeError = validateKnowledge(input.knowledge);
  if (knowledgeError) throw new InputError(knowledgeError);
  if (!Array.isArray(input.history) || input.history.length > 20) throw new InputError("История должна содержать не более 20 сообщений.");
  for (const message of input.history) {
    if (!message || typeof message !== "object" || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" || !message.content.trim() || message.content.length > 6000) {
      throw new InputError("Некорректное сообщение в истории.");
    }
    if (message.sourceIds !== undefined && (!Array.isArray(message.sourceIds) || message.sourceIds.length > 3 || message.sourceIds.some((id: unknown) => typeof id !== "string" || id.length > 80))) {
      throw new InputError("Некорректные ссылки на источники.");
    }
  }
  return { question: input.question.trim(), knowledge: input.knowledge as ChatRequest["knowledge"], history: input.history.map(({ role, content, sourceIds }) => ({ role, content, ...(sourceIds ? { sourceIds } : {}) })) };
}
