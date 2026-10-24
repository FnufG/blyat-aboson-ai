import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testKnowledge as demoKnowledge } from "./fixtures";
import { createVoiceSession, voiceStatus } from "../lib/voice-server";
import { POST } from "../app/api/voice/session/route";
import { GET } from "../app/api/voice/status/route";
import { TrackSource } from "livekit-server-sdk";

const sdk = vi.hoisted(() => ({
  tokenConstructor: vi.fn(), roomConstructor: vi.fn(), dispatchConstructor: vi.fn(),
  addGrant: vi.fn(), toJwt: vi.fn(), createRoom: vi.fn(), deleteRoom: vi.fn(), createDispatch: vi.fn(),
}));
vi.mock("livekit-server-sdk", () => ({
  AccessToken: class {
    constructor(...args: unknown[]) { sdk.tokenConstructor(...args); }
    addGrant = sdk.addGrant;
    toJwt = sdk.toJwt;
  },
  RoomServiceClient: class {
    constructor(...args: unknown[]) { sdk.roomConstructor(...args); }
    createRoom = sdk.createRoom;
    deleteRoom = sdk.deleteRoom;
  },
  AgentDispatchClient: class {
    constructor(...args: unknown[]) { sdk.dispatchConstructor(...args); }
    createDispatch = sdk.createDispatch;
  },
  TrackSource: { MICROPHONE: 2 },
}));

const roomName = "liniya-12345678-abcd-4321-abcd-123456789abc";
const readyHealth = () => ({
  ready: true, ttsMode: "test",
  components: {
    llm: { ready: true }, stt: { ready: true }, vad: { ready: true },
    tts: { ready: true }, livekit: { ready: true }, worker: { ready: true },
  },
});
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
function installFetch(health: unknown = readyHealth()) {
  const mock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) return json(health);
    if (url.endsWith("/sessions") && init?.method === "POST") return json({ roomName, ttsMode: "test" });
    if (init?.method === "DELETE") return json({ deleted: true });
    throw new Error("Unexpected test request");
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
const request = (input: unknown, headers: Record<string, string> = {}) => new Request("http://localhost:3000/api/voice/session", {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(input),
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("VOICE_API_URL", "http://127.0.0.1:8001");
  vi.stubEnv("LIVEKIT_URL", "ws://127.0.0.1:7880");
  vi.stubEnv("LIVEKIT_PUBLIC_URL", "");
  vi.stubEnv("LIVEKIT_API_KEY", "unit-livekit-key");
  vi.stubEnv("LIVEKIT_API_SECRET", "unit-livekit-secret");
  vi.stubEnv("BOSON_API_KEY", "");
  sdk.toJwt.mockResolvedValue("participant-scoped-jwt");
  sdk.createRoom.mockResolvedValue({ name: roomName });
  sdk.createDispatch.mockResolvedValue({ id: "unit-dispatch" });
  sdk.deleteRoom.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("voice service readiness", () => {
  it("reports actual missing models and keeps the provider identified as test speech", async () => {
    const health = readyHealth();
    const missingReason = "The local speech recognition model is not installed.";
    health.ready = false;
    health.components.stt = { ready: false, reason: missingReason } as typeof health.components.stt;
    installFetch(health);
    const state = await voiceStatus();
    expect(state.ready).toBe(false);
    expect(state.ttsProvider).toBe("test");
    expect(state.missing.join(" ")).toContain("stt");
    expect(state.missing.join(" ")).toContain(missingReason);
  });

  it("does not declare readiness when a component is unavailable despite a contradictory aggregate", async () => {
    const health = readyHealth();
    health.components.llm.ready = false;
    installFetch(health);
    expect((await voiceStatus()).ready).toBe(false);
  });

  it("requires configured LiveKit credentials even when models are ready", async () => {
    vi.stubEnv("LIVEKIT_API_SECRET", "");
    installFetch();
    const state = await voiceStatus();
    expect(state.ready).toBe(false);
    expect(state.missing.join(" ")).toContain("LiveKit");
  });

  it("reports an unavailable broker without leaking a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private service debug")));
    const state = await voiceStatus();
    expect(state.ready).toBe(false);
    expect(JSON.stringify(state)).not.toContain("private service debug");
  });

  it("treats a failed health HTTP status as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, 503)));
    expect((await voiceStatus()).ready).toBe(false);
  });

  it("exposes readiness through an uncached status endpoint without server credentials", async () => {
    installFetch();
    const response = await GET();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const state = await response.json();
    expect(state.ready).toBe(true);
    expect(JSON.stringify(state)).not.toContain("unit-livekit-secret");
    expect(JSON.stringify(state)).not.toContain("unit-livekit-key");
  });
});

