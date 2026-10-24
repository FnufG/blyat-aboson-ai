"""LiveKit owns the realtime session, endpointing, echo handling and interruptions."""
import asyncio
import json
import logging
import os
import time
from urllib.parse import urlparse
from livekit import rtc
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, AutoSubscribe, cli, llm
from livekit.plugins import openai, silero
from livekit.agents.types import NOT_GIVEN
from .adapters import FasterWhisperSTT, SupportTTS, load_whisper
from .answer import AnswerUnavailable, answer_question, model_config
from .schemas import AnswerRequest, HistoryMessage, SessionRequest
from .store import SessionStore

logger = logging.getLogger("liniya.voice")

ANSWER_ERRORS = {
    "local_model_unavailable": "The local model is not ready. Wait for Qwen to load and try again.",
    "missing_llm_key": "Set LLM_API_KEY in .env.local and restart the application.",
    "invalid_llm_config": "Check the language model URL and model name in .env.local.",
    "provider_auth": "The language model rejected access. Check LLM_API_KEY and model permissions.",
    "provider_quota": "The language model API limit was reached. Check API billing and quota.",
    "provider_timeout": "The language model timed out. Please try again.",
    "provider_unavailable": "The language model is temporarily unavailable. Please try again.",
    "invalid_model_reply": "The model did not return a verified answer with sources. Please rephrase your question.",
    "knowledge_too_large": "The matching instructions are too long. Split them into shorter sections.",
}


async def publish_voice_error(room, *, code: str, stage: str, message: str):
    """Report only fixed public messages, never provider exception text or audio."""
    try:
        await asyncio.wait_for(room.local_participant.publish_data(
            json.dumps({"error": message, "code": code, "stage": stage}).encode("utf8"),
            reliable=True, topic="liniya.error",
        ), timeout=3)
    except Exception:
        # A disconnected data channel must not replace the original error or leak
        # an SDK URL/token through exception formatting.
        logger.warning("Could not deliver voice diagnostic (%s)", code)


class VoiceDiagnostics:
    """Forward SDK speech failures to the UI, including failure of the greeting."""
    def __init__(self, session, room, *, voice_provider: str):
        self.room = room
        self.voice_provider = voice_provider
        self.pending: set[asyncio.Task] = set()
        self.last_sent: dict[str, float] = {}
        session.on("error", self.on_error)
        session.on("user_transcription_timeout", self.on_transcription_timeout)

    def queue(self, *, code: str, stage: str, message: str):
        now = time.monotonic()
        if now - self.last_sent.get(code, float("-inf")) < 3:
            return
        self.last_sent[code] = now
        task = asyncio.create_task(publish_voice_error(self.room, code=code, stage=stage, message=message))
        self.pending.add(task)
        task.add_done_callback(self.pending.discard)

    def on_error(self, event):
        kind = getattr(getattr(event, "error", None), "type", None)
        if kind == "stt_error":
            self.queue(code="speech_recognition_failed", stage="speech_recognition", message="Speech recognition failed. Check the speech service and try a short question in English.")
        elif kind == "tts_error":
            message = "Boson could not produce speech. Check BOSON_API_KEY, the selected voice/model and API access." if self.voice_provider == "boson" else "The test voice could not produce audio. Check the speech service logs."
            self.queue(code="speech_output_failed", stage="speech_output", message=message)
        elif kind in ("llm_error", "realtime_model_error"):
            self.queue(code="provider_unavailable", stage="answer_generation", message=ANSWER_ERRORS["provider_unavailable"])

    def on_transcription_timeout(self, event):
        self.queue(code="speech_not_transcribed", stage="speech_recognition", message="Speech was detected, but no transcript was received. Check your microphone and try a short question in English.")

    async def aclose(self):
        tasks = list(self.pending)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


