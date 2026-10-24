#!/usr/bin/env python3
"""Real local STT -> retrieval -> LLM -> TTS check, without mocks or paid Boson calls.

Input is genuine synthetic speech from the pinned CC0 Piper Denis voice.
Output exercises the application's local eSpeak TTS adapter.

Requires installed weights and a ready local stack. Exit 2 means setup is incomplete,
exit 1 means a real check failed. This does not test barge-in, user acoustics,
browser permissions, or Boson's service. Run the separate audio check for WebRTC/VAD.
"""
import asyncio
import json
import os
from pathlib import Path
import sys
import time
from urllib.parse import urlparse
import wave

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv
load_dotenv(ROOT / ".env.local", override=False)
load_dotenv(ROOT / ".local" / "runtime.env", override=False)
local_espeak = ROOT / ".local" / "espeak" / "bin" / "espeak-ng"
if local_espeak.is_file():
    os.environ.setdefault("ESPEAK_BINARY", str(local_espeak))
livekit_url = os.environ.get("LIVEKIT_URL", "ws://127.0.0.1:7880")
parsed_url = urlparse(livekit_url)
if parsed_url.scheme == "ws" and parsed_url.hostname in ("localhost", "127.0.0.1", "::1"):
    # Local RTC only; HTTPS proxying remains enabled for supported remote destinations.
    os.environ["HTTP_PROXY"] = ""
    os.environ["http_proxy"] = ""

import httpx
import numpy as np
from livekit import rtc
from livekit.agents.types import APIConnectOptions
from voice.adapters import FasterWhisperSTT, SupportTTS
from voice.answer import answer_question, model_config
from voice.schemas import AnswerRequest, HistoryMessage, KnowledgeEntry
from voice.test_speech import speech_frames


def emit(value):
    print(json.dumps(value, ensure_ascii=False))


def knowledge():
    # Internal legacy diagnostics only; never seeded into the application.
    return [
        KnowledgeEntry(id="faq-3", title="How do I contact support?", content="Email support@example.invalid."),
        KnowledgeEntry(id="faq-4", title="What is the warranty period?", content="The warranty period is 12 months from the date of purchase."),
        KnowledgeEntry(id="faq-7", title="Why is the router indicator red?", content="A red indicator means the router has not established an internet connection."),
    ]


async def synthesize(text):
    engine = SupportTTS()
    frames = []
    try:
        async with engine.synthesize(text, conn_options=APIConnectOptions(max_retry=0)) as stream:
            async for audio in stream:
                frames.append(audio.frame)
    finally:
        await engine.aclose()
    assert frames, "TTS did not produce any audio frames"
    samples = np.concatenate([np.frombuffer(frame.data, dtype=np.int16) for frame in frames])
    assert float(np.sqrt(np.mean(samples.astype(np.float64) ** 2))) > 100, "TTS produced silent audio"
    return frames


async def ready_stack():
    base = os.environ.get("VOICE_BACKEND_URL", "http://127.0.0.1:8001").rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(base + "/health")
            response.raise_for_status()
            state = response.json()
    except Exception:
        emit({"check": "local_stt_rag_llm_tts_pipeline", "outcome": "setup_required", "passed": False, "reason": "Голосовой backend недоступен.", "action": "Запустите npm run voice:up и проверьте npm run voice:status."})
        return False
    if not state.get("ready"):
        unavailable = [{"component": name, "reason": component.get("reason", "Компонент не готов.")} for name, component in state.get("components", {}).items() if not component.get("ready")]
        emit({"check": "local_stt_rag_llm_tts_pipeline", "outcome": "setup_required", "passed": False, "unavailable": unavailable, "action": "Завершите установку весов командой npm run voice:models, затем запустите npm run voice:up. Проверьте разрешённые сетевые назначения, если загрузка весов блокируется."})
        return False
    return True


