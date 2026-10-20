"""Live smoke test against the real OpenAI API. Skipped unless RUN_LIVE=1 (costs a few tokens).

    RUN_LIVE=1 uv run pytest tests/agent/test_live.py -s
"""

import os

import pytest

from app.agent.llm import OpenAiLlm
from app.agent.orchestrator import run_turn
from app.config import Settings
from app.domain.apply import apply_ops

pytestmark = pytest.mark.skipif(os.environ.get("RUN_LIVE") != "1", reason="live OpenAI call; set RUN_LIVE=1")


def test_live_agent_proposes_a_valid_shelf(design, catalog):
    settings = Settings()
    assert settings.agent_configured, "OPENAI_API_KEY, OPENAI_CHAT_MODEL and PROPOSAL_SIGNING_KEY must be set"
    llm = OpenAiLlm(settings.openai_api_key, settings.openai_chat_model)
    messages = [{"role": "user", "content": "Add a shelf at 100 cm in the left compartment"}]
    try:
        turn = run_turn(messages, design, catalog, llm)
    finally:
        llm.close()
    print("\nreply:", turn.reply, "\nsummary:", turn.summary, "\nops:", turn.ops)
    assert turn.ops, "expected a proposal"
    result = apply_ops(design, turn.ops, catalog)
    left = result["compartments"][0]
    assert any(abs(shelf["y"] - 1000) <= 20 for shelf in left["shelves"])


def test_live_dictation_round_trip():
    """Synthesise a short phrase with TTS, then transcribe it through the app's transcriber."""
    from openai import OpenAI

    from app.agent.llm import OpenAiTranscriber

    settings = Settings()
    assert settings.transcribe_configured
    client = OpenAI(api_key=settings.openai_api_key)
    try:
        speech = client.audio.speech.create(model="gpt-4o-mini-tts", voice="alloy",
                                            input="Add a shelf at eighty centimetres.", response_format="mp3")
        audio = speech.read()
    finally:
        client.close()
    transcriber = OpenAiTranscriber(settings.openai_api_key, settings.openai_transcribe_model)
    try:
        text = transcriber(audio, "audio/mpeg")
    finally:
        transcriber.close()
    print("\ntranscript:", text)
    assert "shelf" in text.lower()
