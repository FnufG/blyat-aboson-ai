import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const base = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3000";
const sections = readFileSync(new URL("../public/demo-faq.md", import.meta.url), "utf8").split(/^## /m).filter((item) => item.trim());
const knowledge = sections.map((section, index) => {
  const [title, ...body] = section.trim().split("\n");
  return { id: `faq-${index + 1}`, title, content: body.join("\n").trim() };
});
const statusResponse = await fetch(`${base}/api/status`);
assert.equal(statusResponse.status, 200);
const { mode } = await statusResponse.json();
assert.ok(["local", "llm"].includes(mode));
async function ask(question, history = []) {
  const response = await fetch(`${base}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: new URL(base).origin },
    body: JSON.stringify({ question, history, knowledge })
  });
  assert.equal(response.status, 200, `Chat HTTP ${response.status}`);
  return response.json();
}
const known = await ask("На роутере мигает красный индикатор");
assert.equal(known.status, "answered");
assert.ok(known.sources.some((source) => source.id === "faq-7"));
assert.ok(known.answer.length > 0);
const unknown = await ask("Как настроить роутер TL-999?");
assert.equal(unknown.status, "unknown");
assert.equal(unknown.sources.length, 0);
console.log(`Smoke passed: ${mode} mode; known answer cites FAQ; unknown model abstains.`);
