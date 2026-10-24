import asyncio
import json
from pathlib import Path
import time
import pytest
from voice import answer as answers
from voice.schemas import AnswerRequest, KnowledgeEntry, SessionRequest, HistoryMessage
from voice.store import SessionStore


def demo():
    content = (Path(__file__).resolve().parents[2] / "public" / "demo-faq.md").read_text()
    entries = []
    for section in content.split("## "):
        if not section.strip():
            continue
        title, body = section.strip().split("\n", 1)
        entries.append(KnowledgeEntry(id=f"faq-{len(entries)+1}", title=title, content=body.strip()))
    return entries


@pytest.mark.parametrize("question,source", [
    ("На роутере мигает красный индикатор", "faq-7"),
    ("Какие условия гарантии?", "faq-4"),
    ("Как связаться с поддержкой?", "faq-3"),
    ("Как правильно перезагрузить роутер TL-100?", "faq-12"),
])
def test_ready_made_retriever_selects_relevant_source(question, source):
    matches = answers.retrieve(AnswerRequest(question=question, knowledge=demo()))
    assert matches
    assert matches[0].id == source


@pytest.mark.parametrize("question", ["Какая погода завтра?", "Как настроить роутер TL-999?", "Какая гарантия на автомобиль?", "Сколько стоит роутер TL-100?"])
def test_unsupported_questions_abstain(question):
    assert answers.retrieve(AnswerRequest(question=question, knowledge=demo())) == []


def test_followup_and_topic_changes():
    history = [HistoryMessage(role="assistant", content="Проверьте WAN.", sourceIds=["faq-7"])]
    followup = answers.retrieve(AnswerRequest(question="А если это не помогло?", knowledge=demo(), history=history))
    assert followup[0].id == "faq-7"
    different = answers.retrieve(AnswerRequest(question="Расскажите подробнее об условиях гарантии", knowledge=demo(), history=history))
    assert different[0].id == "faq-4"
    unsupported = answers.retrieve(AnswerRequest(question="А если это не помогло на TL-999?", knowledge=demo(), history=history))
    assert unsupported == []


def test_sessions_are_isolated_and_expired(tmp_path):
    store = SessionStore(tmp_path / "sessions.sqlite3")
    a = store.create(SessionRequest(knowledge=[KnowledgeEntry(id="a", title="A", content="Only A")]))
    b = store.create(SessionRequest(knowledge=[KnowledgeEntry(id="b", title="B", content="Only B")]))
    assert a != b
    assert store.get(a).knowledge[0].content == "Only A"
    assert store.get(b).knowledge[0].content == "Only B"
    assert store.get("liniya-unknown") is None
    with store.connect() as db:
        db.execute("UPDATE sessions SET expires = ? WHERE room = ?", (time.time() - 1, a))
    assert store.get(a) is None
    assert store.get(b)
    store.delete(b)
    assert store.get(b) is None


def test_session_schema_rejects_duplicate_and_empty_materials():
    item = {"id": "one", "title": "Question", "content": "Answer"}
    with pytest.raises(ValueError):
        SessionRequest(knowledge=[item, item])
    with pytest.raises(ValueError):
        SessionRequest(knowledge=[])


def test_unknown_answer_does_not_invent_model_response():
    reply = asyncio.run(answers.answer_question(AnswerRequest(question="Какая погода завтра?", knowledge=demo())))
    assert reply.status == "unknown"
    assert reply.sources == []


def test_health_reports_unavailable_models(monkeypatch):
    import voice.api as api
    async def no_model():
        return {"ready": False, "model": "unavailable"}
    async def unreachable(url):
        return False
    def missing():
        raise RuntimeError("not installed")
    monkeypatch.setattr(api, "model_health", no_model)
    monkeypatch.setattr(api, "probe_url", unreachable)
    monkeypatch.setattr(api, "load_whisper", missing)
    monkeypatch.setattr(api, "load_vad", missing)
    monkeypatch.setattr(api, "espeak_binary", lambda: None)
    monkeypatch.setattr(api, "tts_mode", lambda: "local")
    state = asyncio.run(api.readiness())
    assert state["ready"] is False
    assert state["status"] == "setup_required"
    assert all(not item["ready"] for item in state["components"].values())


def test_model_payload_uses_bounded_complete_sources(monkeypatch):
    import httpx
    huge = [KnowledgeEntry(id=f"large-{i}", title="Условия гарантии", content="Условия гарантии " + "А" * 3800) for i in range(3)]
    request = AnswerRequest(question="Условия гарантии?", knowledge=huge, history=[HistoryMessage(role="user", content="И" * 3000), HistoryMessage(role="assistant", content="Д" * 3900)])
    captured = []
    monkeypatch.setattr(answers, "retrieve", lambda request: huge)
    original = httpx.AsyncClient
    def model(request):
        body = json.loads(request.content)
        captured.append(body)
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"status": "answered", "answer": "Условия указаны в инструкции.", "sourceIds": ["large-0"]})}}]})
    monkeypatch.setattr(answers.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(model), **kwargs))
    result = asyncio.run(answers.answer_question(request))
    assert result.status == "answered"
    system = captured[0]["messages"][0]["content"]
    assert "large-0" in system and "large-1" not in system and "large-2" not in system
    assert "А" * 3800 in system
    assert sum(len(message["content"]) for message in captured[0]["messages"]) < 14000
    assert len(captured[0]["messages"]) == 3
