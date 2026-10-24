import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from livekit.agents import AgentSession, llm, stt, tts
from livekit.agents.voice.events import ErrorEvent, UserTranscriptionTimeoutEvent

from voice import worker
from voice.schemas import KnowledgeEntry, SessionRequest
from voice.store import SessionStore


def session_store(monkeypatch, tmp_path):
    path = tmp_path / "sessions.sqlite3"
    monkeypatch.setenv("VOICE_SESSION_DB", str(path))
    store = SessionStore(path)
    request = SessionRequest(knowledge=[KnowledgeEntry(id="faq", title="Question", content="Answer")])
    return store, request


def context(room_name, error, *, connected=False):
    return SimpleNamespace(
        room=SimpleNamespace(name=room_name, isconnected=lambda: connected, disconnect=AsyncMock()),
        connect=AsyncMock(),
        wait_for_participant=AsyncMock(side_effect=error),
    )


def test_disconnect_while_waiting_removes_only_its_session(monkeypatch, tmp_path):
    store, request = session_store(monkeypatch, tmp_path)
    abandoned = store.create(request)
    other = store.create(request)
    ctx = context(abandoned, RuntimeError("room disconnected while waiting for participant"))

    asyncio.run(worker.entrypoint(ctx))

    assert store.get(abandoned) is None
    assert store.get(other) is not None
    ctx.room.disconnect.assert_not_awaited()


@pytest.mark.parametrize("connected", [True, False])
def test_unrelated_wait_error_propagates(monkeypatch, tmp_path, connected):
    store, request = session_store(monkeypatch, tmp_path)
    room_name = store.create(request)
    error = RuntimeError("unexpected SDK failure")
    ctx = context(room_name, error, connected=connected)

    with pytest.raises(RuntimeError) as raised:
        asyncio.run(worker.entrypoint(ctx))

    assert raised.value is error
    assert store.get(room_name) is not None
    ctx.room.disconnect.assert_not_awaited()


def observed_room():
    delivered = []
    arrived = asyncio.Event()

    async def publish(payload, **kwargs):
        delivered.append((json.loads(payload), kwargs))
        arrived.set()

    room = SimpleNamespace(local_participant=SimpleNamespace(publish_data=AsyncMock(side_effect=publish)))
    return room, delivered, arrived


@pytest.mark.parametrize("error_type,provider,code,stage,expected", [
    (stt.STTError, "local", "speech_recognition_failed", "speech_recognition", "Speech recognition"),
    (tts.TTSError, "boson", "speech_output_failed", "speech_output", "BOSON_API_KEY"),
    (tts.TTSError, "local", "speech_output_failed", "speech_output", "test voice"),
    (llm.LLMError, "local", "provider_unavailable", "answer_generation", "language model"),
])
def test_session_errors_reach_ui_before_a_greeting_can_complete(error_type, provider, code, stage, expected):
    async def run():
        # Use the maintained SDK's typed event and real event emitter. The session
        # has not started, matching registration before session.start/on_enter.
        session = AgentSession()
        room, delivered, arrived = observed_room()
        diagnostics = worker.VoiceDiagnostics(session, room, voice_provider=provider)
        private = "private-provider-url-with-token-and-audio-details"
        event = ErrorEvent(error=error_type(timestamp=time.time(), label="provider", error=RuntimeError(private), recoverable=True), source=None)
        try:
            session.emit("error", event)
            session.emit("error", event)  # SDK retries must not flood the UI.
            await asyncio.wait_for(arrived.wait(), 1)
            assert len(delivered) == 1
            payload, options = delivered[0]
            assert payload["code"] == code
            assert payload["stage"] == stage
            assert expected in payload["error"]
            assert options == {"topic": "liniya.error", "reliable": True}
            assert private not in json.dumps(payload)
        finally:
            await diagnostics.aclose()

    asyncio.run(run())


def test_detected_speech_without_transcription_reports_actionable_error():
    async def run():
        session = AgentSession()
        room, delivered, arrived = observed_room()
        diagnostics = worker.VoiceDiagnostics(session, room, voice_provider="local")
        try:
            session.emit("user_transcription_timeout", UserTranscriptionTimeoutEvent(speech_duration=1.5, vad_speech_started_at=time.time()))
            await asyncio.wait_for(arrived.wait(), 1)
            payload, _ = delivered[0]
            assert payload["code"] == "speech_not_transcribed"
            assert payload["stage"] == "speech_recognition"
            assert "no transcript" in payload["error"]
            assert "English" in payload["error"]
        finally:
            await diagnostics.aclose()

    asyncio.run(run())


@pytest.mark.parametrize("provider_code,expected_code,expected_message", [
    ("missing_llm_key", "missing_llm_key", "LLM_API_KEY"),
    ("provider_auth", "provider_auth", "permissions"),
    ("provider_quota", "provider_quota", "billing"),
    ("untrusted-provider-detail", "provider_unavailable", "temporarily unavailable"),
])
def test_grounded_model_failure_preserves_safe_typed_error(monkeypatch, provider_code, expected_code, expected_message):
    async def fail(request):
        raise worker.AnswerUnavailable("private provider response must not reach the browser", provider_code)

    monkeypatch.setattr(worker, "answer_question", fail)

    async def run():
        room, delivered, _ = observed_room()
        data = SessionRequest(knowledge=[KnowledgeEntry(id="source", title="Hours", content="We open at 9am.")])
        agent = worker.SupportAgent(data, room)
        chat = llm.ChatContext()
        chat.add_message(role="user", content="When are you open?")
        spoken = [part async for part in agent.llm_node(chat, [], None)]
        assert spoken and "could not prepare" in spoken[0]
        payload, _ = delivered[0]
        assert payload["code"] == expected_code
        assert payload["stage"] == "answer_generation"
        assert expected_message in payload["error"]
        assert "private provider" not in json.dumps(payload)
        assert "untrusted-provider-detail" not in json.dumps(payload)

    asyncio.run(run())


def test_diagnostic_delivery_failure_is_sanitized_and_does_not_raise(caplog):
    private = "private-data-channel-url-and-session-token"
    room = SimpleNamespace(local_participant=SimpleNamespace(publish_data=AsyncMock(side_effect=RuntimeError(private))))
    asyncio.run(worker.publish_voice_error(room, code="speech_output_failed", stage="speech_output", message="Could not produce speech."))
    assert "speech_output_failed" in caplog.text
    assert private not in caplog.text
