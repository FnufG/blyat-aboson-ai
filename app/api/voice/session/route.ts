import { NextResponse } from "next/server";
import { validateKnowledge } from "../../../../lib/knowledge";
import { createVoiceSession } from "../../../../lib/voice-server";
import type { KnowledgeEntry } from "../../../../lib/types";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host") || new URL(request.url).host;
  try {
    if (origin && new URL(origin).host !== host) return NextResponse.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
  } catch { return NextResponse.json({ error: "Invalid request origin." }, { status: 403 }); }
  if (!request.headers.get("content-type")?.includes("application/json")) return NextResponse.json({ error: "Expected JSON." }, { status: 415 });
  const reader = request.body?.getReader();
  if (!reader) return NextResponse.json({ error: "Empty request." }, { status: 400 });
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let body = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 750_000) { await reader.cancel(); return NextResponse.json({ error: "The document is too large." }, { status: 413 }); }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch { return NextResponse.json({ error: "Invalid request text." }, { status: 400 }); }
  finally { reader.releaseLock(); }
  let input: { knowledge?: unknown };
  try { input = JSON.parse(body); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  const error = validateKnowledge(input?.knowledge);
  if (error) return NextResponse.json({ error }, { status: 400 });
  try {
    return NextResponse.json(await createVoiceSession(input.knowledge as KnowledgeEntry[], request.url, request.headers.get("host")), { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : "Could not start the conversation." }, { status: 503 });
  }
}
