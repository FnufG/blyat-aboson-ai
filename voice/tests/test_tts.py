import asyncio
from io import BytesIO
import math
import struct
import wave
import httpx
import pytest
from livekit.agents.types import APIConnectOptions
from voice import adapters


def wav_bytes():
    file = BytesIO()
    with wave.open(file, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24000)
        audio.writeframes(b"".join(struct.pack("<h", int(2000 * math.sin(2 * math.pi * 440 * i / 24000))) for i in range(4800)))
    return file.getvalue()


def test_boson_adapter_decodes_real_audio_bytes_from_compatible_test_endpoint(monkeypatch):
    """Tests the HTTP/audio contract; this is NOT a call to the real Boson service."""
    monkeypatch.setenv("BOSON_API_KEY", "test-only-placeholder")
    monkeypatch.setenv("BOSON_BASE_URL", "http://127.0.0.1:9999/v1")
    monkeypatch.delenv("BOSON_VOICE", raising=False)
    observed = []
    def provider(request):
        import json
        observed.append(json.loads(request.content))
        assert request.url.path == "/v1/audio/speech"
        return httpx.Response(200, headers={"Content-Type": "audio/wav"}, content=wav_bytes())
    original = httpx.AsyncClient
    monkeypatch.setattr(adapters.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(provider), **kwargs))
    async def consume():
        frames = []
        speech = adapters.SupportTTS()
        async with speech.synthesize("Проверка", conn_options=APIConnectOptions(max_retry=0)) as stream:
            async for audio in stream:
                frames.append(audio.frame)
        await speech.aclose()
        return frames
    frames = asyncio.run(consume())
    assert frames and sum(frame.samples_per_channel for frame in frames) > 1000
    assert all(frame.sample_rate == 24000 for frame in frames)
    assert observed[0]["input"] == "Проверка"
    assert observed[0]["model"] == "higgs-audio-v3-tts"
    assert "voice" not in observed[0]


def test_boson_adapter_rejects_error_instead_of_synthesizing_it(monkeypatch):
    monkeypatch.setenv("BOSON_API_KEY", "test-only-placeholder")
    original = httpx.AsyncClient
    def provider(request):
        return httpx.Response(401, json={"error": "invalid credentials"})
    monkeypatch.setattr(adapters.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(provider), **kwargs))
    async def consume():
        speech = adapters.SupportTTS()
        async with speech.synthesize("Проверка", conn_options=APIConnectOptions(max_retry=0)) as stream:
            return [audio async for audio in stream]
    with pytest.raises(Exception, match="Boson|request|retry"):
        asyncio.run(consume())
