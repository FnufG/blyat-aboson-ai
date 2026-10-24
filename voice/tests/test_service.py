"""English knowledge retrieval and the shared cloud answer API contract.

All HTTP provider responses in this file are mocks. These tests never use a real
account key or call a paid model.
"""
import asyncio
import json
import time

import httpx
import pytest

from voice import answer as answers
from voice.schemas import AnswerRequest, KnowledgeEntry, SessionRequest, HistoryMessage
from voice.store import SessionStore


@pytest.fixture(autouse=True)
def cloud_environment(monkeypatch):
    monkeypatch.setenv("LLM_BACKEND", "cloud")
    monkeypatch.setenv("LLM_API_KEY", "test-only-placeholder")
    monkeypatch.setenv("LLM_BASE_URL", "https://api.openai.com/v1")
    monkeypatch.setenv("LLM_MODEL", "gpt-4.1-mini")


def materials():
    """Test-only company data; never ships as the application's initial knowledge."""
    return [
        KnowledgeEntry(id="faq-3", title="How can I contact support?", content="Contact support at help@example.invalid. Support hours are 09:00 to 18:00 Monday to Friday."),
        KnowledgeEntry(id="faq-4", title="What are the warranty terms?", content="The TL-100 router warranty lasts 12 months from purchase. Keep your purchase receipt to request warranty service."),
        KnowledgeEntry(id="faq-7", title="A red indicator is flashing on the router", content="A flashing red indicator means the router has not connected to the provider. Check the WAN cable, then restart the router."),
        KnowledgeEntry(id="faq-12", title="How do I restart the TL-100 router?", content="To restart the TL-100 router, disconnect its power for 30 seconds, reconnect it and wait two minutes."),
    ]


def question(text="What are the warranty terms?", **kwargs):
    return AnswerRequest(question=text, knowledge=kwargs.pop("knowledge", materials()), **kwargs)


def mock_cloud(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(answers.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))


def completion(answer="The warranty lasts 12 months.", ids=None, status="answered"):
    return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"status": status, "answer": answer, "sourceIds": ["faq-4"] if ids is None else ids})}}]})


@pytest.mark.parametrize("text,source", [
    ("A red indicator is flashing on the router", "faq-7"),
    ("What are the warranty terms?", "faq-4"),
    ("How can I contact support?", "faq-3"),
    ("How do I restart the TL-100 router?", "faq-12"),
])
def test_ready_made_retriever_selects_relevant_english_source(text, source):
    matches = answers.retrieve(question(text))
    assert matches
    assert matches[0].id == source


@pytest.mark.parametrize("text,title,content", [
    ("What is the guarantee?", "Warranty", "Our warranty lasts 12 months."),
    ("What is the warranty?", "Guarantee", "Our guarantee lasts 12 months."),
    ("How can I get in touch?", "Contact", "Contact us at help@example.invalid."),
    ("How can I contact you?", "Get in touch", "Get in touch at help@example.invalid."),
])
def test_synonyms_match_real_bm25_and_preserve_original_source(text, title, content):
    entry = KnowledgeEntry(id="company-info", title=title, content=content)
    # An unrelated entry prevents a false pass based on simply returning the only document.
    unrelated = KnowledgeEntry(id="hours", title="Opening hours", content="Our office opens at 09:00.")
    matches = answers.retrieve(question(text, knowledge=[unrelated, entry]))
    assert matches and matches[0] == entry
    assert matches[0].title == title and matches[0].content == content


@pytest.mark.parametrize("text", ["What is the weather tomorrow?", "How do I configure a TL-999 router?", "What is the warranty for a car?", "What is the price of TL-100?"])
def test_unsupported_questions_abstain(text):
    assert answers.retrieve(question(text)) == []


def test_followup_and_topic_changes():
    history = [HistoryMessage(role="assistant", content="Check the WAN cable.", sourceIds=["faq-7"])]
    followup = answers.retrieve(question("What if that did not help?", history=history))
    assert followup[0].id == "faq-7"
    different = answers.retrieve(question("Tell me more about the warranty terms", history=history))
    assert different[0].id == "faq-4"
    assert answers.retrieve(question("What if that did not help on TL-999?", history=history)) == []


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


def test_unknown_answer_does_not_call_provider(monkeypatch):
    monkeypatch.setattr(answers.httpx, "AsyncClient", lambda **kwargs: pytest.fail("Unsupported knowledge must abstain before HTTP"))
    reply = asyncio.run(answers.answer_question(question("What is the weather tomorrow?")))
    assert reply.status == "unknown"
    assert reply.sources == []
    assert reply.answer == answers.UNKNOWN


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


