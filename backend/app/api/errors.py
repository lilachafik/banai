"""Error envelope `{success: false, data: null, error: {code, message}}`.

Messages are fixed strings: request input is never echoed back.
"""

from __future__ import annotations

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: dict | None = None) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


def envelope(status: int, code: str, message: str, details: dict | None = None) -> JSONResponse:
    error = {"code": code, "message": message, **({"details": details} if details else {})}
    return JSONResponse(status_code=status, content={"success": False, "data": None, "error": error})


async def api_error_handler(_request: Request, exc: ApiError) -> JSONResponse:
    return envelope(exc.status, exc.code, exc.message, exc.details)


async def validation_error_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    # Only field locations, never the offending input values.
    fields = [".".join(str(p) for p in error.get("loc", ())[1:]) for error in exc.errors()][:10]
    return envelope(422, "VALIDATION_ERROR", "The request is invalid.", {"fields": fields})
