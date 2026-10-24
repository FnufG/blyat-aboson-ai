import type { ChatMessage, KnowledgeEntry } from "./types";

export const UNKNOWN_ANSWER = "В базе знаний нет подтверждённого ответа на этот вопрос. Уточните вопрос или обратитесь к сотруднику компании.";
const STOP = new Set("а и но или в во на по к ко с со у из за от до об о про для при это этот эта эти то так как какой какая какие какое ли бы был была было быть есть будет можно мне меня мой мы вы ваш вас вам нам наш он она они оно его ее их уже ещё еще очень пожалуйста подскажите скажите расскажите знать узнать хочу помогите вопрос если что чем почему когда сколько где не нет да только такой такой же работает делать нужно надо после раз сейчас никак всё все ничего здравствуйте привет добрый день спасибо далее дальше подробнее".split(" "));

export function terms(text: string): string[] {
  const normalized = text.toLowerCase().replace(/ё/g, "е").replace(/wi[\s-]?fi|вай[\s-]?фай/g, "wifi").replace(/\b[a-z]{1,8}[- ]?\d{2,5}\b/g, " ");
  return [...new Set((normalized.match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length > 1 && !STOP.has(word))
    .map((word) => {
      if (/^(гарант)/.test(word)) return "гарант";
      if (/^(перезаг|перезап|перезапус)/.test(word)) return "перезапуск";
      if (/^(связ|контакт|почт|email|телефон)/.test(word)) return "контакт";
      if (/^(лампоч|индикатор)/.test(word)) return "индикатор";
      if (/^(смен|измен|поменя)/.test(word)) return "измен";
      if (/^(сброс|заводск)/.test(word)) return "сброс";
      return word.replace(/(иями|ями|ами|ого|ему|ому|ыми|ими|ией|иям|ах|ях|ый|ий|ой|ая|яя|ое|ее|ые|ие|ов|ев|ом|ем|ам|ям|ую|юю|ы|и|а|я|у|ю|е)$/u, "");
    }).filter((word) => word.length > 1))];
}

export interface Match { entry: KnowledgeEntry; score: number }
export function retrieve(question: string, knowledge: KnowledgeEntry[]): Match[] {
  const query = terms(question);
  if (!query.length) return [];
  if (hasUnknownModel(question, knowledge)) return [];
  const docs = knowledge.map((entry) => ({ entry, title: new Set(terms(entry.title)), body: new Set(terms(entry.content)) }));
  return docs.map(({ entry, title, body }) => {
    const matching = query.filter((term) => title.has(term) || body.has(term));
    const coverage = matching.length / query.length;
    const weighted = matching.reduce((sum, term) => {
      const frequency = docs.filter((doc) => doc.title.has(term) || doc.body.has(term)).length;
      const idf = 1 + Math.log((docs.length + 1) / (frequency + 1));
      return sum + idf * (title.has(term) ? 3 : 1);
    }, 0);
    const titleHits = query.filter((term) => title.has(term)).length;
    return { entry, score: coverage >= 0.6 && (titleHits > 0 || matching.length >= 2) ? weighted * coverage : 0 };
  }).filter((match) => match.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
}

function hasUnknownModel(question: string, knowledge: KnowledgeEntry[]): boolean {
  const models = question.toLowerCase().match(/\b[a-z]{1,8}[- ]?\d{2,5}\b/g) ?? [];
  const corpus = knowledge.map((entry) => `${entry.title} ${entry.content}`.toLowerCase().replace(/[- ]/g, "")).join(" ");
  return models.some((model) => !corpus.includes(model.replace(/[- ]/g, "")));
}

export function contextualMatches(question: string, history: ChatMessage[], knowledge: KnowledgeEntry[]): { matches: Match[]; followUp: boolean } {
  if (hasUnknownModel(question, knowledge)) return { matches: [], followUp: false };
  const direct = retrieve(question, knowledge);
  const followUp = /(?:не помог|не получилось|не сработал|дальше|подробнее|следующ.{0,8}шаг|а если это|что затем)/i.test(question);
  if (followUp) {
    const previous = [...history].reverse().find((message) => message.role === "assistant" && message.sourceIds?.length);
    const sources = knowledge.filter((entry) => previous?.sourceIds?.includes(entry.id));
    // A named new topic takes priority over a generic request for more detail.
    if (direct.length && !sources.some((source) => source.id === direct[0].entry.id)) return { matches: direct, followUp: false };
    const topicTerms = terms(question).filter((term) => !/^(помог|получ|сработ|следующ|шаг|затем|сдела)/.test(term));
    const previousTerms = new Set(sources.flatMap((source) => terms(source.title + " " + source.content)));
    if (topicTerms.length && !topicTerms.some((term) => previousTerms.has(term))) return { matches: direct, followUp: false };
    if (sources.length) return { matches: sources.map((entry) => ({ entry, score: 1 })), followUp: true };
  }
  return { matches: direct, followUp: false };
}
