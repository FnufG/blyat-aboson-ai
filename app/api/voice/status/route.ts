import { NextResponse } from "next/server";
import { voiceStatus } from "../../../../lib/voice-server";
export const dynamic = "force-dynamic";
export async function GET() {
  return NextResponse.json(await voiceStatus(), { headers: { "Cache-Control": "no-store" } });
}
