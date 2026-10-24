import { describe, expect, it } from "vitest";
import { parseKnowledge, removeLegacyDemoKnowledge, serializeKnowledge, validateKnowledge } from "../lib/knowledge";
import { testKnowledge } from "./fixtures";

describe("knowledge import and export", () => {
  it("accepts explicit test materials without shipping a demo database", () => {
    expect(validateKnowledge(testKnowledge)).toBeNull();
    expect(parseKnowledge(serializeKnowledge(testKnowledge))).toEqual(testKnowledge);
  });
  it("reads BOM, CRLF and multiline answers without losing text", () => {
    expect(parseKnowledge("\uFEFF## Question?\r\n\r\nAnswer.\r\nNext step.\r\n")).toEqual([
      { id: "faq-1", title: "Question?", content: "Answer.\nNext step." },
    ]);
  });
  it("preserves introductory information as a separate source", () => {
    const entries = parseKnowledge("Important general information.\n\n## Question\nAnswer");
    expect(entries[0]).toMatchObject({ title: "General information", content: "Important general information." });
    expect(entries[1]).toMatchObject({ title: "Question", content: "Answer" });
  });
  it("reads plain text blocks separated by blank lines", () => {
    expect(parseKnowledge("Opening hours\nDaily 9–18.\n\nPhone\nThe number is on your contract.")).toEqual([
      { id: "faq-1", title: "Opening hours", content: "Daily 9–18." },
      { id: "faq-2", title: "Phone", content: "The number is on your contract." },
    ]);
    expect(parseKnowledge("A single line of information")[0].content).toBe("A single line of information");
  });
  it("preserves answer subheadings and rejects empty entries", () => {
    expect(parseKnowledge("## Question\nAnswer\n### Step\nAction")[0].content).toContain("### Step");
    expect(() => parseKnowledge("## No answer")).toThrow(/answer/i);
    expect(() => parseKnowledge("##\nAnswer")).toThrow(/title/i);
    expect(() => parseKnowledge(" \n ")).toThrow(/empty/i);
  });
  it("rejects size limits rather than silently truncating", () => {
    expect(() => parseKnowledge("x".repeat(180_001))).toThrow("180,000");
    expect(() => parseKnowledge(`## Question\n${"x".repeat(4_001)}`)).toThrow(/4,?000/);
    expect(() => parseKnowledge(`## ${"x".repeat(201)}\nAnswer`)).toThrow("200");
    const entries = Array.from({ length: 101 }, (_, i) => ({ id: `entry-${i}`, title: "Question", content: "Answer" }));
    expect(validateKnowledge(entries)).toContain("100");
  });
  it("validates types, empty strings and unique source IDs", () => {
    for (const invalid of [null, {}, [], [null], [{ id: "x", title: " ", content: "A" }], [{ id: "bad id", title: "Q", content: "A" }], [{ id: "x", title: "Q", content: 3 }]]) {
      expect(validateKnowledge(invalid)).not.toBeNull();
    }
    expect(validateKnowledge([testKnowledge[0], testKnowledge[0]])).toMatch(/unique|repeat|duplicate/i);
    expect(() => parseKnowledge("\u0000binary")).toThrow(/binary/i);
  });
  it("round-trips custom answers without changing their content", () => {
    const entries = [{ id: "custom", title: "How can we help?", content: "First step.\n\nSecond step." }];
    expect(parseKnowledge(serializeKnowledge(entries))[0]).toEqual({ ...entries[0], id: "faq-1" });
    expect(() => serializeKnowledge([])).toThrow();
  });
});

const legacyEntry = {"id": "faq-1", "title": "Что такое ТехноЛиния и для каких устройств эта база?", "content": "ТехноЛиния — вымышленная компания для демонстрации ИИ-консультанта. Все цены, сроки, контакты и характеристики здесь вымышлены. Эта база описывает только учебный роутер TL-100. Сведения нельзя применять к реальному оборудованию без проверки его инструкции."};

describe("legacy workspace migration", () => {
  it("removes seeded legacy data while preserving uploaded and edited entries with the same IDs", async () => {
    const edited = {...legacyEntry, content: "Our real company instructions."};
    const uploaded = {id: "faq-2", title: "Our office", content: "The office opens at 08:30."};
    expect(await removeLegacyDemoKnowledge([legacyEntry])).toEqual([]);
    expect(await removeLegacyDemoKnowledge([edited, uploaded])).toEqual([edited, uploaded]);
  });
});
