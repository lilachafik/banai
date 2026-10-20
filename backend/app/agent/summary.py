"""Human-readable proposal bullets, generated from the validated ops (never from LLM text).

Each bullet is computed against the design *before* that op, so names such as
"compartment 2" match what the customer sees at the moment of confirming.
"""

from __future__ import annotations

from app.domain.lookup import locate

KIND_NAMES = {"compartment": "compartment", "partition": "partition", "door": "door",
              "shelves": "shelf", "drawers": "drawer", "rails": "hanging rail"}


def cm(mm: int) -> str:
    return f"{mm / 10:.1f} cm"


def _compartment(design: dict | None, compartment_id: str) -> str:
    if design:
        for index, compartment in enumerate(design["compartments"]):
            if compartment["id"] == compartment_id:
                return f"compartment {index + 1}"
    return "a new compartment"


def _component(design: dict | None, component_id: str) -> str:
    if component_id in ("carcass", "doors"):
        return "the body" if component_id == "carcass" else "the doors"
    found = locate(design, component_id) if design else None
    if found is None:
        return "a new component"
    kind, index, _ = found
    name = KIND_NAMES[kind]
    if kind in ("shelves", "drawers", "rails"):
        return f"the {name} in compartment {index + 1}"
    return f"{name} {index + 1}"


def _ref_name(ref: dict | None, catalog: dict, section: str) -> str | None:
    if not ref:
        return None
    if ref.get("custom"):
        return f"custom “{ref['name']}”"
    names = {entry["id"]: entry["name"] for entry in catalog.get(section, [])}
    return names.get(ref["catalogId"], ref["catalogId"])


def describe(op: dict, design: dict | None, catalog: dict) -> str:  # noqa: C901 - one branch per op
    kind = op["op"]
    if kind == "create_wardrobe":
        return (f"New wardrobe {cm(op['width'])} W × {cm(op['height'])} H × {cm(op['depth'])} D "
                f"with {op['compartmentCount']} compartments")
    if kind == "update_dimensions":
        parts = [f"{label} {cm(op[key])}" for key, label in
                 (("width", "width"), ("height", "height"), ("depth", "depth")) if op.get(key) is not None]
        return "Set " + ", ".join(parts)
    if kind == "configure_doors":
        if op["type"] == "none":
            return "Remove all doors"
        if op["type"] == "sliding":
            return f"Use {op.get('count') or len(op.get('ids') or []) or 2} sliding doors"
        count = len(op["doors"]) if op.get("doors") else len(op.get("ids") or []) or "one per compartment"
        return f"Use hinged doors ({count})"
    if kind == "add_compartment":
        return f"Add a compartment {cm(op['width'])} wide at position {op['position'] + 1}"
    if kind == "modify_compartment":
        return f"Set {_compartment(design, op['compartmentId'])} width to {cm(op['width'])}"
    if kind == "add_partition":
        return f"Split {_compartment(design, op['compartmentId'])} at {cm(op['offset'])}"
    if kind == "modify_partition":
        changes = [f"position {cm(op['position'])}" if op.get("position") is not None else None,
                   f"thickness {cm(op['thickness'])}" if op.get("thickness") is not None else None]
        return f"Set {_component(design, op['partitionId'])} " + ", ".join(c for c in changes if c)
    if kind in ("add_shelf", "add_rail"):
        name = "shelf" if kind == "add_shelf" else "hanging rail"
        return f"Add a {name} at {cm(op['y'])} in {_compartment(design, op['compartmentId'])}"
    if kind == "add_drawer":
        return (f"Add a {cm(op['height'])} drawer at {cm(op['y'])} in "
                f"{_compartment(design, op['compartmentId'])}")
    if kind in ("modify_shelf", "modify_drawer", "modify_rail"):
        changes = [f"{label} {cm(op[key])}" for key, label in
                   (("y", "height"), ("thickness", "thickness"), ("height", "size")) if op.get(key) is not None]
        return f"Set {_component(design, op['id'])} " + ", ".join(changes)
    if kind == "set_material":
        target = _component(design, op["target"])
        if op.get("clear"):
            return f"Reset {target} to the inherited finish"
        values = [_ref_name(op.get("material"), catalog, "materials"),
                  _ref_name(op.get("color"), catalog, "colors"),
                  _ref_name(op.get("finish"), catalog, "finishes")]
        return f"Set {target} to " + ", ".join(v for v in values if v)
    if kind == "remove_component":
        return f"Remove {_component(design, op['id'])}"
    return kind
