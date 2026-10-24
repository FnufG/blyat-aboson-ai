#!/usr/bin/env python3
"""Actual browser-equivalent LiveKit worker check using local models and test speech.

No STT/LLM responses are mocked and no direct answer_question() calls are made.
The test joins through Next's participant endpoint, sends PCM microphone audio,
checks worker sources/transcription/received audio, and interrupts a spoken answer.
Exit 2 means setup is incomplete; exit 1 is a real check failure. Boson is not called.
"""
import asyncio
from contextlib import suppress
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv
load_dotenv(ROOT / ".env.local", override=False)
load_dotenv(ROOT / ".local" / "runtime.env", override=False)
local_espeak = ROOT / ".local" / "espeak" / "bin" / "espeak-ng"
if local_espeak.is_file():
    os.environ.setdefault("ESPEAK_BINARY", str(local_espeak))
configured_url = os.environ.get("LIVEKIT_URL", "ws://127.0.0.1:7880")
if urlparse(configured_url).scheme == "ws" and urlparse(configured_url).hostname in ("localhost", "127.0.0.1", "::1"):
    os.environ["HTTP_PROXY"] = ""
    os.environ["http_proxy"] = ""

import httpx
import numpy as np
from livekit import api, rtc
from livekit.agents.utils.audio import AudioByteStream
from voice.test_speech import speech_frames as synthesize_test_speech

TIMEOUT = float(os.environ.get("VOICE_CHECK_TIMEOUT", "90"))


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def materials():
    sections = (ROOT / "public" / "demo-faq.md").read_text(encoding="utf8").split("## ")
    entries = []
    for section in sections:
        if section.strip():
            title, content = section.strip().split("\n", 1)
            entries.append({"id": f"faq-{len(entries) + 1}", "title": title, "content": content.strip()})
    return entries


async def speech_frames(text):
    frames = await synthesize_test_speech(text)
    assert frames and sum(frame.duration for frame in frames) > 0.5, "Local speech fixture is empty"
    return frames


class Observation:
    def __init__(self, room):
        self.room = room
        self.sources = []
        self.transcripts = {}
        self.audio = []
        self.states = []
        self.errors = []
        self.tasks = set()
        self.changed = asyncio.Event()

        @room.on("data_received")
        def data_received(packet):
            if not packet.participant or packet.participant.kind != rtc.ParticipantKind.PARTICIPANT_KIND_AGENT:
                return
            if packet.topic == "liniya.error":
                self.errors.append("Worker reported a model error")
            elif packet.topic == "liniya.sources":
                data = json.loads(packet.data)
                self.sources.append({"time": time.monotonic(), "status": data.get("status"), "ids": [entry["id"] for entry in data.get("sources", [])]})
            self.changed.set()

        @room.on("participant_attributes_changed")
        def attributes_changed(attributes, participant):
            if participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT and "lk.agent.state" in attributes:
                self.states.append((time.monotonic(), attributes["lk.agent.state"]))
                self.changed.set()

        @room.on("transcription_received")
        def legacy_transcription(segments, participant, publication):
            if not participant:
                return
            for segment in segments:
                self.transcripts["legacy:" + participant.identity + ":" + segment.id] = {"speaker": participant.identity, "text": segment.text, "time": time.monotonic(), "final": segment.final}
            self.changed.set()

        def text_stream(reader, identity):
            async def consume():
                key = "stream:" + reader.info.stream_id
                entry = {"speaker": identity, "text": "", "time": time.monotonic(), "final": False}
                self.transcripts[key] = entry
                try:
                    async for text in reader:
                        entry["text"] += text
                        entry["time"] = time.monotonic()
                        self.changed.set()
                    entry["final"] = True
                finally:
                    self.changed.set()
            self.spawn(consume())
        room.register_text_stream_handler("lk.transcription", text_stream)

        @room.on("track_subscribed")
        def subscribed(track, publication, participant):
            if track.kind != rtc.TrackKind.KIND_AUDIO or participant.kind != rtc.ParticipantKind.PARTICIPANT_KIND_AGENT:
                return
            async def consume():
                stream = rtc.AudioStream(track, sample_rate=24000, num_channels=1)
                try:
                    async for packet in stream:
                        samples = np.frombuffer(packet.frame.data, dtype=np.int16).astype(np.float64)
                        rms = float(np.sqrt(np.mean(samples * samples))) if len(samples) else 0
                        self.audio.append((time.monotonic(), rms, packet.frame.duration))
                        self.changed.set()
                finally:
                    await stream.aclose()
            self.spawn(consume())

    def spawn(self, coro):
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    @property
    def agent(self):
        return next((participant for participant in self.room.remote_participants.values() if participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT), None)

    @property
    def state(self):
        return self.agent.attributes.get("lk.agent.state") if self.agent else None

    def text_since(self, since, *, user=False):
        records = [entry for entry in self.transcripts.values() if entry["time"] >= since and (entry["speaker"] == self.room.local_participant.identity) == user]
        # New SDKs may use timed JSON lines; support both plain and encoded wire text.
        result = []
        for entry in records:
            text = entry["text"]
            if text.lstrip().startswith("{"):
                try:
                    text = " ".join(json.loads(line).get("text", "") for line in text.splitlines() if line.strip())
                except (ValueError, AttributeError):
                    pass
            result.append(text)
        return " ".join(result)

    async def until(self, predicate, description, timeout=TIMEOUT):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.errors:
                raise AssertionError(self.errors[-1])
            value = predicate()
            if value:
                return value
            self.changed.clear()
            with suppress(TimeoutError):
                await asyncio.wait_for(self.changed.wait(), timeout=min(0.2, max(0.01, deadline - time.monotonic())))
        raise AssertionError(f"Timed out: {description}; agent state={self.state!r}")

    async def close(self):
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def send_microphone(source, frames, *, initial_silence=0.1, trailing_silence=1.2):
    pcm = b"\x00\x00" * int(24000 * initial_silence) + b"".join(bytes(frame.data) for frame in frames) + b"\x00\x00" * int(24000 * trailing_silence)
    chunks = AudioByteStream(24000, 1, samples_per_channel=480)
    for frame in chunks.push(pcm) + chunks.flush():
        await source.capture_frame(frame)
    await source.wait_for_playout()


