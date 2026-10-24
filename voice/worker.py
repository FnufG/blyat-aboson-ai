"""LiveKit owns the realtime session, endpointing, echo handling and interruptions."""
import asyncio
import json
import logging
import os
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
        except AnswerUnavailable:
            await self.room.local_participant.publish_data(json.dumps({"error": "The language model is temporarily unavailable."}).encode("utf8"), reliable=True, topic="liniya.error")
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
    session = AgentSession(
        vad=ctx.proc.userdata["vad"],
        stt=FasterWhisperSTT(),
        llm=openai.LLM(base_url=config["base"], api_key=config["key"], model=config["model"]),
        tts=SupportTTS(),
        turn_detection="vad",
        min_endpointing_delay=0.45,
        max_endpointing_delay=2.0,
        allow_interruptions=True,
        min_interruption_duration=0.35,
        resume_false_interruption=True,
    )
    async def cleanup():
        SessionStore().delete(ctx.room.name)
        await session.aclose()

    ctx.add_shutdown_callback(cleanup)
    await session.start(agent=SupportAgent(data, ctx.room), room=ctx.room)


if __name__ == "__main__":
    cli.run_app(server)
