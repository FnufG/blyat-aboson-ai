import type { ChatMessage, KnowledgeEntry } from "./types";

export const UNKNOWN_ANSWER = "The knowledge base does not contain a verified answer to this question. Please clarify your question or contact a member of the company.";
const STOP = new Set("a an the and but or in on at to of for from with by as is are was were be been being do does did can could would should will may might i me my we our you your he she it its they their this that these those there here have has had how what which who when where why please tell say about know want need help question if then now already very just also more detail details next step steps not no yes hello hi good morning afternoon thanks thank thankyou nothing work worked working happen happened".split(" "));
function stem(word: string): string {
  if (/^(warrant|guarantee)/.test(word)) return "warranty";
  if (/^(reboot|restart)/.test(word)) return "restart";
  if (/^(contact|email|phone|telephone)/.test(word)) return "contact";
  if (/^(light|indicator)/.test(word)) return "indicator";
  if (/^(chang|modify)/.test(word)) return "change";
  if (/^(reset|factory)/.test(word)) return "reset";
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}
export function terms(text: string): string[] {
  const normalized = text.toLowerCase().replace(/wi[\s-]?fi/g, "wifi").replace(/\b[a-z]{1,8}[- ]?\d{2,5}\b/g, " ").replace(/['’](?:s|t|re|ve|ll|d)\b/g, "");
  return [...new Set((normalized.match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length > 1 && !STOP.has(word)).map(stem).filter(word => word.length > 1))];
}
export interface Match { entry: KnowledgeEntry; score: number }
export function retrieve(question: string, knowledge: KnowledgeEntry[]): Match[] {
  const query = terms(question);
  if (!query.length || hasUnknownModel(question, knowledge)) return [];
  const docs = knowledge.map(entry => ({ entry, title: new Set(terms(entry.title)), body: new Set(terms(entry.content)) }));
  return docs.map(({entry, title, body}) => {
    const matching = query.filter(term => title.has(term) || body.has(term));
    const coverage = matching.length / query.length;
    const weighted = matching.reduce((sum, term) => {
      const frequency = docs.filter(doc => doc.title.has(term) || doc.body.has(term)).length;
      return sum + (1 + Math.log((docs.length + 1) / (frequency + 1))) * (title.has(term) ? 3 : 1);
    }, 0);
    const titleHits = query.filter(term => title.has(term)).length;
    return { entry, score: coverage >= 0.6 && (titleHits > 0 || matching.length >= 2) ? weighted * coverage : 0 };
  }).filter(match => match.score > 0).sort((a,b) => b.score - a.score).slice(0,3);
}
function hasUnknownModel(question: string, knowledge: KnowledgeEntry[]): boolean {
  const models = question.toLowerCase().match(/\b[a-z]{1,8}[- ]?\d{2,5}\b/g) ?? [];
  const corpus = knowledge.map(entry => `${entry.title} ${entry.content}`.toLowerCase().replace(/[- ]/g, "")).join(" ");
  return models.some(model => !corpus.includes(model.replace(/[- ]/g, "")));
}
export function contextualMatches(question: string, history: ChatMessage[], knowledge: KnowledgeEntry[]): { matches: Match[]; followUp: boolean } {
  if (hasUnknownModel(question, knowledge)) return { matches: [], followUp: false };
  const direct = retrieve(question, knowledge);
  const followUp = /(?:did(?:n['’]t| not) help|did(?:n['’]t| not) work|what next|tell me more|more details|next step|what if that)/i.test(question);
  if (followUp) {
    const previous = [...history].reverse().find(message => message.role === "assistant" && message.sourceIds?.length);
    const sources = knowledge.filter(entry => previous?.sourceIds?.includes(entry.id));
    if (direct.length && !sources.some(source => source.id === direct[0].entry.id)) return { matches: direct, followUp: false };
    const topicTerms = terms(question);
    const previousTerms = new Set(sources.flatMap(source => terms(source.title + " " + source.content)));
    if (topicTerms.length && !topicTerms.some(term => previousTerms.has(term))) return { matches: direct, followUp: false };
    if (sources.length) return { matches: sources.map(entry => ({entry,score:1})), followUp: true };
  }
  return {matches:direct,followUp:false};
}