async def main():
    if os.environ.get("LLM_BACKEND", "cloud") != "local" or os.environ.get("VOICE_ALLOW_LEGACY_SYNTHETIC") != "1":
        emit({"check": "legacy_synthetic_voice", "outcome": "blocked", "passed": False, "reason": "Legacy local-only diagnostic: not an English cloud acceptance check. Requires explicit LLM_BACKEND=local and VOICE_ALLOW_LEGACY_SYNTHETIC=1; never enables cloud calls."})
        return 2
    if os.environ.get("BOSON_API_KEY"):
        emit({"check": "local_stt_rag_llm_tts_pipeline", "outcome": "setup_required", "passed": False, "reason": "Эта проверка использует только локальную тестовую озвучку. При наличии Boson binding запуск отменён, чтобы не выполнять платный API-вызов."})
        return 2
    if not await ready_stack():
        return 2
    started = time.perf_counter()
    materials = knowledge()
    question_audio = await speech_frames("Какие условия гарантии?")
    speech = FasterWhisperSTT()
    stt_started = time.perf_counter()
    try:
        event = await speech.recognize(rtc.combine_audio_frames(question_audio), language="ru", conn_options=APIConnectOptions(max_retry=0))
    finally:
        await speech.aclose()
    transcript = event.alternatives[0].text.strip() if event.alternatives else ""
    assert "гарант" in transcript.lower(), f"Russian recognition did not preserve the warranty question: {transcript!r}"
    stt_seconds = time.perf_counter() - stt_started
    llm_started = time.perf_counter()
    reply = await answer_question(AnswerRequest(question=transcript, knowledge=materials))
    llm_seconds = time.perf_counter() - llm_started
    assert reply.status == "answered", f"Known question was not answered: {reply.status}"
    assert reply.answer.strip(), "The LLM answer was empty"
    assert any(source.id == "faq-4" for source in reply.sources), "The warranty answer did not cite the warranty FAQ"
    assert "12" in reply.answer or "двенадц" in reply.answer.lower(), "The answer did not preserve the documented 12-month warranty"
    answer_audio = await synthesize(reply.answer)
    assert sum(frame.duration for frame in answer_audio) > 0.5, "The spoken answer was too short"
    with wave.open("/tmp/liniya-conversation-answer.wav", "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24000)
        audio.writeframes(b"".join(bytes(frame.data) for frame in answer_audio))

    history = [HistoryMessage(role="user", content=transcript), HistoryMessage(role="assistant", content=reply.answer, sourceIds=[source.id for source in reply.sources])]
    unsupported = await answer_question(AnswerRequest(question="А как настроить роутер TL-999?", knowledge=materials, history=history))
    assert unsupported.status == "unknown" and unsupported.sources == [], "An unknown model inherited another model's instructions"
    switched = await answer_question(AnswerRequest(question="Расскажите подробнее, как связаться с поддержкой?", knowledge=materials, history=history))
    assert switched.status == "answered" and any(source.id == "faq-3" for source in switched.sources), "A new contact question incorrectly retained the warranty topic"
    emit({"check": "local_stt_rag_llm_tts_pipeline", "outcome": "passed", "passed": True, "model": model_config()["model"], "synthetic_input": "piper/ru_RU-denis-medium", "output_tts": "espeak/local", "transcript": transcript, "sourceIds": [source.id for source in reply.sources], "unknown_model_abstained": True, "topic_switch_cited_contacts": True, "answer_audio_seconds": round(sum(frame.duration for frame in answer_audio), 2), "stt_seconds": round(stt_seconds, 2), "llm_seconds": round(llm_seconds, 2), "total_seconds": round(time.perf_counter() - started, 2), "not_tested": ["WebRTC transport (run voice-audio-check.py separately)", "LiveKit worker turn routing and barge-in", "Real user acoustics and browser microphone permissions", "Boson API"]})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except Exception as error:
        # Avoid provider exceptions, URLs, or credentials in the command output.
        emit({"check": "local_stt_rag_llm_tts_pipeline", "outcome": "failed", "passed": False, "errorType": type(error).__name__, "reason": str(error) if isinstance(error, AssertionError) else "Один из реальных этапов завершился ошибкой. Проверьте состояние моделей и журналы локального сервиса."})
        sys.exit(1)
