"""Short-lived session knowledge. Shared by API and LiveKit worker, never put in JWTs."""
import json
import os
from pathlib import Path
import secrets
import sqlite3
import time
from .schemas import SessionRequest

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PATH = ROOT / ".local" / "voice-sessions.sqlite3"
SESSION_TTL = 3600


class SessionStore:
    def __init__(self, path: str | Path | None = None):
        self.path = Path(path or os.environ.get("VOICE_SESSION_DB", DEFAULT_PATH))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS sessions (room TEXT PRIMARY KEY, data TEXT NOT NULL, expires REAL NOT NULL)")
        self.path.chmod(0o600)

    def connect(self):
        return sqlite3.connect(self.path, timeout=10)

    def create(self, request: SessionRequest) -> str:
        room = "liniya-" + secrets.token_urlsafe(24)
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE expires < ?", (time.time(),))
            if db.execute("SELECT count(*) FROM sessions").fetchone()[0] >= 100:
                raise RuntimeError("Слишком много активных разговоров. Завершите старые сессии.")
            db.execute("INSERT INTO sessions VALUES (?, ?, ?)", (room, request.model_dump_json(), time.time() + SESSION_TTL))
        return room

    def get(self, room: str) -> SessionRequest | None:
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE expires < ?", (time.time(),))
            record = db.execute("SELECT data FROM sessions WHERE room = ? AND expires > ?", (room, time.time())).fetchone()
        return SessionRequest.model_validate_json(record[0]) if record else None

    def delete(self, room: str) -> None:
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE room = ?", (room,))
