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
  if (failure === MediaDeviceFailure.PermissionDenied) return "Доступ к микрофону запрещён. Разрешите его в настройках сайта в браузере и попробуйте снова.";
  if (failure === MediaDeviceFailure.NotFound) return "Микрофон не найден. Подключите микрофон или гарнитуру и попробуйте снова.";
  if (failure === MediaDeviceFailure.DeviceInUse) return "Не удалось открыть микрофон. Проверьте, не занят ли он другим приложением, и попробуйте снова.";
  return "Не удалось включить микрофон. Проверьте подключение устройства и разрешения браузера.";
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
    [ConnectionState.Connecting]: "Подключаем разговор…",
    [ConnectionState.Reconnecting]: "Восстанавливаем соединение…",
    [ConnectionState.SignalReconnecting]: "Восстанавливаем соединение…",
    [ConnectionState.Disconnected]: "Соединение закрыто",
  };
  const agentLabels: Record<string, string> = {
    connecting: "Ожидаем голосового агента…",
    initializing: "Агент готовится к разговору…",
    "pre-connect-buffering": "Готовим голосовой канал…",
    listening: "Агент слушает вас",
    thinking: "Агент подбирает ответ",
    speaking: "Агент отвечает",
    idle: "Агент подключён",
    failed: "Не удалось подключить агента",
    disconnected: "Разговор завершён",
  };
  const label = connectionState === ConnectionState.Connected ? agentLabels[state] ?? "Агент подключается…" : connectionLabel[connectionState] ?? "Подключаем разговор…";
  const rows = transcriptions.length > 0
    ? transcriptions.slice(-80).map((item) => ({ id: item.streamInfo.id, text: item.text, isUser: item.participantInfo.identity === localParticipant.identity }))
    : agentTranscriptions.slice(-80).map((item) => ({ id: item.id, text: item.text, isUser: false }));

  return <>
    <div className="voice-stage" aria-live="polite">
      <div className={`voice-orb ${audioTrack ? "has-audio" : ""}`}>
        {audioTrack ? <BarVisualizer track={audioTrack} barCount={5} options={{ minHeight: 12, maxHeight: 90 }} className="voice-bars" aria-label="Уровень звука агента" /> : <MicrophoneIcon />}
      </div>
      <h2>{label}</h2>
      <p>{connectionState === ConnectionState.Connected ? isMicrophoneEnabled ? "Говорите в обычном темпе. Можно перебивать ответ." : "Микрофон выключен. Включите его, чтобы агент вас услышал." : "Соединяем микрофон с голосовым агентом."}</p>
      <div className="voice-connection-details"><span className={connectionState === ConnectionState.Connected ? "connected" : ""}>Канал: {connectionState === ConnectionState.Connected ? "подключён" : "подключение"}</span><span>Микрофон: {isMicrophoneEnabled ? "включён" : "выключен"}</span></div>
    </div>
    {agentDelayed && <div className="notice warning" role="status">Голосовой канал подключён, но агент пока не появился. Запуск моделей может занять время. Можно подождать или завершить разговор и повторить попытку.</div>}
    {modelError && <div className="notice warning voice-model-warning" role="alert"><span><strong>Не удалось подготовить ответ.</strong> {modelError} Попробуйте повторить вопрос.</span></div>}
    <div className="voice-controls">
      <TrackToggle source={Track.Source.Microphone} showIcon onDeviceError={(cause) => onError(microphoneError(cause))} className="voice-microphone-button">{isMicrophoneEnabled ? "Выключить микрофон" : "Включить микрофон"}</TrackToggle>
      <DisconnectButton stopTracks className="voice-disconnect-button">Завершить разговор</DisconnectButton>
    </div>
    <StartAudio label="Включить звук ответов" className="voice-start-audio" />
    <RoomAudioRenderer />
    {lastSources !== null && <section className="voice-answer-sources" aria-label="Источники последнего ответа"><div className="voice-source-heading"><h3>Источники последнего ответа</h3>{answerStatus === "unknown" && <span>Нет ответа в базе</span>}{answerStatus === "clarification" && <span>Нужно уточнение</span>}</div>{lastSources.length ? lastSources.map((source) => <details key={source.id}><summary>{source.title}</summary><p>{source.content}</p></details>) : <p className="voice-no-sources">Для последнего ответа источники не указаны.</p>}</section>}
    <section className="voice-transcript-section" aria-label="Расшифровка голосового разговора"><div className="voice-transcript-heading"><h3>Текст разговора</h3><span>Только в текущей сессии</span></div><div ref={transcriptRef} className="voice-transcript" role="log" aria-live="polite" aria-relevant="additions text">{rows.length ? rows.map((row) => <div key={row.id} className={`voice-transcript-row ${row.isUser ? "user" : "assistant"}`}><span>{row.isUser ? "Вы" : "Помощник"}</span><p>{row.text}</p></div>) : <p className="voice-transcript-placeholder">Здесь появятся распознанные реплики, когда начнётся разговор.</p>}</div></section>
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
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Не удалось проверить голосовой сервис.");
      if (typeof data.ready !== "boolean" || !Array.isArray(data.missing) || !["boson", "test"].includes(data.ttsProvider)) throw new Error("Голосовой сервис вернул некорректный статус.");
      if (controller.signal.aborted) return;
      setStatus({ ready: data.ready, missing: data.missing.filter((value: unknown): value is string => typeof value === "string"), ttsProvider: data.ttsProvider, details: typeof data.details === "string" ? data.details : undefined });
    } catch (cause) {
      if (!controller.signal.aborted) { setStatus(null); setStatusError(cause instanceof Error ? cause.message : "Не удалось проверить голосовой сервис."); }
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
    setError(failure && failure !== MediaDeviceFailure.Other ? microphoneError(cause) : "Не удалось установить голосовое соединение. Проверьте доступность сервиса, подключение к сети и попробуйте снова.");
    setSession(null);
  }, []);

  const handleMediaFailure = useCallback((failure?: MediaDeviceFailure) => {
    setError(failure === MediaDeviceFailure.PermissionDenied ? "Браузер запретил доступ к микрофону. Разрешите его в настройках сайта." : failure === MediaDeviceFailure.NotFound ? "Микрофон не найден. Подключите его и повторите попытку." : "Не удалось включить микрофон. Проверьте устройство и разрешения браузера.");
    setSession(null);
  }, []);

  const handleDisconnected = useCallback((reason?: DisconnectReason) => {
    setSession(null);
    if (reason !== undefined && reason !== DisconnectReason.CLIENT_INITIATED) {
      setError("Голосовое соединение прервано. Микрофон отключён. Проверьте доступность сервиса и попробуйте начать разговор снова.");
    } else {
      setNotice("Разговор завершён. Микрофон отключён. Можно начать новый диалог.");
    }
  }, []);

  async function startConversation() {
    if (connecting || session || !status?.ready) return;
    setError("");
    setNotice("");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setSecureContext(false);
      setError("Для микрофона откройте приложение по HTTPS или на localhost. В этом контексте браузер не разрешает доступ к аудио.");
      return;
    }
    if (!knowledge.length) { setError("Добавьте материалы в базу знаний перед разговором."); return; }
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
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Не удалось начать голосовой разговор.");
      if (typeof data.serverUrl !== "string" || typeof data.participantToken !== "string" || !data.participantToken.trim() || typeof data.roomName !== "string" || !data.roomName.trim() || !["boson", "test"].includes(data.ttsProvider)) throw new Error("Голосовой сервис вернул некорректные параметры подключения.");
      const serverUrl = new URL(data.serverUrl);
      if (!["ws:", "wss:"].includes(serverUrl.protocol)) throw new Error("Некорректный адрес голосового сервиса.");
      if (currentAttempt !== attempt.current || controller.signal.aborted) return;
      setSession({ serverUrl: data.serverUrl, participantToken: data.participantToken, roomName: data.roomName, ttsProvider: data.ttsProvider });
    } catch (cause) {
      if (currentAttempt !== attempt.current || controller.signal.aborted) return;
      const isMediaError = cause instanceof DOMException;
      setError(isMediaError ? microphoneError(cause) : cause instanceof Error ? cause.message : "Не удалось начать голосовой разговор. Проверьте соединение и повторите попытку.");
    } finally { if (currentAttempt === attempt.current) setConnecting(false); }
  }

  function cancelConnecting() {
    attempt.current += 1;
    sessionRequest.current?.abort();
    setConnecting(false);
    setNotice("Подключение отменено.");
  }

  const activeProvider = session?.ttsProvider ?? status?.ttsProvider;
  return <div className="voice-layout">
    <section className="voice-panel" aria-label="Голосовой диалог в браузере">
      <div className="voice-panel-header"><div><h2>Голосовой диалог</h2><p>Помощник ТехноЛинии · Русский язык</p></div><span className={`voice-provider-tag ${activeProvider === "boson" ? "boson" : ""}`}>{activeProvider === "boson" ? "Голос Boson" : activeProvider === "test" ? "Тестовый голос" : "Проверка сервиса"}</span></div>
      {activeProvider === "test" && <div className="voice-provider-note">Сейчас используется тестовый синтез речи. Это не голос Boson — проверяем сам разговор и ответы по базе знаний.</div>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {notice && <div className="notice success" role="status">{notice}</div>}
      {!secureContext && <div className="notice warning" role="status">Для доступа к микрофону нужен HTTPS или localhost. Откройте приложение в безопасном контексте.</div>}
      {session ? <LiveKitRoom key={session.roomName} serverUrl={session.serverUrl} token={session.participantToken} connect audio={{ echoCancellation: true, noiseSuppression: true, autoGainControl: true }} video={false} className="voice-livekit" data-lk-theme="default" onDisconnected={handleDisconnected} onError={handleRoomError} onMediaDeviceFailure={handleMediaFailure}>
        <LiveConversation onError={setError} knowledge={knowledge} />
      </LiveKitRoom> : <>
        <div className="voice-stage voice-idle"><div className="voice-orb"><MicrophoneIcon /></div><h2>{connecting ? "Подготовка разговора…" : "Давайте поговорим"}</h2><p>{connecting ? "Разрешите микрофон, если браузер запросит доступ. Затем подключим голосового агента." : "Нажмите кнопку, разрешите микрофон и задайте вопрос о компании."}</p><button className="button primary voice-connect-button" onClick={() => void startConversation()} disabled={connecting || statusLoading || !status?.ready || !secureContext || !knowledge.length}>{connecting ? "Подключаем…" : "Начать голосовой разговор"}</button>{connecting && <button className="text-link voice-cancel-connect" onClick={cancelConnecting}>Отменить подключение</button>}</div>
        <div className="voice-service-status" aria-live="polite">{statusLoading ? <p>Проверяем доступность голосового сервиса…</p> : statusError ? <p className="voice-status-error">{statusError}</p> : status?.ready ? <p className="voice-status-ready"><span />Голосовой сервис готов к подключению</p> : <><p>Голосовой сервис пока не готов.</p>{status?.details && <p>{status.details}</p>}{Boolean(status?.missing.length) && <details><summary>Что требуется для запуска</summary><ul>{status?.missing.map((item) => <li key={item}>{item}</li>)}</ul></details>}</>}<button className="text-link" disabled={statusLoading} onClick={() => void refreshStatus()}>Проверить подключение ещё раз</button></div>
      </>}
    </section>
    <aside className="voice-notes"><section className="knowledge-preview"><div className="section-kicker">ПРОВЕРКА ГОЛОСОМ</div><h2>Те же знания.<br />Живой разговор.</h2><p>Агент получает {knowledge.length} материалов из вашей текущей базы. Спросите об инструкции, затем задайте уточняющий вопрос.</p><div className="voice-example"><strong>Попробуйте сказать</strong><p>«На роутере мигает красный индикатор. Что делать?»</p><p>«А если это не помогло?»</p></div></section><section className="mode-card"><h3>Разговор в браузере</h3><p>Используйте гарнитуру, чтобы звук ответа не попадал обратно в микрофон. При выходе из вкладки или изменении базы разговор завершится.</p></section><p className="voice-privacy-note">Аудио передаётся голосовому сервису во время разговора. Текст этой сессии не сохраняется в браузере.</p></aside>
  </div>;
}
