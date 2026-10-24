import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { demoKnowledge, parseKnowledge, serializeKnowledge, validateKnowledge } from "../lib/knowledge";

describe("база знаний", () => {
  it("поставляет 18 валидных вымышленных FAQ и воспроизводимый демофайл", () => {
    expect(demoKnowledge).toHaveLength(18);
    expect(validateKnowledge(demoKnowledge)).toBeNull();
    const demoDocument = readFileSync(new URL("../public/demo-faq.md", import.meta.url), "utf8");
    expect(parseKnowledge(demoDocument)).toEqual(demoKnowledge);
    expect(demoDocument).toBe(serializeKnowledge(demoKnowledge));
    expect(demoDocument).toContain("вымышленная компания");
    expect(demoDocument).toContain("support@example.invalid");
  });

  it("читает BOM, CRLF и многострочные ответы без потери содержимого", () => {
    expect(parseKnowledge("\uFEFF## Вопрос?\r\n\r\nОтвет.\r\nСледующий шаг.\r\n")).toEqual([
      { id: "faq-1", title: "Вопрос?", content: "Ответ.\nСледующий шаг." },
    ]);
  });

  it("сохраняет вступление перед разделами как отдельный источник", () => {
    const entries = parseKnowledge("Важная общая информация.\n\n## Вопрос\nОтвет");
    expect(entries[0]).toMatchObject({ title: "Общие сведения", content: "Важная общая информация." });
    expect(entries[1]).toMatchObject({ title: "Вопрос", content: "Ответ" });
  });

  it("читает простой текст, разделённый пустыми строками", () => {
    expect(parseKnowledge("Часы работы\nЕжедневно 9–18.\n\nТелефон\nНомер указан в договоре.")).toEqual([
      { id: "faq-1", title: "Часы работы", content: "Ежедневно 9–18." },
      { id: "faq-2", title: "Телефон", content: "Номер указан в договоре." },
    ]);
    expect(parseKnowledge("Только одна строка сведений")[0].content).toBe("Только одна строка сведений");
  });

  it("сохраняет подзаголовки ответа и не принимает пустые записи", () => {
    expect(parseKnowledge("## Вопрос\nОтвет\n### Шаг\nДействие")[0].content).toContain("### Шаг");
    expect(() => parseKnowledge("## Без ответа")).toThrow("непустой ответ");
    expect(() => parseKnowledge("##\nОтвет")).toThrow("заголовок");
    expect(() => parseKnowledge(" \n ")).toThrow("пуст");
  });

  it("отклоняет превышение лимитов вместо обрезания данных", () => {
    expect(() => parseKnowledge("x".repeat(180_001))).toThrow("180 000");
    expect(() => parseKnowledge(`## Вопрос\n${"x".repeat(4_001)}`)).toThrow("4000");
    expect(() => parseKnowledge(`## ${"x".repeat(201)}\nОтвет`)).toThrow("200");
    const entries = Array.from({ length: 101 }, (_, i) => ({ id: `entry-${i}`, title: "Вопрос", content: "Ответ" }));
    expect(validateKnowledge(entries)).toContain("100");
  });

  it("проверяет типы, пустые строки и уникальность идентификаторов", () => {
    for (const invalid of [null, {}, [], [null], [{ id: "x", title: " ", content: "A" }], [{ id: "bad id", title: "Q", content: "A" }], [{ id: "x", title: "Q", content: 3 }]]) {
      expect(validateKnowledge(invalid)).not.toBeNull();
    }
    expect(validateKnowledge([demoKnowledge[0], demoKnowledge[0]])).toContain("повторяться");
    expect(() => parseKnowledge("\u0000binary")).toThrow("двоичных");
  });

  it("экспортирует и импортирует пользовательские записи без изменения текста", () => {
    const entries = [{ id: "custom", title: "Как помочь?", content: "Первый шаг.\n\nВторой шаг." }];
    expect(parseKnowledge(serializeKnowledge(entries))[0]).toEqual({ ...entries[0], id: "faq-1" });
    expect(() => serializeKnowledge([])).toThrow();
  });
});
