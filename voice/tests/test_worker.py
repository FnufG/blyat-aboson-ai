import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from voice import worker
from voice.schemas import KnowledgeEntry, SessionRequest
from voice.store import SessionStore


def session_store(monkeypatch, tmp_path):
    path = tmp_path / "sessions.sqlite3"
    monkeypatch.setenv("VOICE_SESSION_DB", str(path))
    store = SessionStore(path)
    request = SessionRequest(knowledge=[KnowledgeEntry(id="faq", title="Question", content="Answer")])
    return store, request


def context(room_name, error, *, connected=False):
    return SimpleNamespace(
        room=SimpleNamespace(name=room_name, isconnected=lambda: connected, disconnect=AsyncMock()),
        connect=AsyncMock(),
        wait_for_participant=AsyncMock(side_effect=error),
    )


def test_disconnect_while_waiting_removes_only_its_session(monkeypatch, tmp_path):
    store, request = session_store(monkeypatch, tmp_path)
    abandoned = store.create(request)
    other = store.create(request)
    ctx = context(abandoned, RuntimeError("room disconnected while waiting for participant"))

    asyncio.run(worker.entrypoint(ctx))

    assert store.get(abandoned) is None
    assert store.get(other) is not None
    ctx.room.disconnect.assert_not_awaited()


@pytest.mark.parametrize("connected", [True, False])
def test_unrelated_wait_error_propagates(monkeypatch, tmp_path, connected):
    store, request = session_store(monkeypatch, tmp_path)
    room_name = store.create(request)
    error = RuntimeError("unexpected SDK failure")
    ctx = context(room_name, error, connected=connected)

    with pytest.raises(RuntimeError) as raised:
        asyncio.run(worker.entrypoint(ctx))

    assert raised.value is error
    assert store.get(room_name) is not None
    ctx.room.disconnect.assert_not_awaited()
