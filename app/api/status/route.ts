import { NextResponse } from "next/server";
import { modelConfig } from "../../../lib/answer";
import { voiceApiUrl } from "../../../lib/voice-server";
export const dynamic = "force-dynamic";
export async function GET() {
  const config = modelConfig();
  if (config.backend === "faq") return NextResponse.json({ mode: "local", engine: "faq", ready: true }, { headers: { "Cache-Control": "no-store" } });
  let ready = false;
  let reason = "The answer service is starting or unavailable.";
  try {
    const response = await fetch(`${voiceApiUrl()}/health`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    if (response.ok) {
      const health = await response.json();
      ready = health.components?.llm?.ready === true;
      reason = ready ? "" : config.backend === "local" ? "The local model is starting or unavailable. Wait for Qwen to load and check the service logs." : "Check LLM_API_KEY, cloud API access and model availability in the server configuration.";
    }
  } catch { /* Configuration is separate from live readiness. */ }
  return NextResponse.json({ mode: "llm", engine: config.backend === "local" ? "local" : "cloud", model: config.model, ready, ...(reason ? { reason } : {}) }, { headers: { "Cache-Control": "no-store" } });
}
