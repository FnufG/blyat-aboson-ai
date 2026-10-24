"""Real synthetic Russian test input, using the pinned CC0 Piper Denis voice.

This is a test fixture generator, not the application's TTS provider. It never
supplies a transcript to STT: callers receive actual 24 kHz mono PCM frames.
"""
import argparse
import asyncio
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import threading
import wave

from livekit import rtc

ROOT = Path(__file__).resolve().parent.parent
VOICE_DIR = ROOT / ".local" / "models" / "piper-test"
VOICE_NAME = "ru_RU-denis-medium"
VOICE_SHA256 = "15fab56e11a097858ee115545d0f697fc2a316c41a291a5362349fb870411b0a"
CONFIG_SHA256 = "831c860dac0b5073eaa81610a0a638ec23d90a6cf8e5f871b4485c2cec3767c8"
VOICE_LOCK = threading.Lock()


@lru_cache(maxsize=1)
def _voice():
    import onnxruntime
    from piper import PiperVoice
    from piper.config import PiperConfig

    model = VOICE_DIR / f"{VOICE_NAME}.onnx"
    config = VOICE_DIR / f"{VOICE_NAME}.onnx.json"
    for path, expected in ((model, VOICE_SHA256), (config, CONFIG_SHA256)):
        if not path.is_file():
            raise RuntimeError("The synthetic test voice is not installed. Install the optional Piper fixture first.")
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise RuntimeError("The test voice checksum does not match. Reinstall the model.")
    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    # Piper's public constructor accepts a maintained ORT session, allowing the
    # fixture to respect CPU limits even when the host exposes many more cores.
    return PiperVoice(
        session=onnxruntime.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"]),
        config=PiperConfig.from_dict(json.loads(config.read_text(encoding="utf8"))),
    )


def _synthesize(text: str) -> list[rtc.AudioFrame]:
    if not text.strip():
        raise ValueError("The synthetic test question is empty.")
    with VOICE_LOCK:
        voice = _voice()
        frames = []
        for chunk in voice.synthesize(text):
            frame = rtc.AudioFrame(
                chunk.audio_int16_bytes, chunk.sample_rate, chunk.sample_channels,
                len(chunk.audio_int16_array) // chunk.sample_channels,
            )
            resampler = rtc.AudioResampler(frame.sample_rate, 24000, num_channels=frame.num_channels)
            frames.extend(resampler.push(frame) + resampler.flush())
    if not frames:
        raise RuntimeError("Piper did not generate synthetic test speech.")
    return frames


async def speech_frames(text: str) -> list[rtc.AudioFrame]:
    """Generate genuine synthetic audio to exercise real STT and RTC transport."""
    return await asyncio.to_thread(_synthesize, text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--text", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    frames = asyncio.run(speech_frames(args.text))
    with wave.open(str(args.output), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(24000)
        output.writeframes(b"".join(bytes(frame.data) for frame in frames))
    print(json.dumps({"synthetic_input": "piper/" + VOICE_NAME, "output": str(args.output), "seconds": round(sum(frame.duration for frame in frames), 2)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