describe("scoped voice sessions", () => {
  it("does not create a room, dispatch or session before all models are ready", async () => {
    const health = readyHealth();
    health.ready = false; health.components.llm.ready = false;
    const fetchMock = installFetch(health);
    await expect(createVoiceSession(demoKnowledge, "http://localhost:3000/api/voice/session")).rejects.toThrow(/not ready/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sdk.createRoom).not.toHaveBeenCalled();
    expect(sdk.createDispatch).not.toHaveBeenCalled();
    expect(sdk.toJwt).not.toHaveBeenCalled();
  });

  it("requires credentials before contacting services", async () => {
    vi.stubEnv("LIVEKIT_API_SECRET", "");
    const fetchMock = installFetch();
    await expect(createVoiceSession(demoKnowledge, "http://localhost:3000/api/voice/session")).rejects.toThrow(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves supplied knowledge and only sends expected session fields", async () => {
    const fetchMock = installFetch();
    const original = structuredClone(demoKnowledge);
    const response = await POST(request({ knowledge: demoKnowledge, language: "en", roomName: "attacker-room", agentName: "attacker", apiKey: "client-injected" }));
    expect(response.status).toBe(200);
    const call = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/sessions") && init?.method === "POST");
    expect(call).toBeDefined();
    expect(JSON.parse(call![1]!.body as string)).toEqual({ knowledge: original, language: "en" });
    expect(demoKnowledge).toEqual(original);
  });

  it("only forwards allowed knowledge fields to the Python broker", async () => {
    const fetchMock = installFetch();
    const knowledge = [{ ...demoKnowledge[0], apiKey: "client-injected", roomName: "attacker-room" }];
    const response = await POST(request({ knowledge }));
    expect(response.status).toBe(200);
    const call = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/sessions") && init?.method === "POST");
    expect(JSON.parse(call![1]!.body as string).knowledge).toEqual([demoKnowledge[0]]);
  });

  it("grants a short-lived token for just its room and microphone publication", async () => {
    installFetch();
    const result = await createVoiceSession(demoKnowledge, "https://support.example.test/api/voice/session");
    expect(sdk.addGrant).toHaveBeenCalledExactlyOnceWith({
      room: roomName, roomJoin: true, canSubscribe: true, canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE], canPublishData: false,
    });
    expect(sdk.tokenConstructor).toHaveBeenCalledWith("unit-livekit-key", "unit-livekit-secret", {
      identity: expect.stringMatching(/^visitor-/), ttl: "10m",
    });
    expect(sdk.createRoom).toHaveBeenCalledWith({ name: roomName, emptyTimeout: 120, departureTimeout: 10, maxParticipants: 2 });
    expect(sdk.createDispatch).toHaveBeenCalledWith(roomName, "liniya-support");
    expect(result).toEqual({ participantToken: "participant-scoped-jwt", serverUrl: "wss://support.example.test:7880", roomName, ttsProvider: "test" });
    expect(JSON.stringify(result)).not.toContain("unit-livekit-secret");
    expect(JSON.stringify(result)).not.toContain("unit-livekit-key");
  });

  it("uses an explicitly configured public LiveKit URL", async () => {
    vi.stubEnv("LIVEKIT_PUBLIC_URL", "wss://media.example.test");
    installFetch();
    expect((await createVoiceSession(demoKnowledge, "https://support.example.test/api/voice/session")).serverUrl).toBe("wss://media.example.test");
  });

  it("accepts URL-safe random room names generated by the Python session store", async () => {
    const urlSafeRoom = "liniya-AbCDef_0123456789-ghIJklMNopQRST";
    const fetchMock = installFetch();
    fetchMock.mockImplementation(async (url) => String(url).endsWith("/health")
      ? json(readyHealth())
      : json({ roomName: urlSafeRoom, ttsMode: "test" }));
    const result = await createVoiceSession(demoKnowledge, "http://localhost:3000/api/voice/session");
    expect(result.roomName).toBe(urlSafeRoom);
    expect(sdk.createRoom).toHaveBeenCalledWith(expect.objectContaining({ name: urlSafeRoom }));
    expect(sdk.addGrant).toHaveBeenCalledWith(expect.objectContaining({ room: urlSafeRoom }));
    expect(result.participantToken).toBe("participant-scoped-jwt");
  });

  it("rejects an invalid room name without issuing any token", async () => {
    const fetchMock = installFetch();
    fetchMock.mockImplementation(async (url) => String(url).endsWith("/health") ? json(readyHealth()) : json({ roomName: "arbitrary-admin-room" }));
    await expect(createVoiceSession(demoKnowledge, "http://localhost:3000/api/voice/session")).rejects.toThrow(/invalid room/i);
    expect(sdk.createRoom).not.toHaveBeenCalled();
    expect(sdk.toJwt).not.toHaveBeenCalled();
  });

  it("cleans up the prepared room and knowledge when dispatch fails", async () => {
    const fetchMock = installFetch();
    sdk.createDispatch.mockRejectedValue(new Error("internal dispatch details"));
    await expect(createVoiceSession(demoKnowledge, "http://localhost:3000/api/voice/session")).rejects.toThrow(/agent/i);
    expect(sdk.deleteRoom).toHaveBeenCalledWith(roomName);
    expect(fetchMock).toHaveBeenCalledWith(`http://127.0.0.1:8001/sessions/${roomName}`, expect.objectContaining({ method: "DELETE" }));
    expect(sdk.toJwt).not.toHaveBeenCalled();
  });
});

