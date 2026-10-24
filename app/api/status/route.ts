import { NextResponse } from "next/server";
import { modelConfig } from "../../../lib/answer";
import { voiceApiUrl } from "../../../lib/voice-server";
export const dynamic = "force-dynamic";
export async function GET() {
  const config = modelConfig();
  if (process.env.LLM_BACKEND === "local") {
    let ready = false;
    try {
      const response = await fetch(`${voiceApiUrl()}/health`, { cache: "no-store", signal: AbortSignal.timeout(3_000) });
      const health = await response.json(); ready = Boolean(health.components?.llm?.ready);
    } catch { /* Surface configuration separately from live readiness. */ }
    return NextResponse.json({ mode: "llm", engine: "local", ready }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ mode: config.apiKey ? "llm" : "local", ...(config.apiKey ? { model: config.model } : {}) }, { headers: { "Cache-Control": "no-store" } });
}
