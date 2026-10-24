#!/usr/bin/env python3
"""Checks real local TTS -> WebRTC -> PCM -> Silero VAD, without claiming STT/LLM/Boson.

Run with voice/.venv/bin/python scripts/voice-audio-check.py from project root.
No cloud API credentials are required when the development LiveKit server is running.
"""
import asyncio
import json
import os
from pathlib import Path
import sys
import uuid
import wave
from urllib.parse import urlparse

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
    # The Rust RTC transport does not honor NO_PROXY. Keep HTTPS proxying for external APIs.
    os.environ["HTTP_PROXY"] = ""
    os.environ["http_proxy"] = ""
from livekit import api, rtc
from livekit.plugins import silero
from livekit.agents import vad
from voice.adapters import SupportTTS


def token(room, identity):
    return api.AccessToken(os.environ.get("LIVEKIT_API_KEY", "devkey"), os.environ.get("LIVEKIT_API_SECRET", "secret")).with_identity(identity).with_grants(api.VideoGrants(room_join=True, room=room)).to_jwt()


async def main():
    if os.environ.get("BOSON_API_KEY"):
        raise RuntimeError("This check is intentionally for the local test voice. Run without a Boson binding to avoid a paid API call.")
    speech = SupportTTS()
    frames = []
    async with speech.synthesize("Hello! What are your support hours?") as stream:
        async for audio in stream:
            frames.append(audio.frame)
    await speech.aclose()
    assert frames and sum(frame.duration for frame in frames) > 1, "No synthesized audio"
    waveform = b"".join(bytes(frame.data) for frame in frames)
    with wave.open("/tmp/liniya-local-speech.wav", "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24000)
        audio.writeframes(waveform)

    room_name = "liniya-audio-check-" + uuid.uuid4().hex[:12]
    publisher, subscriber = rtc.Room(), rtc.Room()
    url = os.environ.get("LIVEKIT_URL", "ws://127.0.0.1:7880")
    received = []
    received_enough = asyncio.Event()
    receiver_task = None

    @subscriber.on("track_subscribed")
    def track_subscribed(track, publication, participant):
        nonlocal receiver_task
        if track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        async def consume():
            stream = rtc.AudioStream(track, sample_rate=16000, num_channels=1)
            try:
                async for packet in stream:
                    received.append(packet.frame)
                    if sum(frame.duration for frame in received) >= 2.5:
                        received_enough.set()
                        return
            finally:
                await stream.aclose()
        receiver_task = asyncio.create_task(consume())

    source = rtc.AudioSource(24000, 1)
    try:
        await subscriber.connect(url, token(room_name, "audio-check-listener"))
        await publisher.connect(url, token(room_name, "audio-check-speaker"))
        track = rtc.LocalAudioTrack.create_audio_track("local-test-voice", source)
        await publisher.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
        # Wait for subscription before transmitting; silence allows Opus/WebRTC startup.
        await asyncio.sleep(0.5)
        from livekit.agents.utils.audio import AudioByteStream
        audio_stream = AudioByteStream(24000, 1, samples_per_channel=480)
        pcm = b"\x00\x00" * 12000 + waveform + b"\x00\x00" * 24000
        for frame in audio_stream.push(pcm) + audio_stream.flush():
            await source.capture_frame(frame)
        await source.wait_for_playout()
        await asyncio.wait_for(received_enough.wait(), timeout=15)
        assert received, "No WebRTC audio received"
        import numpy as np
        samples = np.concatenate([np.frombuffer(frame.data, dtype=np.int16) for frame in received])
        rms = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))
        assert rms > 100, f"WebRTC audio was silent (RMS={rms:.2f})"
        detector = silero.VAD.load(force_cpu=True)
        events = []
        voice_stream = detector.stream()
        try:
            async def collect():
                async for event in voice_stream:
                    events.append(event)
            collector = asyncio.create_task(collect())
            for frame in received:
                voice_stream.push_frame(frame)
            voice_stream.end_input()
            await collector
        finally:
            await voice_stream.aclose()
        assert any(event.type == vad.VADEventType.START_OF_SPEECH for event in events), "Silero did not detect speech"
        print(json.dumps({"check": "local_tts_webrtc_vad", "passed": True, "tts": "espeak-ng", "received_frames": len(received), "received_seconds": round(sum(frame.duration for frame in received), 2), "rms": round(rms, 2), "speech_detected": True, "not_tested": ["Whisper recognition", "LLM answers", "Boson API"]}, ensure_ascii=False))
    finally:
        if receiver_task and not receiver_task.done():
            receiver_task.cancel()
            await asyncio.gather(receiver_task, return_exceptions=True)
        await publisher.disconnect()
        await subscriber.disconnect()
        await source.aclose()


if __name__ == "__main__":
    asyncio.run(main())
