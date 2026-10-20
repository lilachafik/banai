"""Fixtures for the agent: a scripted fake LLM and a test client that never reaches OpenAI."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.agent.llm import LlmReply, ToolCall
from app.api.chat import get_llm
from app.api.limits import limiter
from app.config import Settings, get_settings
from app.domain.catalog import load_catalog
from app.domain.defaults import basic_wardrobe
from app.main import app

SIGNING_KEY = "test-signing-key-0123456789abcdef0123456789"


def call(name: str, call_id: str = "c1", **args) -> ToolCall:
    return ToolCall(id=call_id, name=name, arguments=json.dumps(args))


class FakeLlm:
    """Returns scripted replies in order and records every conversation it was sent."""

    def __init__(self, *replies: LlmReply | Exception) -> None:
        self.replies = list(replies)
        self.calls: list[list[dict]] = []

    def __call__(self, messages: list[dict], tools: list[dict]) -> LlmReply:
        self.calls.append(messages)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def make_settings(**overrides) -> Settings:
    values = {"openai_api_key": "sk-test", "openai_chat_model": "test-model",
              "proposal_signing_key": SIGNING_KEY, **overrides}
    return Settings(_env_file=None, **values)


@pytest.fixture
def catalog() -> dict:
    return load_catalog()


@pytest.fixture
def design() -> dict:
    return basic_wardrobe()


@pytest.fixture
def api():
    """A client whose settings and LLM are test doubles. Use `api.llm = FakeLlm(...)`."""
    limiter.enabled = False

    class Api(TestClient):
        llm: FakeLlm | None = None
        settings: Settings = make_settings()

    client = Api(app)
    app.dependency_overrides[get_settings] = lambda: client.settings
    app.dependency_overrides[get_llm] = lambda: _require(client.llm)
    yield client
    app.dependency_overrides.clear()
    limiter.enabled = True


def _require(llm: FakeLlm | None) -> FakeLlm:
    assert llm is not None, "set api.llm before calling /api/chat"
    return llm
