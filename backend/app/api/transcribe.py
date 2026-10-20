"""POST /api/transcribe: dictation for the chat input (Phase 5b, scope change 2026-10-20).

The body is the raw recording (no multipart). The text goes back to the browser, which puts
it in the chat input for review; nothing is sent to the agent and the audio is not stored.
"""

from __future__ import annotations

import re
from typing import Annotated

from fastapi import APIRouter, Depends, Request

from app.agent.llm import AgentUnavailable, Transcriber, shared_transcriber
from app.api.chat import MAX_MESSAGE_CHARS
from app.api.errors import ApiError
from app.api.limits import MAX_AUDIO_BYTES, limiter
from app.config import Settings, get_settings

router = APIRouter(prefix="/api")

MIN_AUDIO_BYTES = 1024
ALLOWED_AUDIO = frozenset({"audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav"})
_MIME = re.compile(r"^\s*([a-z0-9]+/[a-z0-9.+-]+)\s*(;.*)?$", re.IGNORECASE)


def transcribe_rate_limit() -> str:
    return get_settings().transcribe_rate_limit


def get_transcriber(settings: Annotated[Settings, Depends(get_settings)]) -> Transcriber:
    if not settings.transcribe_configured:
        raise ApiError(503, "AGENT_UNAVAILABLE", "Voice input is not configured on this server.")
    return shared_transcriber(settings.openai_api_key, settings.openai_transcribe_model)


def audio_mime(content_type: str | None) -> str:
    match = _MIME.match(content_type or "")
    mime = match.group(1).lower() if match else ""
    if mime not in ALLOWED_AUDIO:
        raise ApiError(415, "UNSUPPORTED_AUDIO", "This audio format is not supported.")
    return mime


@router.post("/transcribe")
@limiter.limit(transcribe_rate_limit)
async def transcribe(
    request: Request,
    transcriber: Annotated[Transcriber, Depends(get_transcriber)],
) -> dict:
    mime = audio_mime(request.headers.get("content-type"))
    audio = await request.body()
    if len(audio) > MAX_AUDIO_BYTES:
        raise ApiError(413, "PAYLOAD_TOO_LARGE", "The recording is too long.")
    if len(audio) < MIN_AUDIO_BYTES:
        raise ApiError(422, "EMPTY_AUDIO", "The recording is empty.")
    try:
        text = transcriber(audio, mime)
    except AgentUnavailable:
        raise ApiError(502, "AGENT_ERROR", "Voice input is unavailable right now. Please try again.") from None
    return {"success": True, "data": {"text": " ".join(str(text).split())[:MAX_MESSAGE_CHARS]}}
