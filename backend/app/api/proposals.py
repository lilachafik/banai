"""POST /api/proposals/apply: verify a signed proposal, reject stale ones, apply it.

Order: signature (403) -> expiry (409 EXPIRED) -> staleness by revision and design hash
(409 STALE) -> domain apply (422). The server stores nothing.
"""

from __future__ import annotations

import time
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from app.api.chat import MAX_REVISION, validated_design
from app.api.errors import ApiError
from app.config import Settings, get_settings
from app.domain.apply import apply_ops
from app.domain.catalog import load_catalog
from app.domain.errors import DomainError
from app.domain.ops import MAX_OPS
from app.services.signing import design_hash, verify

router = APIRouter(prefix="/api")

Hex64 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class SignedProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")
    proposalId: Annotated[str, Field(pattern=r"^[0-9a-f]{32}$")]  # noqa: N815 - wire format
    baseRevision: Annotated[int, Field(ge=1, le=MAX_REVISION)]  # noqa: N815
    baseHash: Hex64  # noqa: N815
    expiresAt: Annotated[int, Field(ge=0)]  # noqa: N815
    ops: Annotated[list[dict], Field(min_length=1, max_length=MAX_OPS)]
    summary: Annotated[list[Annotated[str, Field(max_length=300)]], Field(max_length=MAX_OPS)]
    signature: Hex64


class ApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    design: dict
    revision: Annotated[int, Field(ge=1, le=MAX_REVISION)]
    proposal: SignedProposal


@router.post("/proposals/apply")
def apply_proposal(body: ApplyRequest, settings: Annotated[Settings, Depends(get_settings)]) -> dict:
    if not settings.signing_configured:
        raise ApiError(503, "AGENT_UNAVAILABLE", "The AI designer is not configured on this server.")
    proposal = body.proposal.model_dump()
    signature = proposal.pop("signature")
    if not verify(proposal, signature, settings.proposal_signing_key):
        raise ApiError(403, "INVALID_SIGNATURE", "This proposal was not issued by this server.")
    if proposal["expiresAt"] < time.time():
        raise ApiError(409, "EXPIRED", "This proposal has expired. Ask the agent again.")
    catalog = load_catalog()
    design = validated_design(body.design, catalog)
    if body.revision != proposal["baseRevision"] or design_hash(design) != proposal["baseHash"]:
        raise ApiError(409, "STALE", "The design changed since this proposal was made.")
    try:
        new_design = apply_ops(design, proposal["ops"], catalog)
    except DomainError as error:
        raise ApiError(422, "INVALID_PROPOSAL", "The proposal could not be applied.",
                       {"domain": error.to_dict()}) from None
    return {"success": True, "data": {"design": new_design, "revision": body.revision + 1}}
