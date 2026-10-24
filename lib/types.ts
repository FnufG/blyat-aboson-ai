export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sourceIds?: string[];
}

export interface ChatRequest {
  question: string;
  history: ChatMessage[];
  knowledge: KnowledgeEntry[];
}

export interface ChatReply {
  answer: string;
  sources: KnowledgeEntry[];
  status: "answered" | "unknown" | "clarification";
  mode: "local" | "llm";
}
