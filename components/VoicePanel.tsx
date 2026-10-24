"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BarVisualizer,
  DisconnectButton,
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
  TrackToggle,
  useConnectionState,
  useDataChannel,
  useLocalParticipant,
  useTranscriptions,
  useVoiceAssistant,
} from "@livekit/components-react";
import { ConnectionState, DisconnectReason, MediaDeviceFailure, ParticipantKind, Track } from "livekit-client";
import "@livekit/components-styles";
import type { KnowledgeEntry } from "@/lib/types";

interface VoiceStatus {
  ready: boolean;
  missing: string[];
  ttsProvider: "boson" | "test";
  details?: string;
}
interface VoiceSession {
  serverUrl: string;
  participantToken: string;
  roomName: string;
  ttsProvider: "boson" | "test";
}

function MicrophoneIcon({ muted = false }: { muted?: boolean }) {
  return <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />{muted && <path d="m3 3 18 18" />}</svg>;
}

function microphoneError(cause: unknown): string {
  const failure = MediaDeviceFailure.getFailure(cause);
  if (failure === MediaDeviceFailure.PermissionDenied) return "Microphone access denied. Allow it in your browser site settings and try again.";
  if (failure === MediaDeviceFailure.NotFound) return "No microphone found. Connect a microphone or headset and try again.";
  if (failure === MediaDeviceFailure.DeviceInUse) return "Could not open the microphone. Check whether another application is using it and try again.";
  return "Could not enable the microphone. Check your device connection and browser permissions.";
}