async def main():
    if os.environ.get("BOSON_API_KEY"):
        emit({"check": "livekit_worker_conversation", "outcome": "setup_required", "passed": False, "reason": "This check is restricted to the local test voice and will not call Boson."})
        return 2
    web = os.environ.get("VOICE_CHECK_WEB_URL", "http://127.0.0.1:3000").rstrip("/")
    async with httpx.AsyncClient(timeout=20) as client:
        try:
            status = (await client.get(web + "/api/voice/status")).json()
        except Exception:
            emit({"check": "livekit_worker_conversation", "outcome": "setup_required", "passed": False, "reason": "Next voice status is unavailable. Start npm run voice:up and npm run voice:web."})
            return 2
        if not status.get("ready"):
            emit({"check": "livekit_worker_conversation", "outcome": "setup_required", "passed": False, "missing": status.get("missing", []), "action": "Complete npm run voice:models and restart npm run voice:up before retrying."})
            return 2
        response = await client.post(web + "/api/voice/session", json={"knowledge": materials()}, headers={"Origin": web})
        response.raise_for_status()
        session = response.json()
    assert session.get("ttsProvider") == "test", "Paid/cloud voice unexpectedly selected"
    assert re.fullmatch(r"liniya-[A-Za-z0-9_-]{16,80}", session.get("roomName", "")), "Invalid room name"
    # Preparing actual speech is allowed before joining; its PCM is sent as microphone input.
    fixtures = {name: await speech_frames(text) for name, text in {
        "warranty": "Какие условия гарантии?",
        "repeat": "Расскажите подробнее об условиях гарантии.",
        "contacts": "Как связаться с поддержкой?",
        "unknown": "Как настроить роутер ТЛ девятьсот девяносто девять?",
    }.items()}
    room = rtc.Room()
    seen = Observation(room)
    microphone = rtc.AudioSource(24000, 1, queue_size_ms=100)
    started = time.monotonic()
    try:
        await room.connect(session["serverUrl"], session["participantToken"])
        track = rtc.LocalAudioTrack.create_audio_track("test-browser-microphone", microphone)
        await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
        await seen.until(lambda: seen.state == "listening" and any(rms > 100 for _, rms, _ in seen.audio), "worker greeting to finish", timeout=45)
        emit({"stage": "worker_connected_and_greeted"})

        first = time.monotonic()
        source_count = len(seen.sources)
        await send_microphone(microphone, fixtures["warranty"])
        response = await seen.until(lambda: next((entry for entry in seen.sources[source_count:] if entry["status"] == "answered" and "faq-4" in entry["ids"]), None), "spoken warranty question to produce a cited answer")
        await seen.until(lambda: ("12" in seen.text_since(first) or "двенадц" in seen.text_since(first).lower()), "spoken answer to preserve the 12-month warranty")
        assert "гарант" in seen.text_since(first, user=True).lower(), "Worker did not transcribe the warranty question"
        await seen.until(lambda: any(at > response["time"] and rms > 100 for at, rms, _ in seen.audio), "non-silent warranty answer over WebRTC")
        await seen.until(lambda: seen.state == "listening", "warranty answer to finish")
        emit({"stage": "spoken_question_worker_stt_rag_llm_tts_passed", "source": "faq-4"})

        # Ask again, then speak a different topic while the answer is actively playing.
        second_source_count = len(seen.sources)
        await send_microphone(microphone, fixtures["repeat"])
        repeated = await seen.until(lambda: next((entry for entry in seen.sources[second_source_count:] if entry["status"] == "answered" and "faq-4" in entry["ids"]), None), "second answer to prepare the interruption")
        await seen.until(lambda: seen.state == "speaking" and any(at > repeated["time"] and rms > 100 for at, rms, _ in seen.audio[-30:]), "active audio before interruption")
        barge = time.monotonic()
        contact_source_count = len(seen.sources)
        await send_microphone(microphone, fixtures["contacts"], trailing_silence=1.4)
        state_cutoff = next((at for at, state in seen.states if barge < at < barge + 3 and state in ("listening", "thinking")), None)
        assert state_cutoff is not None, "Agent did not leave speaking state during the new user's speech"
        quiet_duration = sum(duration for at, rms, duration in seen.audio if barge + 0.6 <= at <= barge + 2.5 and rms < 80)
        assert quiet_duration >= 0.35, "Old speech did not audibly stop during interruption"
        contact = await seen.until(lambda: next((entry for entry in seen.sources[contact_source_count:] if entry["status"] == "answered" and "faq-3" in entry["ids"]), None), "interrupted question to switch to contact information")
        await seen.until(lambda: "support" in seen.text_since(barge).lower() or "адрес" in seen.text_since(barge).lower(), "contact answer transcription")
        await seen.until(lambda: any(at > contact["time"] and rms > 100 for at, rms, _ in seen.audio), "non-silent contact answer")
        await seen.until(lambda: seen.state == "listening", "contact answer to finish")
        emit({"stage": "barge_in_and_topic_switch_passed", "cutoff_ms": round((state_cutoff - barge) * 1000), "quiet_audio_ms": round(quiet_duration * 1000), "source": "faq-3"})

        unknown_started = time.monotonic()
        unknown_source_count = len(seen.sources)
        await send_microphone(microphone, fixtures["unknown"])
        await seen.until(lambda: next((entry for entry in seen.sources[unknown_source_count:] if entry["status"] == "unknown" and not entry["ids"]), None), "unknown model to abstain")
        await seen.until(lambda: "нет подтвержд" in seen.text_since(unknown_started).lower(), "spoken abstention")
        assert re.search(r"999|девятьсот|девяносто", seen.text_since(unknown_started, user=True).lower()), "Unknown-model utterance was not recognized"
        emit({"check": "livekit_worker_conversation", "outcome": "passed", "passed": True, "actual_worker_stt_llm_tts": True, "warranty_source": "faq-4", "warranty_12_months_preserved": True, "barge_in": True, "topic_switch_source": "faq-3", "unknown_model_abstained": True, "received_audio_seconds": round(sum(duration for _, _, duration in seen.audio), 2), "total_seconds": round(time.monotonic() - started, 2), "not_tested": ["Real human microphone acoustics", "Browser autoplay and microphone permission UX", "Boson API"]})
        return 0
    finally:
        await seen.close()
        await room.disconnect()
        await microphone.aclose()
        # Only delete the unique room/session created by this command.
        with suppress(Exception):
            async with api.LiveKitAPI(url=configured_url, api_key=os.environ["LIVEKIT_API_KEY"], api_secret=os.environ["LIVEKIT_API_SECRET"]) as service:
                await service.room.delete_room(api.DeleteRoomRequest(room=session["roomName"]))
        with suppress(Exception):
            async with httpx.AsyncClient(timeout=3) as client:
                await client.delete(os.environ.get("VOICE_API_URL", "http://127.0.0.1:8001") + "/sessions/" + session["roomName"])


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except Exception as error:
        emit({"check": "livekit_worker_conversation", "outcome": "failed", "passed": False, "errorType": type(error).__name__, "reason": str(error) if isinstance(error, AssertionError) else "A real worker conversation stage failed; inspect the local service logs. No tokens or credentials are printed."})
        sys.exit(1)
