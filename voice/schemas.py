from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class KnowledgeEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=4000)

    @field_validator("title", "content")
    @classmethod
    def meaningful_text(cls, value: str) -> str:
        if not value.strip() or "\x00" in value:
            raise ValueError("Текст должен быть непустым и не содержать двоичных данных.")
        return value.strip()

    @field_validator("title")
    @classmethod
    def one_line(cls, value: str) -> str:
        if "\r" in value or "\n" in value:
            raise ValueError("Заголовок должен занимать одну строку.")
        return value


class KnowledgeRequest(BaseModel):
    knowledge: list[KnowledgeEntry] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique_and_limited(self):
        if len({item.id for item in self.knowledge}) != len(self.knowledge):
            raise ValueError("Идентификаторы материалов должны быть уникальными.")
        if sum(len(item.title) + len(item.content) + 6 for item in self.knowledge) > 180_000:
            raise ValueError("База знаний превышает 180000 символов.")
        return self


class HistoryMessage(BaseModel):
    model_config = ConfigDict(extra="ignore")
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=6000)
    sourceIds: list[str] = Field(default_factory=list, max_length=3)


class AnswerRequest(KnowledgeRequest):
    question: str = Field(min_length=1, max_length=2000)
    history: list[HistoryMessage] = Field(default_factory=list, max_length=20)

    @field_validator("question")
    @classmethod
    def nonempty_question(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Введите вопрос.")
        return value.strip()


class SessionRequest(KnowledgeRequest):
    companyName: str = Field(default="ТехноЛиния", min_length=1, max_length=100)
    language: Literal["ru"] = "ru"


class AnswerReply(BaseModel):
    answer: str
    sources: list[KnowledgeEntry]
    status: Literal["answered", "unknown", "clarification"]
    mode: Literal["llm"] = "llm"
