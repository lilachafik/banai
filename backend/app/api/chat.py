"""POST /api/chat: one agent turn -> reply + optional signed proposal. Never commits anything."""

from __future__ import annotations

import time
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.agent.llm import AgentUnavailable, Llm, shared_llm
from app.agent.orchestrator import run_turn
from app.api.errors import ApiError
from app.api.limits import chat_rate_limit, limiter
from app.config import PROPOSAL_TTL_SECONDS, Settings, get_settings
from app.domain.apply import apply_ops
from app.domain.catalog import load_catalog
from app.domain.errors import DomainError
from app.services.signing import design_hash, sign

router = APIRouter(prefix="/api")

MAX_MESSAGES = 30
MAX_MESSAGE_CHARS = 2000
MAX_REVISION = 1_000_000_000


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    content: Annotated[str, Field(min_length=1, max_length=MAX_MESSAGE_CHARS)]


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    messages: Annotated[list[ChatMessage], Field(min_length=1, max_length=MAX_MESSAGES)]
    design: dict
    revision: Annotated[int, Field(ge=1, le=MAX_REVISION)]

    @field_validator("messages")
    @classmethod
    def _last_from_user(cls, messages: list[ChatMessage]) -> list[ChatMessage]:
        if messages[-1].role != "user":
            raise ValueError("the last message must come from the user")
        return messages


def get_llm(settings: Annotated[Settings, Depends(get_settings)]) -> Llm:
    if not settings.agent_configured:
        raise ApiError(503, "AGENT_UNAVAILABLE", "The AI designer is not configured on this server.")
    return shared_llm(settings.openai_api_key, settings.openai_chat_model)


def validated_design(design: dict, catalog: dict) -> dict:
    try:
        return apply_ops(design, [], catalog)  # parse + full validation, no changes
    except DomainError as error:
        raise ApiError(422, "INVALID_DESIGN", "The design is invalid.", {"domain": error.to_dict()}) from None


@router.post("/chat")
@limiter.limit(chat_rate_limit)
def chat(
    request: Request,  # required by the rate limiter
    body: ChatRequest,
    settings: Annotated[Settings, Depends(get_settings)],
    llm: Annotated[Llm, Depends(get_llm)],
) -> dict:
    catalog = load_catalog()
    design = validated_design(body.design, catalog)
    messages = [m.model_dump() for m in body.messages]
    try:
        turn = run_turn(messages, design, catalog, llm)
    except AgentUnavailable:
        raise ApiError(502, "AGENT_ERROR", "The AI designer is unavailable right now. Please try again.") from None
    proposal = None
    if turn.ops:
        unsigned = {
            "proposalId": uuid.uuid4().hex,
            "baseRevision": body.revision,
            "baseHash": design_hash(design),
            "expiresAt": int(time.time()) + PROPOSAL_TTL_SECONDS,
            "ops": turn.ops,
            "summary": turn.summary,
        }
        proposal = {**unsigned, "signature": sign(unsigned, settings.proposal_signing_key)}
    return {"success": True, "data": {"reply": turn.reply, "proposal": proposal}}