def test_cloud_key_is_required_without_silent_local_fallback(monkeypatch):
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.setattr(answers.httpx, "AsyncClient", lambda **kwargs: pytest.fail("No HTTP without a cloud key"))
    cfg = answers.model_config()
    assert cfg["base"] == "https://api.openai.com/v1"
    assert cfg["key"] == ""
    health = asyncio.run(answers.model_health())
    assert health["ready"] is False
    assert "LLM_API_KEY" in health["reason"]
    with pytest.raises(answers.AnswerUnavailable, match="LLM_API_KEY"):
        asyncio.run(answers.answer_question(question()))


def test_cloud_model_health_checks_selected_model(monkeypatch):
    requests = []
    def provider(request):
        requests.append(request)
        return httpx.Response(200, json={"data": [{"id": "gpt-4.1-mini"}]})
    mock_cloud(monkeypatch, provider)
    result = asyncio.run(answers.model_health())
    assert result["ready"] is True
    assert result["model"] == "gpt-4.1-mini"
    assert requests[0].headers["Authorization"] == "Bearer test-only-placeholder"


def test_cloud_answer_uses_configured_provider_and_cited_english_knowledge(monkeypatch):
    captured = []
    def provider(request):
        captured.append(request)
        return completion()
    mock_cloud(monkeypatch, provider)
    result = asyncio.run(answers.answer_question(question()))
    request = captured[0]
    assert request.url == "https://api.openai.com/v1/chat/completions"
    assert request.headers["Authorization"] == "Bearer test-only-placeholder"
    payload = json.loads(request.content)
    assert payload["model"] == "gpt-4.1-mini"
    assert "English" in payload["messages"][0]["content"]
    assert payload["messages"][-1]["content"] == "What are the warranty terms?"
    fmt = payload["response_format"]
    assert fmt["type"] == "json_schema"
    assert fmt["json_schema"]["strict"] is True
    assert "faq-4" in fmt["json_schema"]["schema"]["properties"]["sourceIds"]["items"]["enum"]
    assert result.answer == "The warranty lasts 12 months."
    assert result.mode == "llm"
    assert [s.id for s in result.sources] == ["faq-4"]


@pytest.mark.parametrize("status,pattern", [(401, "key|access|auth"), (403, "key|access|auth"), (429, "limit|billing|quota"), (500, "model|provider|service")])
def test_cloud_errors_are_actionable_and_do_not_echo_credentials(monkeypatch, status, pattern):
    mock_cloud(monkeypatch, lambda request: httpx.Response(status, json={"error": "private-provider-diagnostic test-only-placeholder"}))
    with pytest.raises(answers.AnswerUnavailable, match=pattern) as error:
        asyncio.run(answers.answer_question(question()))
    assert "private-provider-diagnostic" not in str(error.value)
    assert "test-only-placeholder" not in str(error.value)


def test_cloud_timeout_is_sanitized(monkeypatch):
    def provider(request):
        raise httpx.ReadTimeout("private-provider-diagnostic", request=request)
    mock_cloud(monkeypatch, provider)
    with pytest.raises(answers.AnswerUnavailable) as error:
        asyncio.run(answers.answer_question(question()))
    assert "private-provider-diagnostic" not in str(error.value)


@pytest.mark.parametrize("ids", [["invented-source"], []])
def test_cloud_answer_rejects_missing_or_unknown_citations(monkeypatch, ids):
    mock_cloud(monkeypatch, lambda request: completion(ids=ids))
    with pytest.raises(answers.AnswerUnavailable):
        asyncio.run(answers.answer_question(question()))


def test_cloud_unknown_response_cannot_expose_an_unsupported_guess(monkeypatch):
    mock_cloud(monkeypatch, lambda request: completion(answer="Maybe it lasts forever.", ids=[], status="unknown"))
    result = asyncio.run(answers.answer_question(question()))
    assert result.answer == answers.UNKNOWN
    assert result.sources == []
    assert result.status == "unknown"


def test_model_payload_uses_bounded_complete_sources(monkeypatch):
    huge = [KnowledgeEntry(id=f"large-{i}", title="Warranty terms", content="Warranty terms " + "A" * 3800) for i in range(3)]
    request = question(knowledge=huge, history=[HistoryMessage(role="user", content="I" * 3000), HistoryMessage(role="assistant", content="D" * 3900)])
    captured = []
    monkeypatch.setattr(answers, "retrieve", lambda request: huge)
    def model(request):
        body = json.loads(request.content)
        captured.append(body)
        return completion(answer="Read the full warranty instruction.", ids=["large-0"])
    mock_cloud(monkeypatch, model)
    result = asyncio.run(answers.answer_question(request))
    assert result.status == "answered"
    system = captured[0]["messages"][0]["content"]
    assert "large-0" in system and "large-1" not in system and "large-2" not in system
    assert "A" * 3800 in system
    assert sum(len(message["content"]) for message in captured[0]["messages"]) < 14000
    assert len(captured[0]["messages"]) == 3
