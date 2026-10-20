from app.services.signing import design_hash, sign, verify

KEY = "k" * 40


def test_sign_round_trip_and_key_order_independence():
    payload = {"b": 1, "a": [1, 2], "ops": [{"op": "add_shelf", "y": 800}]}
    signature = sign(payload, KEY)
    assert verify({"ops": [{"y": 800, "op": "add_shelf"}], "a": [1, 2], "b": 1}, signature, KEY)


def test_tampering_or_another_key_fails_verification():
    payload = {"ops": [{"op": "add_shelf", "y": 800}], "baseRevision": 3}
    signature = sign(payload, KEY)
    assert not verify({**payload, "baseRevision": 4}, signature, KEY)
    assert not verify({"ops": [{"op": "add_shelf", "y": 801}], "baseRevision": 3}, signature, KEY)
    assert not verify(payload, signature, "x" * 40)


def test_design_hash_is_canonical(design):
    reordered = dict(reversed(list(design.items())))
    assert design_hash(reordered) == design_hash(design)
    changed = {**design, "dimensions": {**design["dimensions"], "width": 2100}}
    assert design_hash(changed) != design_hash(design)
