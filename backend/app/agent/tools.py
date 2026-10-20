"""OpenAI function tools: one per domain op.

Parameters are generated from the Pydantic op models in app/domain/ops.py, so the
tools cannot drift from the domain. Tool arguments are untrusted: they are always
re-parsed by `parse_ops` and dry-run by `apply_ops` before anything is proposed.
"""

from __future__ import annotations

import copy

from app.domain import ops as op_types

DESCRIPTIONS: dict[str, str] = {
    "create_wardrobe": "Replace the whole design with a new empty wardrobe of equal-width compartments "
    "(doors 'none'). Give compartmentIds when later calls in this turn reference the compartments.",
    "update_dimensions": "Change overall width/height/depth (mm). Width changes rescale compartments proportionally.",
    "configure_doors": "Set the door type. hinged: omit doors for one door per compartment, or give doors "
    "[{compartmentIds, hingeSide}]. sliding: give count (1-6). none: no other fields.",
    "add_compartment": "Insert a compartment at position (0 = leftmost); its width is taken from the "
    "compartment currently at that position.",
    "modify_compartment": "Set a compartment's width; the right neighbour (left for the last) absorbs the difference.",
    "add_partition": "Split a compartment with a vertical partition at offset mm from its left edge.",
    "modify_partition": "Move a partition to interior x position (mm) and/or change its thickness.",
    "add_shelf": "Add a shelf; y = height in mm of its bottom face above the top of the bottom panel.",
    "modify_shelf": "Move a shelf (y in mm) and/or change its thickness.",
    "add_drawer": "Add a drawer occupying [y, y+height] mm in a compartment.",
    "modify_drawer": "Move or resize a drawer.",
    "add_rail": "Add a hanging rail at height y mm in a compartment.",
    "modify_rail": "Move a hanging rail to height y mm.",
    "set_material": "Change material/colour/finish of 'carcass', 'doors', or one door/shelf/drawer id. "
    "Use {catalogId} from the catalog, or {custom: true, name, hex} for a colour not in the catalog.",
    "remove_component": "Remove a shelf, drawer, rail, door, compartment or partition by id.",
}

OP_MODELS = {model.model_fields["op"].annotation.__args__[0]: model for model in (
    op_types.CreateWardrobe, op_types.UpdateDimensions, op_types.ConfigureDoors,
    op_types.AddCompartment, op_types.ModifyCompartment, op_types.AddPartition,
    op_types.ModifyPartition, op_types.AddShelf, op_types.ModifyShelf, op_types.AddDrawer,
    op_types.ModifyDrawer, op_types.AddRail, op_types.ModifyRail, op_types.SetMaterial,
    op_types.RemoveComponent,
)}


# The bounded Int type surfaces its constraints as `ge`/`le`; JSON Schema names them minimum/maximum.
_JSON_SCHEMA_KEYS = {"ge": "minimum", "le": "maximum"}


def _inline_refs(node: object, defs: dict) -> object:
    if isinstance(node, dict):
        if "$ref" in node:
            return _inline_refs(copy.deepcopy(defs[node["$ref"].rsplit("/", 1)[-1]]), defs)
        return {_JSON_SCHEMA_KEYS.get(k, k): _inline_refs(v, defs)
                for k, v in node.items() if k not in ("title", "discriminator")}
    if isinstance(node, list):
        return [_inline_refs(v, defs) for v in node]
    return node


def _parameters(model) -> dict:
    schema = model.model_json_schema(by_alias=True)
    defs = schema.pop("$defs", {})
    schema = _inline_refs(schema, defs)
    schema["properties"].pop("op")
    schema["required"] = [name for name in schema.get("required", []) if name != "op"]
    schema["additionalProperties"] = False
    return schema


def build_tools() -> list[dict]:
    return [
        {
            "type": "function",
            "function": {"name": name, "description": DESCRIPTIONS[name], "parameters": _parameters(model)},
        }
        for name, model in OP_MODELS.items()
    ]


TOOLS = build_tools()
TOOL_NAMES = frozenset(OP_MODELS)