class SupportAgent(Agent):
    def __init__(self, data: SessionRequest, room: rtc.Room):
        super().__init__(instructions="You are an English-speaking support assistant. Answer briefly using only the company knowledge base.")
        self.data = data
        self.room = room
        self.last_sources: list[str] = []

    async def on_enter(self):
        await self.session.say(f"Hello! I am the automated support assistant for {self.data.companyName}. How can I help?", allow_interruptions=True)

    async def llm_node(self, chat_ctx: llm.ChatContext, tools, model_settings):
        messages = [item for item in chat_ctx.items if isinstance(item, llm.ChatMessage) and item.role in ("user", "assistant") and item.text_content]
        if not messages or messages[-1].role != "user":
            return
        history = [HistoryMessage(role=item.role, content=item.text_content[:6000]) for item in messages[:-1][-20:]]
        previous = next((item for item in reversed(history) if item.role == "assistant"), None)
        if previous:
            previous.sourceIds = self.last_sources
        try:
            reply = await answer_question(AnswerRequest(question=messages[-1].text_content[:2000], history=history, knowledge=self.data.knowledge))
            self.last_sources = [item.id for item in reply.sources]
            await self.room.local_participant.publish_data(json.dumps({"sources": [source.model_dump() for source in reply.sources], "status": reply.status}, ensure_ascii=False).encode("utf8"), reliable=True, topic="liniya.sources")
            yield reply.answer
        except AnswerUnavailable as error:
            code = error.code if error.code in ANSWER_ERRORS else "provider_unavailable"
            await publish_voice_error(self.room, code=code, stage="answer_generation", message=ANSWER_ERRORS[code])
            yield "I could not prepare a verified answer right now. Please try asking your question again."


def prewarm(process):
    process.userdata["vad"] = silero.VAD.load(force_cpu=True, max_buffered_speech=60)
    process.userdata["whisper"] = load_whisper()


livekit_url = os.environ.get("LIVEKIT_URL", "ws://127.0.0.1:7880")
loopback_livekit = urlparse(livekit_url).hostname in ("localhost", "127.0.0.1", "::1")
server = AgentServer(
    ws_url=livekit_url,
    http_proxy=None if loopback_livekit else NOT_GIVEN,
    api_key=os.environ.get("LIVEKIT_API_KEY", "devkey"),
    api_secret=os.environ.get("LIVEKIT_API_SECRET", "secret"),
    host="127.0.0.1", port=8081,
    setup_fnc=prewarm,
    initialize_process_timeout=60,
    num_idle_processes=1,
    job_memory_warn_mb=2000,
)


@server.rtc_session(agent_name="liniya-support")
async def entrypoint(ctx: JobContext):
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    data = SessionStore().get(ctx.room.name)
    if data is None:
        logger.warning("Rejected room without a live local session")
        await ctx.room.disconnect()
        return
    try:
        await asyncio.wait_for(ctx.wait_for_participant(), timeout=30)
    except TimeoutError:
        SessionStore().delete(ctx.room.name)
        await ctx.room.disconnect()
        return
    except RuntimeError as error:
        if ctx.room.isconnected() or str(error) != "room disconnected while waiting for participant":
            raise
        SessionStore().delete(ctx.room.name)
        return
    config = model_config()
    speech = SupportTTS()
    session = AgentSession(
        vad=ctx.proc.userdata["vad"],
        stt=FasterWhisperSTT(),
        llm=openai.LLM(base_url=config["base"], api_key=config["key"], model=config["model"]),
        tts=speech,
        turn_detection="vad",
        min_endpointing_delay=0.45,
        max_endpointing_delay=2.0,
        allow_interruptions=True,
        min_interruption_duration=0.35,
        resume_false_interruption=True,
        transcription_timeout=8.0,
    )
    diagnostics = VoiceDiagnostics(session, ctx.room, voice_provider=speech.mode)
    async def cleanup():
        SessionStore().delete(ctx.room.name)
        await diagnostics.aclose()
        await session.aclose()

    ctx.add_shutdown_callback(cleanup)
    await session.start(agent=SupportAgent(data, ctx.room), room=ctx.room)


if __name__ == "__main__":
    cli.run_app(server)
