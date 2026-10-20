"""Stateless, signed AI proposals.

The server stores nothing: a proposal carries its own HMAC-SHA256 signature over
every field except `signature`, so `/api/proposals/apply` can trust the ops and the
base it was computed against. Staleness is detected with the design hash.
"""

from __future__ import annotations

import hashlib
import hmac
import json

from app.domain.schema import parse_design


def canonical_json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def design_hash(design: object) -> str:
    """SHA-256 of the canonical form, so equal designs hash equally whatever their key order."""
    return hashlib.sha256(canonical_json(parse_design(design))).hexdigest()


def sign(payload: dict, key: str) -> str:
    return hmac.new(key.encode("utf-8"), canonical_json(payload), hashlib.sha256).hexdigest()


def verify(payload: dict, signature: str, key: str) -> bool:
    return hmac.compare_digest(sign(payload, key), signature)