function LiveConversation({ onError, knowledge }: { onError: (message: string) => void; knowledge: KnowledgeEntry[] }) {
  const { state, agent, audioTrack, agentTranscriptions } = useVoiceAssistant();
  const connectionState = useConnectionState();
  const { isMicrophoneEnabled, localParticipant } = useLocalParticipant();
  const transcriptions = useTranscriptions();
  const [agentDelayed, setAgentDelayed] = useState(false);
  const [modelError, setModelError] = useState("");
  const [lastSources, setLastSources] = useState<KnowledgeEntry[] | null>(null);
  const [answerStatus, setAnswerStatus] = useState<"answered" | "unknown" | "clarification" | null>(null);

  useDataChannel("liniya.error", (message) => {
    if (!message.from || message.from.kind !== ParticipantKind.AGENT || (agent && message.from.identity !== agent.identity) || message.payload.byteLength > 16_000) return;
    try {
      const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(message.payload));
      if (!data || typeof data !== "object" || !("error" in data) || typeof data.error !== "string" || !data.error.trim() || data.error.length > 2000) return;
      setModelError(data.error.trim());
      setLastSources(null);
      setAnswerStatus(null);
    } catch { /* Ignore malformed messages without interrupting the audio connection. */ }
  });

  useDataChannel("liniya.sources", (message) => {
    if (!message.from || message.from.kind !== ParticipantKind.AGENT || (agent && message.from.identity !== agent.identity) || message.payload.byteLength > 50_000) return;
    try {
      const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(message.payload)) as Record<string, unknown>;
      if (!data || typeof data !== "object" || !Array.isArray(data.sources) || data.sources.length > 3 || !["answered", "unknown", "clarification"].includes(String(data.status))) return;
      const sources: KnowledgeEntry[] = [];
      for (const value of data.sources) {
        if (!value || typeof value !== "object" || typeof value.id !== "string" || typeof value.title !== "string" || !value.title.trim() || value.title.length > 200 || typeof value.content !== "string" || !value.content.trim() || value.content.length > 4000) return;
        const source = knowledge.find((entry) => entry.id === value.id);
        if (!source || sources.some((entry) => entry.id === source.id)) return;
        sources.push(source);
      }
      if (data.status === "answered" && !sources.length) return;
      setLastSources(sources);
      setAnswerStatus(data.status as "answered" | "unknown" | "clarification");
      setModelError("");
    } catch { /* Source metadata is optional; malformed data never replaces a valid answer. */ }
  });
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setAgentDelayed(false);
    if (connectionState !== ConnectionState.Connected || agent) return;
    const timeout = window.setTimeout(() => setAgentDelayed(true), 30_000);
    return () => window.clearTimeout(timeout);
  }, [connectionState, agent]);

  useEffect(() => {
    const element = transcriptRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
  }, [transcriptions, agentTranscriptions]);

  const connectionLabel: Partial<Record<ConnectionState, string>> = {
    [ConnectionState.Connecting]: "Connecting conversation…",
    [ConnectionState.Reconnecting]: "Reconnecting…",
    [ConnectionState.SignalReconnecting]: "Reconnecting…",
    [ConnectionState.Disconnected]: "Connection closed",
  };
  const agentLabels: Record<string, string> = {
    connecting: "Waiting for your voice agent…",
    initializing: "Your agent is getting ready…",
    "pre-connect-buffering": "Preparing the audio connection…",
    listening: "Your agent is listening",
    thinking: "Your agent is preparing an answer",
    speaking: "Your agent is speaking",
    idle: "Agent connected",
    failed: "Could not connect the agent",
    disconnected: "Conversation ended",
  };
  const label = connectionState === ConnectionState.Connected ? agentLabels[state] ?? "Connecting your agent…" : connectionLabel[connectionState] ?? "Connecting conversation…";
  const rows = transcriptions.length > 0
    ? transcriptions.slice(-80).map((item) => ({ id: item.streamInfo.id, text: item.text, isUser: item.participantInfo.identity === localParticipant.identity }))
    : agentTranscriptions.slice(-80).map((item) => ({ id: item.id, text: item.text, isUser: false }));

  return <>
    <div className="voice-stage" aria-live="polite">
      <div className={`voice-orb ${audioTrack ? "has-audio" : ""}`}>
        {audioTrack ? <BarVisualizer track={audioTrack} barCount={5} options={{ minHeight: 12, maxHeight: 90 }} className="voice-bars" aria-label="Agent audio level" /> : <MicrophoneIcon />}
      </div>
      <h2>{label}</h2>
      <p>{connectionState === ConnectionState.Connected ? isMicrophoneEnabled ? "Speak naturally. You can interrupt an answer." : "Your microphone is off. Turn it on so the agent can hear you." : "Connecting your microphone to the voice agent."}</p>
      <div className="voice-connection-details"><span className={connectionState === ConnectionState.Connected ? "connected" : ""}>Connection: {connectionState === ConnectionState.Connected ? "connected" : "connecting"}</span><span>Microphone: {isMicrophoneEnabled ? "on" : "off"}</span></div>
    </div>
    {agentDelayed && <div className="notice warning" role="status">The audio connection is active, but the agent has not joined yet. You can wait or end the conversation and try again.</div>}
    {modelError && <div className="notice warning voice-model-warning" role="alert"><span><strong>Could not prepare an answer.</strong> {modelError} Please repeat your question.</span></div>}
    <div className="voice-controls">
      <TrackToggle source={Track.Source.Microphone} showIcon onDeviceError={(cause) => onError(microphoneError(cause))} className="voice-microphone-button">{isMicrophoneEnabled ? "Mute microphone" : "Unmute microphone"}</TrackToggle>
      <DisconnectButton stopTracks className="voice-disconnect-button">End conversation</DisconnectButton>
    </div>
    <StartAudio label="Enable answer audio" className="voice-start-audio" />
    <RoomAudioRenderer />
    {lastSources !== null && <section className="voice-answer-sources" aria-label="Latest answer sources"><div className="voice-source-heading"><h3>Latest answer sources</h3>{answerStatus === "unknown" && <span>No answer in the knowledge base</span>}{answerStatus === "clarification" && <span>Clarification needed</span>}</div>{lastSources.length ? lastSources.map((source) => <details key={source.id}><summary>{source.title}</summary><p>{source.content}</p></details>) : <p className="voice-no-sources">No sources were cited for the latest answer.</p>}</section>}
    <section className="voice-transcript-section" aria-label="Voice conversation transcript"><div className="voice-transcript-heading"><h3>Conversation transcript</h3><span>Current session only</span></div><div ref={transcriptRef} className="voice-transcript" role="log" aria-live="polite" aria-relevant="additions text">{rows.length ? rows.map((row) => <div key={row.id} className={`voice-transcript-row ${row.isUser ? "user" : "assistant"}`}><span>{row.isUser ? "You" : "Assistant"}</span><p>{row.text}</p></div>) : <p className="voice-transcript-placeholder">Transcribed speech will appear here when the conversation starts.</p>}</div></section>
  </>;
}

