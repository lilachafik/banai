"""Request limits: per-IP rate limiting (slowapi) and a request body size cap."""

from __future__ import annotations

from fastapi import Request
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from app.api.errors import envelope
from app.config import get_settings

MAX_BODY_BYTES = 256 * 1024
MAX_AUDIO_BYTES = 2 * 1024 * 1024  # about 60 s of Opus dictation
BODY_LIMITS = {"/api/transcribe": MAX_AUDIO_BYTES}

limiter = Limiter(key_func=get_remote_address)


def chat_rate_limit() -> str:
    return get_settings().chat_rate_limit


async def rate_limit_handler(_request: Request, _exc: RateLimitExceeded) -> JSONResponse:
    return envelope(429, "RATE_LIMITED", "Too many requests. Please wait a moment and try again.")


class BodySizeLimit(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        length = request.headers.get("content-length")
        limit = BODY_LIMITS.get(request.url.path, MAX_BODY_BYTES)
        if length is not None and (not length.isdigit() or int(length) > limit):
            return envelope(413, "PAYLOAD_TOO_LARGE", "The request is too large.")
        if length is None and request.method in ("POST", "PUT"):
            return envelope(411, "LENGTH_REQUIRED", "A Content-Length header is required.")
        return await call_next(request)
