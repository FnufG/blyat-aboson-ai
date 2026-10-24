"""PCM contract checks at the LiveKit/faster-whisper boundary."""
import asyncio
from types import SimpleNamespace

from livekit import rtc
from livekit.agents.types import APIConnectOptions
import numpy as np
import pytest

from voice import adapters


def recognize(frame):
    async def run():
        engine = adapters.FasterWhisperSTT()
        try:
            return await engine.recognize(frame, conn_options=APIConnectOptions(max_retry=0))
        finally:
            await engine.aclose()
    return asyncio.run(run())


def test_stt_resamples_and_downmixes_pcm_for_supported_whisper_array_input(monkeypatch):
    """A decoder regression must not change channel layout, duration or loudness."""
    sample_rate = 48000
    time = np.arange(sample_rate // 5, dtype=np.float64) / sample_rate
    left = np.sin(2 * np.pi * 440 * time) * 16000
    right = np.sin(2 * np.pi * 440 * time) * 8000
    stereo = np.column_stack([left, right]).astype(np.int16)
    observed = []

    class Model:
        def transcribe(self, audio, **options):
            observed.append((audio, options))
            return iter([SimpleNamespace(text=" Speech check ")]), SimpleNamespace(language="en")

    monkeypatch.setattr(adapters, "load_whisper", lambda: Model())
    frame = rtc.AudioFrame(stereo.tobytes(), sample_rate, 2, len(time))
    event = recognize(frame)
    audio, options = observed[0]
    assert audio.dtype == np.float32 and audio.ndim == 1
    assert abs(len(audio) - 3200) <= 1
    assert np.isfinite(audio).all() and np.max(np.abs(audio)) <= 1
    expected_rms = (12000 / 32768) / np.sqrt(2)
    assert np.sqrt(np.mean(audio[100:-100] ** 2)) == pytest.approx(expected_rms, rel=0.03)
    assert options["language"] == "en"
    assert options["condition_on_previous_text"] is False
    assert event.alternatives[0].text == "Speech check"


def test_stt_rejects_overlong_pcm_before_loading_model(monkeypatch):
    def unexpected_load():
        raise AssertionError("An overlong turn must be rejected before inference")
    monkeypatch.setattr(adapters, "load_whisper", unexpected_load)
    audio = np.zeros(16000 * 61, dtype=np.int16)
    with pytest.raises(Exception, match="60|retry|request"):
        recognize(rtc.AudioFrame(audio.tobytes(), 16000, 1, len(audio)))
