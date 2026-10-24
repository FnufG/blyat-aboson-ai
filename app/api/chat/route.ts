import { NextResponse } from "next/server";
import { answerQuestion, ProviderError } from "../../../lib/answer";
import { parseChatRequest, InputError } from "../../../lib/validation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

class PayloadTooLarge extends Error {}
async function readLimitedBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 1_000_000) throw new PayloadTooLarge();
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_000_000) { await reader.cancel(); throw new PayloadTooLarge(); }
      try { text += decoder.decode(value, { stream: true }); }
      catch { await reader.cancel(); throw new InputError("Expected UTF-8 text."); }
      if (text.length > 600_000) { await reader.cancel(); throw new PayloadTooLarge(); }
    }
    try { text += decoder.decode(); }
    catch { throw new InputError("Expected UTF-8 text."); }
    return text;
  } finally { reader.releaseLock(); }
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    const expectedHost = request.headers.get("host") || new URL(request.url).host;
    let allowedOrigin = true;
    if (origin) {
      try {
        const supplied = new URL(origin);
        allowedOrigin = supplied.host === expectedHost && ["http:", "https:"].includes(supplied.protocol);
      } catch { allowedOrigin = false; }
    }
    if (!allowedOrigin) {
      return NextResponse.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
    }
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return NextResponse.json({ error: "Expected JSON." }, { status: 415 });
    }
    const body = await readLimitedBody(request);
    if (body.length > 600_000) return NextResponse.json({ error: "The document is too large." }, { status: 413 });
    let data: unknown;
    try { data = JSON.parse(body); } catch { throw new InputError("Invalid JSON."); }
    const input = parseChatRequest(data);
    const answer = await answerQuestion(input);
    return NextResponse.json(answer, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PayloadTooLarge) return NextResponse.json({ error: "The document is too large." }, { status: 413 });
    if (error instanceof InputError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof ProviderError) return NextResponse.json({ error: error.message }, { status: 502 });
    return NextResponse.json({ error: "Could not process the question. Please try again." }, { status: 500 });
  }
}
