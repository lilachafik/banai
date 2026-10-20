"""The LLM boundary. The orchestrator depends on the `Llm` protocol, so tests inject a fake."""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from typing import Protocol

from openai import OpenAI

from app.config import OPENAI_MAX_RETRIES, OPENAI_TIMEOUT_SECONDS


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: str  # raw JSON text from the model; untrusted


@dataclass(frozen=True)
class LlmReply:
    content: str | None
    tool_calls: list[ToolCall] = field(default_factory=list)


class Llm(Protocol):
    def __call__(self, messages: list[dict], tools: list[dict]) -> LlmReply: ...


class AgentUnavailable(Exception):
    """The LLM provider failed (network, auth, rate limit, timeout). Never carries secrets."""


class OpenAiLlm:
    def __init__(self, api_key: str, model: str) -> None:
        self._client = OpenAI(api_key=api_key, timeout=OPENAI_TIMEOUT_SECONDS, max_retries=OPENAI_MAX_RETRIES)
        self._model = model

    def __call__(self, messages: list[dict], tools: list[dict]) -> LlmReply:
        try:
            response = self._client.chat.completions.create(
                model=self._model, messages=messages, tools=tools, parallel_tool_calls=True,
            )
        except Exception as error:  # every provider failure maps to one generic error
            raise AgentUnavailable(type(error).__name__) from None
        message = response.choices[0].message
        calls = [ToolCall(c.id, c.function.name, c.function.arguments)
                 for c in (message.tool_calls or []) if getattr(c, "function", None)]
        return LlmReply(content=message.content, tool_calls=calls)

    def close(self) -> None:
        self._client.close()


@lru_cache(maxsize=4)
def shared_llm(api_key: str, model: str) -> OpenAiLlm:
    """One client (and HTTP connection pool) per key/model for the lifetime of the process."""
    return OpenAiLlm(api_key, model)


class Transcriber(Protocol):
    def __call__(self, audio: bytes, mime: str) -> str: ...


_EXTENSIONS = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav"}


class OpenAiTranscriber:
    """Speech-to-text for chat dictation (Phase 5b). Audio is sent to OpenAI and never stored."""

    def __init__(self, api_key: str, model: str) -> None:
        self._client = OpenAI(api_key=api_key, timeout=OPENAI_TIMEOUT_SECONDS, max_retries=OPENAI_MAX_RETRIES)
        self._model = model

    def __call__(self, audio: bytes, mime: str) -> str:
        try:
            result = self._client.audio.transcriptions.create(
                model=self._model, file=(f"speech.{_EXTENSIONS[mime]}", audio, mime),
            )
        except Exception as error:  # every provider failure maps to one generic error
            raise AgentUnavailable(type(error).__name__) from None
        return result.text or ""

    def close(self) -> None:
        self._client.close()


@lru_cache(maxsize=4)
def shared_transcriber(api_key: str, model: str) -> OpenAiTranscriber:
    return OpenAiTranscriber(api_key, model)
