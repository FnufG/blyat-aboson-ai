"""Loopback-only HTTP broker consumed by Next.js, not a public multi-tenant API."""
import asyncio
from functools import lru_cache
import os
from urllib.parse import urlparse
import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from livekit.plugins import silero
from .adapters import espeak_binary, load_whisper, tts_mode
from .answer import AnswerUnavailable, answer_question, model_health
from .schemas import AnswerRequest, SessionRequest
from .store import SessionStore

app = FastAPI(title="Liniya local voice backend", docs_url=None, redoc_url=None)


@lru_cache(maxsize=1)
def store():
    return SessionStore()


@app.exception_handler(RequestValidationError)
async def invalid_request(request: Request, exc: RequestValidationError):
    return JSONResponse({"error": "Некорректный запрос. Проверьте вопрос и базу знаний."}, status_code=422)


@app.exception_handler(AnswerUnavailable)
async def model_failure(request: Request, exc: AnswerUnavailable):
    return JSONResponse({"error": str(exc)}, status_code=503)


@app.middleware("http")
async def input_size(request: Request, call_next):
    # API binds to loopback; Next also enforces streaming byte limits before proxying.
    try:
        length = int(request.headers.get("content-length", "0") or "0")
    except ValueError:
        return JSONResponse({"error": "Некорректный размер запроса."}, status_code=400)
    if length > 1_000_000:
        return JSONResponse({"error": "Слишком большой запрос."}, status_code=413)
    return await call_next(request)


async def probe_url(url: str) -> bool:
    try:
        async with httpx.AsyncClient(timeout=2, trust_env=True) as client:
            return (await client.get(url)).is_success
    except Exception:
        return False


@lru_cache(maxsize=1)
def load_vad():
    return silero.VAD.load(force_cpu=True, max_buffered_speech=60)


async def readiness():
    llm = await model_health()
    try:
        await asyncio.to_thread(load_whisper)
        stt = {"ready": True, "engine": "faster-whisper"}
    except Exception:
        stt = {"ready": False, "engine": "faster-whisper", "reason": "Локальная модель распознавания не установлена или не загрузилась."}
    try:
        await asyncio.to_thread(load_vad)
        vad = {"ready": True, "engine": "silero"}
    except Exception:
        vad = {"ready": False, "engine": "silero", "reason": "Не удалось загрузить определение речи."}
    mode = tts_mode()
    tts = {"ready": mode == "boson" or bool(espeak_binary()), "mode": mode, "bosonVerified": False}
    livekit_url = os.environ.get("LIVEKIT_URL", "ws://127.0.0.1:7880")
    parsed = urlparse(livekit_url)
    http_url = ("https" if parsed.scheme == "wss" else "http") + "://" + parsed.netloc
    livekit = {"ready": await probe_url(http_url)}
    worker = {"ready": await probe_url(os.environ.get("WORKER_HEALTH_URL", "http://127.0.0.1:8081/"))}
    components = {"llm": llm, "stt": stt, "vad": vad, "tts": tts, "livekit": livekit, "worker": worker}
    ready = all(component["ready"] for component in components.values())
    return {"ready": ready, "status": "ready" if ready else "setup_required", "ttsMode": mode, "components": components}


@app.get("/health")
async def health():
    return await readiness()


@app.post("/sessions")
async def create_session(request: SessionRequest):
    status = await readiness()
    if not status["ready"]:
        return JSONResponse({"error": "Голосовой сервис ещё не готов. Проверьте состояние компонентов.", **status}, status_code=503)
    try:
        room = store().create(request)
    except RuntimeError as exc:
        return JSONResponse({"error": str(exc)}, status_code=429)
    return {"roomName": room, "agentName": "liniya-support", "ttsMode": tts_mode()}


@app.delete("/sessions/{room}")
async def remove_session(room: str):
    store().delete(room)
    return {"deleted": True}


@app.post("/answer")
async def answer(request: AnswerRequest):
    return await answer_question(request)
