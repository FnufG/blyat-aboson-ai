import assert from 'node:assert/strict';
const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
if (process.env.SMOKE_ALLOW_CLOUD !== '1') {
  console.log(JSON.stringify({check:'text_smoke', outcome:'blocked', reason:'Set SMOKE_ALLOW_CLOUD=1 to authorize short requests to the configured model. Cloud API charges may apply.'}));
  process.exit(2);
}
// Private validation data; never seeded into the application or browser storage.
const knowledge = [
  {id:'support-hours', title:'When is support available?', content:'Support is available Monday to Friday, 09:00 to 17:00 UTC.'},
  {id:'support-contact', title:'How do I contact support?', content:'Email support@example.invalid. The usual response time is two working days.'}
];
const status = await fetch(`${base}/api/status`);
assert.equal(status.status, 200);
async function ask(question) {
  const response = await fetch(`${base}/api/chat`, {method:'POST', headers:{'Content-Type':'application/json',Origin:new URL(base).origin}, body:JSON.stringify({question, history:[], knowledge}), signal:AbortSignal.timeout(90_000)});
  assert.equal(response.status,200,`Chat HTTP ${response.status}`);
  return response.json();
}
const known = await ask('When is support available?');
assert.equal(known.status,'answered');
assert.equal(known.mode,'llm');
assert.ok(known.sources.some(source=>source.id==='support-hours'));
assert.match(known.answer,/09:00|9\s*(?:am|a\.m\.)/i);
const unknown = await ask('What is the warranty period for the Zeta ZX999 device?');
assert.equal(unknown.status,'unknown');
assert.equal(unknown.sources.length,0);
console.log(JSON.stringify({check:'english_text_smoke', passed:true, known_answer_cited:true, unknown_question_abstained:true}));
