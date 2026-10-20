import copy
import json

from app.agent.llm import LlmReply, ToolCall
from app.agent.orchestrator import FALLBACK_REPLY, MAX_REPAIRS, dry_run, run_turn
from app.agent.tools import TOOLS
from app.domain.apply import apply_ops
from tests.agent.conftest import FakeLlm, call

USER = [{"role": "user", "content": "Add a shelf at 100 cm in the left compartment"}]


def test_tools_cover_every_op_without_the_op_field():
    names = {tool["function"]["name"] for tool in TOOLS}
    assert len(names) == 15 and "add_shelf" in names and "remove_component" in names
    for tool in TOOLS:
        params = tool["function"]["parameters"]
        assert "op" not in params["properties"] and "$defs" not in json.dumps(params)


def test_tool_calls_become_a_validated_proposal(design, catalog):
    llm = FakeLlm(LlmReply("Adding a shelf.", [call("add_shelf", compartmentId="cmp_left", y=1000)]))
    turn = run_turn(USER, design, catalog, llm)
    assert turn.reply == "Adding a shelf."
    assert turn.ops[0]["op"] == "add_shelf" and turn.ops[0]["id"].startswith("shf_")
    assert turn.summary == ["Add a shelf at 100.0 cm in compartment 1"]
    # Replaying the signed ops is deterministic: the same ids come out.
    first = apply_ops(design, turn.ops, catalog)
    assert first == apply_ops(design, turn.ops, catalog)


def test_text_only_reply_is_a_question_without_a_proposal(design, catalog):
    turn = run_turn(USER, design, catalog, FakeLlm(LlmReply("Which compartment do you mean?")))
    assert turn.ops is None and turn.reply == "Which compartment do you mean?"


def test_agent_receives_the_current_design(design, catalog):
    edited = apply_ops(design, [{"op": "modify_shelf", "id": "shf_l1", "y": 555}], catalog)
    llm = FakeLlm(LlmReply("ok"))
    run_turn(USER, edited, catalog, llm)
    system = llm.calls[0][0]
    assert system["role"] == "system" and "555" in system["content"]
    assert llm.calls[0][1:] == USER


def test_invalid_op_is_repaired(design, catalog):
    llm = FakeLlm(
        LlmReply(None, [call("add_shelf", compartmentId="cmp_nope", y=1000)]),
        LlmReply("Fixed.", [call("add_shelf", "c2", compartmentId="cmp_left", y=1000)]),
    )
    turn = run_turn(USER, design, catalog, llm)
    assert turn.ops and turn.reply == "Fixed."
    repair = llm.calls[1]
    assert repair[-2]["role"] == "assistant" and repair[-2]["tool_calls"][0]["id"] == "c1"
    assert repair[-1]["role"] == "tool" and "NOT_FOUND" in repair[-1]["content"]


def test_repairs_are_bounded_then_no_proposal(design, catalog):
    bad = LlmReply(None, [call("add_shelf", compartmentId="cmp_left", y=999_999)])
    llm = FakeLlm(*[bad] * (1 + MAX_REPAIRS))
    turn = run_turn(USER, design, catalog, llm)
    assert turn.ops is None and turn.reply == FALLBACK_REPLY and len(llm.calls) == 1 + MAX_REPAIRS


def test_dry_run_never_mutates_the_input(design, catalog):
    before = copy.deepcopy(design)
    dry_run(design, [call("remove_component", id="cmp_left")], catalog)
    assert design == before


def test_untrusted_tool_calls_are_rejected(design, catalog):
    import pytest
    from app.domain.errors import DomainError

    for bad in (ToolCall("x", "drop_database", "{}"), ToolCall("x", "add_shelf", "[1]"),
                ToolCall("x", "add_shelf", "not json"),
                call("add_shelf", compartmentId="cmp_left", y=100, extra="<script>")):
        with pytest.raises(DomainError):
            dry_run(design, [bad], catalog)


def test_multi_step_turn_references_ids_chosen_by_the_model(catalog):
    calls = [
        call("create_wardrobe", "a", width=2400, height=2600, depth=600, compartmentCount=3,
             compartmentIds=["cmp_a", "cmp_b", "cmp_c"]),
        call("add_shelf", "b", compartmentId="cmp_a", y=400),
        call("add_rail", "c", compartmentId="cmp_b", y=1800),
        call("add_drawer", "d", compartmentId="cmp_c", y=0, height=200),
        call("configure_doors", "e", type="hinged"),
    ]
    ops, summary = dry_run(None, calls, catalog)
    result = apply_ops(None, ops, catalog)
    assert [c["id"] for c in result["compartments"]] == ["cmp_a", "cmp_b", "cmp_c"]
    assert len(result["doors"]["items"]) == 3 and all(d["id"] for d in result["doors"]["items"])
    assert result == apply_ops(None, ops, catalog)  # door ids were filled in, so replay is identical
    assert summary[0].startswith("New wardrobe 240.0 cm W × 260.0 cm H × 60.0 cm D")


def test_design_path_errors_point_at_the_failing_call(design, catalog):
    import pytest
    from app.domain.errors import DomainError

    calls = [call("add_shelf", "a", compartmentId="cmp_left", y=1000),
             call("add_shelf", "b", compartmentId="cmp_left", y=1005)]  # overlaps the first
    with pytest.raises(DomainError) as info:
        dry_run(design, calls, catalog)
    assert info.value.path.startswith("ops[1]")
