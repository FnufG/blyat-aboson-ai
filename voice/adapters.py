"""Thin LiveKit adapters around maintained local inference and Boson's HTTP API."""
import asyncio
from functools import lru_cache
import os
from pathlib import Path
import shutil
import threading
import uuid
import httpx
import numpy as np
from livekit import rtc
from livekit.agents import stt, tts
from livekit.agents.types import APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS, NOT_GIVEN

STT_LOCK = threading.Lock()


def whisper_path() -> Path:
    return Path(os.environ.get("WHISPER_MODEL_PATH", Path(__file__).resolve().parent.parent / ".local" / "models" / "whisper-base"))


@lru_cache(maxsize=1)
def load_whisper():
    path = whisper_path()
    if not (path / "model.bin").is_file():
        raise RuntimeError("The local speech recognition model is not installed.")
    from faster_whisper import WhisperModel
    return WhisperModel(str(path), device="cpu", compute_type="int8", cpu_threads=2, num_workers=1, local_files_only=True)


class FasterWhisperSTT(stt.STT):
    def __init__(self):
        super().__init__(capabilities=stt.STTCapabilities(streaming=False, interim_results=False))

    async def _recognize_impl(self, buffer, *, language=NOT_GIVEN, conn_options: APIConnectOptions):
        frame = rtc.combine_audio_frames(buffer)
        if frame.duration > 60:
            raise RuntimeError("Your turn is longer than 60 seconds. Please ask a shorter question.")
        # LiveKit already gives PCM. Use its maintained resampler and faster-whisper's
        # supported float32-array input, avoiding an unnecessary WAV/PyAV decode pass.
        if frame.sample_rate != 16000:
            resampler = rtc.AudioResampler(frame.sample_rate, 16000, num_channels=frame.num_channels)
            frame = rtc.combine_audio_frames(resampler.push(frame) + resampler.flush())
        audio = np.frombuffer(frame.data, dtype=np.int16).astype(np.float32)
        if frame.num_channels > 1:
            audio = audio.reshape(-1, frame.num_channels).mean(axis=1)
        audio = audio / 32768.0
        model = await asyncio.to_thread(load_whisper)
        selected_language = language if isinstance(language, str) else "en"

        def transcribe():
            with STT_LOCK:
                # Keep Whisper's supported default beam search; greedy decoding
                # helps preserve key words in real speech checks.
                segments, info = model.transcribe(audio, language=selected_language, beam_size=5, vad_filter=False, condition_on_previous_text=False)
                text = " ".join(segment.text.strip() for segment in segments).strip()
            return text, info.language

        text, detected = await asyncio.to_thread(transcribe)
        return stt.SpeechEvent(type=stt.SpeechEventType.FINAL_TRANSCRIPT, alternatives=[stt.SpeechData(language=detected, text=text)])


def espeak_binary() -> str | None:
    explicit = os.environ.get("ESPEAK_BINARY")
    return explicit if explicit and os.access(explicit, os.X_OK) else (shutil.which("espeak-ng") or shutil.which("espeak"))


def tts_mode() -> str:
    return "boson" if os.environ.get("BOSON_API_KEY") else "local"


class SupportTTS(tts.TTS):
    def __init__(self):
        super().__init__(capabilities=tts.TTSCapabilities(streaming=False), sample_rate=24000, num_channels=1)
        self.mode = tts_mode()

    def synthesize(self, text: str, *, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS):
        return SupportAudioStream(tts=self, input_text=text, conn_options=conn_options)


class SupportAudioStream(tts.ChunkedStream):
    def __init__(self, *, tts: SupportTTS, input_text: str, conn_options: APIConnectOptions):
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self.mode = tts.mode

    async def _run(self, output_emitter: tts.AudioEmitter):
        if self.mode == "boson":
            base = os.environ.get("BOSON_BASE_URL", "https://api.boson.ai/v1").rstrip("/")
            url = httpx.URL(base)
            if url.scheme != "https" and not (url.scheme == "http" and url.host in ("localhost", "127.0.0.1", "::1")):
                raise RuntimeError("Boson requires an HTTPS API address.")
            payload = {"model": os.environ.get("BOSON_MODEL", "higgs-audio-v3-tts"), "input": self.input_text, "response_format": "wav"}
            if os.environ.get("BOSON_VOICE"):
                payload["voice"] = os.environ["BOSON_VOICE"]
            async with httpx.AsyncClient(timeout=httpx.Timeout(35, connect=5), trust_env=True) as client:
                async with client.stream("POST", base + "/audio/speech", headers={"Authorization": "Bearer " + os.environ["BOSON_API_KEY"]}, json=payload) as response:
                    if response.status_code >= 400:
                        raise RuntimeError("Boson rejected the speech request. Check the API key, model and limits.")
                    mime_type = response.headers.get("content-type", "").split(";")[0].lower()
                    if mime_type not in ("audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/flac", "audio/ogg"):
                        raise RuntimeError("Boson returned an unsupported audio format.")
                    output_emitter.initialize(request_id=uuid.uuid4().hex, sample_rate=24000, num_channels=1, mime_type=mime_type)
                    received = 0
                    async for chunk in response.aiter_bytes():
                        received += len(chunk)
                        if received > 10_000_000:
                            raise RuntimeError("The audio response is too large.")
                        output_emitter.push(chunk)
                    output_emitter.flush()
        else:
            binary = espeak_binary()
            if not binary:
                raise RuntimeError("The test voice is not installed. Connect Boson or install eSpeak NG.")
            # No shell is involved; user/model text cannot become executable options.
            process = await asyncio.create_subprocess_exec(binary, "--stdout", "-v", "en-us", "-s", "165", "--", self.input_text, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                stdout, _ = await asyncio.wait_for(process.communicate(), timeout=30)
            except BaseException:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
                raise
            if process.returncode or len(stdout) < 44:
                raise RuntimeError("Could not generate test speech.")
            output_emitter.initialize(request_id=uuid.uuid4().hex, sample_rate=24000, num_channels=1, mime_type="audio/wav")
            output_emitter.push(stdout)
            output_emitter.flush()