export default function VoicePanel({ knowledge }: { knowledge: KnowledgeEntry[] }) {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [session, setSession] = useState<VoiceSession | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [secureContext, setSecureContext] = useState(true);
  const statusRequest = useRef<AbortController | null>(null);
  const sessionRequest = useRef<AbortController | null>(null);
  const attempt = useRef(0);
  const knowledgeKey = JSON.stringify(knowledge);

  const refreshStatus = useCallback(async () => {
    statusRequest.current?.abort();
    const controller = new AbortController();
    statusRequest.current = controller;
    setStatusLoading(true);
    setStatusError("");
    try {
      const response = await fetch("/api/voice/status", { signal: controller.signal, cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not check the voice service.");
      if (typeof data.ready !== "boolean" || !Array.isArray(data.missing) || !["boson", "test"].includes(data.ttsProvider)) throw new Error("The voice service returned an invalid status.");
      if (controller.signal.aborted) return;
      setStatus({ ready: data.ready, missing: data.missing.filter((value: unknown): value is string => typeof value === "string"), ttsProvider: data.ttsProvider, details: typeof data.details === "string" ? data.details : undefined });
    } catch (cause) {
      if (!controller.signal.aborted) { setStatus(null); setStatusError(cause instanceof Error ? cause.message : "Could not check the voice service."); }
    } finally { if (!controller.signal.aborted) setStatusLoading(false); }
  }, []);

  useEffect(() => {
    setSecureContext(window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia));
    void refreshStatus();
    return () => statusRequest.current?.abort();
  }, [refreshStatus]);

  useEffect(() => {
    attempt.current += 1;
    sessionRequest.current?.abort();
    setSession(null);
    setConnecting(false);
    return () => {
      attempt.current += 1;
      sessionRequest.current?.abort();
    };
  }, [knowledgeKey]);


  const handleRoomError = useCallback((cause: Error) => {
    const failure = MediaDeviceFailure.getFailure(cause);
    setError(failure && failure !== MediaDeviceFailure.Other ? microphoneError(cause) : "Could not establish an audio connection. Check the service and network connection, then try again.");
    setSession(null);
  }, []);

  const handleMediaFailure = useCallback((failure?: MediaDeviceFailure) => {
    setError(failure === MediaDeviceFailure.PermissionDenied ? "Your browser denied microphone access. Allow it in the site settings." : failure === MediaDeviceFailure.NotFound ? "No microphone found. Connect one and try again." : "Could not enable the microphone. Check your device and browser permissions.");
    setSession(null);
  }, []);

  const handleDisconnected = useCallback((reason?: DisconnectReason) => {
    setSession(null);
    if (reason !== undefined && reason !== DisconnectReason.CLIENT_INITIATED) {
      setError("The audio connection was interrupted and the microphone has been released. Check the service and start a new conversation.");
    } else {
      setNotice("Conversation ended. Your microphone has been released. You can start a new conversation.");
    }
  }, []);

  async function startConversation() {
    if (connecting || session || !status?.ready) return;
    setError("");
    setNotice("");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setSecureContext(false);
      setError("Open the app using HTTPS or localhost to allow microphone access.");
      return;
    }
    if (!knowledge.length) { setError("Add company information to the knowledge base before starting a conversation."); return; }
    const currentAttempt = ++attempt.current;
    const controller = new AbortController();
    sessionRequest.current?.abort();
    sessionRequest.current = controller;
    setConnecting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      stream.getTracks().forEach((track) => track.stop());
      if (currentAttempt !== attempt.current || controller.signal.aborted) return;
      const response = await fetch("/api/voice/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ knowledge }), signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not start the voice conversation.");
      if (typeof data.serverUrl !== "string" || typeof data.participantToken !== "string" || !data.participantToken.trim() || typeof data.roomName !== "string" || !data.roomName.trim() || !["boson", "test"].includes(data.ttsProvider)) throw new Error("The voice service returned invalid connection details.");
      const serverUrl = new URL(data.serverUrl);
      if (!["ws:", "wss:"].includes(serverUrl.protocol)) throw new Error("Invalid voice service address.");
      if (currentAttempt !== attempt.current || controller.signal.aborted) return;
      setSession({ serverUrl: data.serverUrl, participantToken: data.participantToken, roomName: data.roomName, ttsProvider: data.ttsProvider });
    } catch (cause) {
      if (currentAttempt !== attempt.current || controller.signal.aborted) return;
      const isMediaError = cause instanceof DOMException;
      setError(isMediaError ? microphoneError(cause) : cause instanceof Error ? cause.message : "Could not start the voice conversation. Check your connection and try again.");
    } finally { if (currentAttempt === attempt.current) setConnecting(false); }
  }

  function cancelConnecting() {
    attempt.current += 1;
    sessionRequest.current?.abort();
    setConnecting(false);
    setNotice("Connection cancelled.");
  }

  const activeProvider = session?.ttsProvider ?? status?.ttsProvider;
  return <div className="voice-layout">
    <section className="voice-panel" aria-label="Browser voice conversation">
      <div className="voice-panel-header"><div><h2>Voice conversation</h2><p>Support assistant · English</p></div><span className={`voice-provider-tag ${activeProvider === "boson" ? "boson" : ""}`}>{activeProvider === "boson" ? "Boson voice" : activeProvider === "test" ? "Test voice" : "Checking service"}</span></div>
      {activeProvider === "test" && <div className="voice-provider-note">The conversation currently uses the local test voice. Add your Boson configuration to use Boson speech.</div>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {notice && <div className="notice success" role="status">{notice}</div>}
      {!knowledge.length && <div className="notice warning" role="status">Add your company information in Knowledge base before starting a voice conversation.</div>}
      {!secureContext && <div className="notice warning" role="status">Microphone access requires HTTPS or localhost. Open the app in a secure context.</div>}
      {session ? <LiveKitRoom key={session.roomName} serverUrl={session.serverUrl} token={session.participantToken} connect audio={{ echoCancellation: true, noiseSuppression: true, autoGainControl: true }} video={false} className="voice-livekit" data-lk-theme="default" onDisconnected={handleDisconnected} onError={handleRoomError} onMediaDeviceFailure={handleMediaFailure}>
        <LiveConversation onError={setError} knowledge={knowledge} />
      </LiveKitRoom> : <>
        <div className="voice-stage voice-idle"><div className="voice-orb"><MicrophoneIcon /></div><h2>{connecting ? "Preparing conversation…" : "Let’s talk"}</h2><p>{connecting ? "Allow microphone access when your browser asks. Your voice agent will then connect." : "Start the conversation, allow microphone access, and ask a question about your company."}</p><button className="button primary voice-connect-button" onClick={() => void startConversation()} disabled={connecting || statusLoading || !status?.ready || !secureContext || !knowledge.length}>{connecting ? "Connecting…" : "Start voice conversation"}</button>{connecting && <button className="text-link voice-cancel-connect" onClick={cancelConnecting}>Cancel connection</button>}</div>
        <div className="voice-service-status" aria-live="polite">{statusLoading ? <p>Checking voice service availability…</p> : statusError ? <p className="voice-status-error">{statusError}</p> : status?.ready ? <p className="voice-status-ready"><span />Voice service is ready to connect</p> : <><p>Voice service is not ready yet.</p>{status?.details && <p>{status.details}</p>}{Boolean(status?.missing.length) && <details><summary>What is needed to start</summary><ul>{status?.missing.map((item) => <li key={item}>{item}</li>)}</ul></details>}</>}<button className="text-link" disabled={statusLoading} onClick={() => void refreshStatus()}>Check connection again</button></div>
      </>}
    </section>
    <aside className="voice-notes"><section className="knowledge-preview"><div className="section-kicker">VOICE PLAYGROUND</div><h2>The same knowledge.<br />A natural conversation.</h2><p>Your agent receives {knowledge.length} entries from your current knowledge base. Ask a question about your company, then ask a follow-up.</p></section><section className="mode-card"><h3>Conversation in your browser</h3><p>Use a headset to prevent feedback. Leaving this tab or changing the knowledge base ends the conversation.</p></section><p className="voice-privacy-note">Audio is sent to the voice service during your conversation. Questions and relevant knowledge are sent to the configured language model provider. This session transcript is not saved in your browser.</p></aside>
  </div>;
}