describe("voice session request boundary", () => {
  it("rejects unrelated origins before opening sessions", async () => {
    const fetchMock = installFetch();
    const response = await POST(request({ knowledge: demoKnowledge }, { Origin: "https://unrelated.example" }));
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed Origin headers", async () => {
    installFetch();
    const response = await POST(request({ knowledge: demoKnowledge }, { Origin: "not-a-url" }));
    expect(response.status).toBe(403);
  });

  it("requires JSON and rejects malformed JSON", async () => {
    installFetch();
    expect((await POST(request({ knowledge: demoKnowledge }, { "Content-Type": "text/plain" }))).status).toBe(415);
    const malformed = new Request("http://localhost:3000/api/voice/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{broken" });
    expect((await POST(malformed)).status).toBe(400);
  });

  it("rejects missing knowledge before contacting the broker", async () => {
    const fetchMock = installFetch();
    const response = await POST(request({ knowledge: [] }));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid UTF-8", async () => {
    const fetchMock = installFetch();
    const invalid = new Request("http://localhost:3000/api/voice/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: new Uint8Array([0xff, 0xfe]) });
    expect((await POST(invalid)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels oversized chunked uploads without consuming their entire bodies", async () => {
    const fetchMock = installFetch();
    let chunksRead = 0; let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { if (chunksRead >= 10) { controller.close(); return; } chunksRead += 1; controller.enqueue(new Uint8Array(400_000)); },
      cancel() { canceled = true; },
    });
    const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit & { duplex: "half" };
    expect((await POST(new Request("http://localhost:3000/api/voice/session", init))).status).toBe(413);
    expect(chunksRead).toBeLessThan(10);
    expect(canceled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns unavailable status instead of a fake successful session", async () => {
    const health = readyHealth(); health.ready = false; health.components.stt.ready = false;
    installFetch(health);
    const response = await POST(request({ knowledge: demoKnowledge }));
    expect(response.status).toBe(503);
    expect(await response.json()).toHaveProperty("error");
    expect(sdk.toJwt).not.toHaveBeenCalled();
  });
});
