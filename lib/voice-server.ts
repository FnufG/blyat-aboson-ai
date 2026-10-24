import { AccessToken, AgentDispatchClient, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import type { KnowledgeEntry } from "./types";

export const voiceApiUrl = () => process.env.VOICE_API_URL || "http://127.0.0.1:8001";
const livekitUrl = () => process.env.LIVEKIT_URL || "ws://127.0.0.1:7880";
function credentials() {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error("The conversation service is not configured. Run npm run voice:up.");
  return { apiKey, apiSecret };
}

export async function voiceStatus() {
  try {
    const response = await fetch(`${voiceApiUrl()}/health`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error();
    const health = await response.json();
    const components = health.components || {};
    const required = ["llm", "stt", "vad", "tts", "livekit", "worker"];
    const missing = required.filter((name) => components[name]?.ready !== true)
      .map((name) => `${name}: ${String(components[name]?.reason || components[name]?.detail || "not ready")}`);
    const configured = Boolean(process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
    if (!configured) missing.push("LiveKit connection is not configured");
    return { ready: health.ready === true && configured && missing.length === 0, missing, ttsProvider: health.ttsMode === "boson" ? "boson" : "test", details: health.ready ? "Ready for an English conversation. Speech recognition is local; answers use the configured language model." : "Voice services are not ready yet. Check the list below.", components };
  } catch {
    return { ready: false, missing: ["Voice services are not running. Run npm run voice:up."], ttsProvider: process.env.BOSON_API_KEY ? "boson" : "test", details: "The knowledge editor remains available." };
  }
}

export async function createVoiceSession(knowledge: KnowledgeEntry[], requestUrl: string, requestHost?: string | null) {
  const { apiKey, apiSecret } = credentials();
  const status = await voiceStatus();
  if (!status.ready) throw new Error("Voice services are not ready: " + status.missing.join("; "));
  const response = await fetch(`${voiceApiUrl()}/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ knowledge: knowledge.map(({ id, title, content }) => ({ id, title, content })), language: "en" }), signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error("Could not prepare knowledge for the conversation.");
  const session = await response.json();
  if (!/^liniya-[A-Za-z0-9_-]{16,80}$/.test(session.roomName)) throw new Error("The service returned an invalid room.");
  const server = new URL(livekitUrl());
  server.protocol = server.protocol === "wss:" ? "https:" : "http:";
  const rooms = new RoomServiceClient(server.origin, apiKey, apiSecret);
  const dispatch = new AgentDispatchClient(server.origin, apiKey, apiSecret);
  try {
    await rooms.createRoom({ name: session.roomName, emptyTimeout: 120, departureTimeout: 10, maxParticipants: 2 });
    await dispatch.createDispatch(session.roomName, "liniya-support");
    const token = new AccessToken(apiKey, apiSecret, { identity: `visitor-${crypto.randomUUID()}`, ttl: "10m" });
    token.addGrant({ room: session.roomName, roomJoin: true, canSubscribe: true, canPublish: true, canPublishSources: [TrackSource.MICROPHONE], canPublishData: false });
    const publicUrl = new URL(requestUrl);
    publicUrl.host = requestHost || publicUrl.host;
    publicUrl.protocol = publicUrl.protocol === "https:" ? "wss:" : "ws:";
    publicUrl.port = "7880";
    publicUrl.pathname = "/"; publicUrl.search = "";
    return { participantToken: await token.toJwt(), serverUrl: process.env.LIVEKIT_PUBLIC_URL || publicUrl.origin, roomName: session.roomName, ttsProvider: session.ttsMode === "boson" ? "boson" : "test" };
  } catch {
    await Promise.allSettled([
      rooms.deleteRoom(session.roomName),
      fetch(`${voiceApiUrl()}/sessions/${session.roomName}`, { method: "DELETE", signal: AbortSignal.timeout(3_000) })
    ]);
    throw new Error("Could not connect the agent. Check LiveKit and the voice service logs.");
  }
}
