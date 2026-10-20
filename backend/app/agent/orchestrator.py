"""One agent turn: LLM tool calls -> validated, dry-run ops (or a plain reply).

The orchestrator never commits anything. It turns tool calls into ops, parses them
with the domain's Pydantic models, fills in ids (so replaying an approved proposal is
deterministic), and dry-runs them on the pure domain engine. Errors go back to the
model for repair, at most MAX_REPAIRS times.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from app.agent.llm import Llm, ToolCall
from app.agent.prompts import system_prompt
from app.agent.summary import describe
from app.agent.tools import TOOL_NAMES, TOOLS
from app.domain import ids
from app.domain.apply import apply_ops
from app.domain.defaults import LIMITS
from app.domain.errors import INVALID_OP, SCHEMA_INVALID, DomainError
from app.domain.ops import MAX_OPS, parse_op

MAX_REPAIRS = 2
FALLBACK_REPLY = "I couldn't turn that into a valid change. Could you rephrase it or add more detail?"
PROPOSAL_REPLY = "Here is my proposal."

ITEM_PREFIXES = {"add_shelf": ids.SHELF, "add_drawer": ids.DRAWER, "add_rail": ids.RAIL}


@dataclass(frozen=True)
class Turn:
    reply: str
    ops: list[dict] | None = None
    summary: list[str] = field(default_factory=list)


def run_turn(messages: list[dict], design: dict, catalog: dict, llm: Llm) -> Turn:
    conversation = [{"role": "system", "content": system_prompt(design, catalog)}, *messages]
    for _ in range(1 + MAX_REPAIRS):
        reply = llm(conversation, TOOLS)
        if not reply.tool_calls:
            return Turn(reply=(reply.content or "").strip() or FALLBACK_REPLY)
        try:
            ops, summary = dry_run(design, reply.tool_calls, catalog)
        except DomainError as error:
            conversation += _repair_messages(reply.content, reply.tool_calls, error)
            continue
        return Turn(reply=(reply.content or "").strip() or PROPOSAL_REPLY, ops=ops, summary=summary)
    return Turn(reply=FALLBACK_REPLY)


def dry_run(design: dict, calls: list[ToolCall], catalog: dict) -> tuple[list[dict], list[str]]:
    """Validate the calls as one batch. Returns canonical ops (ids filled) and their bullets."""
    if len(calls) > MAX_OPS:
        raise DomainError(SCHEMA_INVALID, "ops", f"at most {MAX_OPS} ops per batch")
    current, ops, summary = design, [], []
    for index, call in enumerate(calls):
        op = _parse_call(call, index)
        _fill_ids(op, current)
        summary.append(describe(op, current, catalog))
        try:
            current = apply_ops(current, [op], catalog)
        except DomainError as error:
            # Report against this call: op paths are re-indexed, design paths are prefixed.
            if error.path.startswith("ops[0]"):
                path = f"ops[{index}]" + error.path[len("ops[0]"):]
            else:
                path = f"ops[{index}]:{error.path}"
            raise DomainError(error.code, path, error.message) from None
        ops.append(op)
    return ops, summary


def _parse_call(call: ToolCall, index: int) -> dict:
    path = f"ops[{index}]"
    if call.name not in TOOL_NAMES:
        raise DomainError(INVALID_OP, path, "unknown tool")
    try:
        args = json.loads(call.arguments or "{}")
    except (ValueError, RecursionError):
        raise DomainError(SCHEMA_INVALID, path, "arguments must be a JSON object") from None
    if not isinstance(args, dict):
        raise DomainError(SCHEMA_INVALID, path, "arguments must be a JSON object")
    model = parse_op({**args, "op": call.name}, index)
    return model.model_dump(by_alias=True, exclude_none=True)


def _fill_ids(op: dict, design: dict | None) -> None:
    """Give every component the op creates an explicit id (counts that are out of range are left
    for the domain engine to reject)."""
    kind = op["op"]
    if kind in ITEM_PREFIXES:
        op.setdefault("id", ids.new_id(ITEM_PREFIXES[kind]))
    elif kind == "add_compartment":
        op.setdefault("id", ids.new_id(ids.COMPARTMENT))
        op.setdefault("partitionId", ids.new_id(ids.PARTITION))
    elif kind == "add_partition":
        op.setdefault("id", ids.new_id(ids.PARTITION))
        op.setdefault("newCompartmentId", ids.new_id(ids.COMPARTMENT))
    elif kind == "create_wardrobe":
        count = op["compartmentCount"]
        if _in_range(count, "compartmentCount"):
            op.setdefault("compartmentIds", [ids.new_id(ids.COMPARTMENT) for _ in range(count)])
            op.setdefault("partitionIds", [ids.new_id(ids.PARTITION) for _ in range(count - 1)])
    elif kind == "configure_doors":
        _fill_door_ids(op, design)


def _fill_door_ids(op: dict, design: dict | None) -> None:
    if op["type"] == "sliding" and "ids" not in op:
        count = op.get("count", 2)
        if _in_range(count, "slidingDoorCount"):
            op["ids"] = [ids.new_id(ids.DOOR) for _ in range(count)]
    elif op["type"] == "hinged":
        if "doors" in op:
            for door in op["doors"]:
                door.setdefault("id", ids.new_id(ids.DOOR))
        elif "ids" not in op and "count" not in op and design is not None:
            op["ids"] = [ids.new_id(ids.DOOR) for _ in design["compartments"]]


def _in_range(value: int, limit: str) -> bool:
    low, high = LIMITS[limit]
    return low <= value <= high


def _repair_messages(content: str | None, calls: list[ToolCall], error: DomainError) -> list[dict]:
    failed = int(error.path[4:].split("]")[0]) if error.path.startswith("ops[") else 0
    assistant = {
        "role": "assistant",
        "content": content,
        "tool_calls": [{"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments}}
                       for c in calls],
    }
    results = []
    for index, call in enumerate(calls):
        if index == failed:
            text = json.dumps({"error": error.to_dict(),
                               "note": "The whole batch was rejected. Send the complete corrected set of calls."})
        else:
            text = "ok" if index < failed else "not evaluated"
        results.append({"role": "tool", "tool_call_id": call.id, "content": text})
    return [assistant, *results]
