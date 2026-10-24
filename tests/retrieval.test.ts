import { describe, expect, it } from "vitest";
import { contextualMatches, retrieve, terms } from "../lib/retrieval";
import type { ChatMessage } from "../lib/types";
import { testKnowledge } from "./fixtures";

describe("English knowledge retrieval", () => {
  it.each(testKnowledge)("retrieves its own source: $id", (entry) => {
    expect(retrieve(entry.title, testKnowledge)[0]?.entry.id).toBe(entry.id);
  });
  it.each([
    ["The router indicator is blinking red", "faq-7"],
    ["What are the warranty terms?", "faq-4"],
    ["How can I contact support?", "faq-3"],
    ["I forgot my Wi-Fi password", "faq-9"],
    ["How do I restart the router?", "faq-12"],
    ["How do I improve weak Wi-Fi signal?", "faq-11"],
  ])("matches a customer paraphrase: %s", (question, id) => {
    expect(retrieve(question, testKnowledge)[0]?.entry.id).toBe(id);
  });
  it.each([
    "What is tomorrow's weather?", "How much does laptop repair cost?", "Tell me a joke",
    "How do I restart TL-999?", "The TL-1000 indicator is blinking red",
    "What is the car warranty?", "How much does the TL-100 router cost?",
  ])("does not borrow unsupported facts: %s", question => {
    expect(retrieve(question, testKnowledge)).toEqual([]);
  });
  it("normalizes equivalent English Wi-Fi spellings", () => {
    expect(terms("Wi-Fi")).toEqual(terms("wifi"));
  });
  it("has no result with an empty knowledge base", () => {
    expect(retrieve("What are the warranty terms?", [])).toEqual([]);
  });
});

describe("conversation context", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "The router indicator is blinking red" },
    { role: "assistant", content: testKnowledge[6].content, sourceIds: ["faq-7"] },
  ];
  it("resolves a follow-up to the previous cited source", () => {
    const result = contextualMatches("What if that did not help?", history, testKnowledge);
    expect(result.followUp).toBe(true);
    expect(result.matches.map(({ entry }) => entry.id)).toEqual(["faq-7"]);
  });
  it("uses the newest cited topic", () => {
    const result = contextualMatches("Tell me more", [...history,
      { role: "assistant", content: testKnowledge[3].content, sourceIds: ["faq-4"] },
    ], testKnowledge);
    expect(result.matches[0]?.entry.id).toBe("faq-4");
  });
  it("retrieves an independent topic instead of reusing the previous source", () => {
    const result = contextualMatches("What are the warranty terms?", history, testKnowledge);
    expect(result.followUp).toBe(false);
    expect(result.matches[0]?.entry.id).toBe("faq-4");
  });
  it("does not restore a source removed from the knowledge base", () => {
    expect(contextualMatches("What if that did not help?", history,
      testKnowledge.filter(({ id }) => id !== "faq-7")).matches).toEqual([]);
  });
  it("switches topic even when the new question starts with a follow-up phrase", () => {
    expect(contextualMatches("Tell me more about warranty terms", history, testKnowledge).matches[0]?.entry.id).toBe("faq-4");
  });
  it("does not keep an old topic for an unsupported new follow-up topic", () => {
    expect(contextualMatches("Tell me more about promotions", history, testKnowledge).matches).toEqual([]);
  });
  it("still rejects unknown explicit device models in follow-ups", () => {
    expect(contextualMatches("What if that did not help on TL-999?", history, testKnowledge).matches).toEqual([]);
  });
});
