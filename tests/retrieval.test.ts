import { describe, expect, it } from "vitest";
import { demoKnowledge } from "../lib/knowledge";
import { contextualMatches, retrieve, terms } from "../lib/retrieval";
import type { ChatMessage } from "../lib/types";

describe("FAQ retrieval", () => {
  it.each(demoKnowledge)("retrieves its own source: $id", (entry) => {
    expect(retrieve(entry.title, demoKnowledge)[0]?.entry.id).toBe(entry.id);
  });

  it.each([
    ["На роутере мигает красный индикатор", "faq-7"],
    ["Какие условия гарантии?", "faq-4"],
    ["Как связаться с поддержкой?", "faq-3"],
    ["Я забыл пароль вай-фай", "faq-9"],
    ["Как перезапустить роутер?", "faq-12"],
    ["Как увеличить сигнал вай-фай?", "faq-11"],
  ])("matches a customer paraphrase: %s", (question, id) => {
    expect(retrieve(question, demoKnowledge)[0]?.entry.id).toBe(id);
  });

  it.each([
    "Какая погода завтра?",
    "Сколько стоит ремонт ноутбука?",
    "Расскажи анекдот",
    "Как перезагрузить TL-999?",
    "На TL-1000 мигает красный индикатор",
    "Какая гарантия на автомобиль?",
    "Сколько стоит роутер TL-100?",
  ])("does not borrow unsupported facts: %s", (question) => {
    expect(retrieve(question, demoKnowledge)).toEqual([]);
  });

  it("normalizes Russian inflection, Wi-Fi spelling and equivalent restart words", () => {
    expect(terms("гарантии")).toEqual(terms("гарантия"));
    expect(terms("вай-фай")).toEqual(terms("Wi-Fi"));
    expect(terms("перезапустить")).toEqual(terms("перезагрузить"));
  });

  it("has no result with an empty knowledge base", () => {
    expect(retrieve("Какие условия гарантии?", [])).toEqual([]);
  });
});

describe("conversation context", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "На роутере мигает красный индикатор" },
    { role: "assistant", content: demoKnowledge[6].content, sourceIds: ["faq-7"] },
  ];

  it("resolves a follow-up to the previous cited source", () => {
    const result = contextualMatches("А если это не помогло?", history, demoKnowledge);
    expect(result.followUp).toBe(true);
    expect(result.matches.map(({ entry }) => entry.id)).toEqual(["faq-7"]);
  });

  it("uses the newest cited topic", () => {
    const result = contextualMatches("Расскажите подробнее", [
      ...history,
      { role: "assistant", content: demoKnowledge[3].content, sourceIds: ["faq-4"] },
    ], demoKnowledge);
    expect(result.matches[0]?.entry.id).toBe("faq-4");
  });

  it("retrieves an independent topic instead of reusing the prior source", () => {
    const result = contextualMatches("Какие условия гарантии?", history, demoKnowledge);
    expect(result.followUp).toBe(false);
    expect(result.matches[0]?.entry.id).toBe("faq-4");
  });

  it("does not restore a source removed from the knowledge base", () => {
    const result = contextualMatches("А если это не помогло?", history, demoKnowledge.filter(({ id }) => id !== "faq-7"));
    expect(result.matches).toEqual([]);
  });

  it("does not borrow an unrelated source when a new topic contains a follow-up phrase", () => {
    const result = contextualMatches("Расскажите подробнее об условиях гарантии", history, demoKnowledge);
    expect(result.matches[0]?.entry.id).toBe("faq-4");
  });

  it("does not keep an old topic for an unsupported new follow-up topic", () => {
    const result = contextualMatches("Расскажите подробнее об акциях", history, demoKnowledge);
    expect(result.matches).toEqual([]);
  });

  it("still rejects an unknown explicit device model in a follow-up", () => {
    const result = contextualMatches("А если это не помогло на TL-999?", history, demoKnowledge);
    expect(result.matches).toEqual([]);
  });
});
