import pytest

from app.agent.llm import AgentUnavailable
from app.api.limits import MAX_AUDIO_BYTES, limiter
from app.api.transcribe import get_transcriber
from app.main import app
from tests.agent.conftest import make_settings

AUDIO = b"\x1aE\xdf\xa3" + b"\x00" * 4096  # a WebM header followed by padding


class FakeTranscriber:
    def __init__(self, result: str | Exception = "add a shelf at 80 cm") -> None:
        self.result = result
        self.calls: list[tuple[bytes, str]] = []

    def __call__(self, audio: bytes, mime: str) -> str:
        self.calls.append((audio, mime))
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


@pytest.fixture
def stt(api):
    fake = FakeTranscriber()
    app.dependency_overrides[get_transcriber] = lambda: fake
    return fake


def post(api, body=AUDIO, content_type="audio/webm;codecs=opus"):
    return api.post("/api/transcribe", content=body, headers={"content-type": content_type})


def test_transcribes_raw_audio_and_returns_text(api, stt):
    response = post(api)
    assert response.status_code == 200
    assert response.json() == {"success": True, "data": {"text": "add a shelf at 80 cm"}}
    assert stt.calls == [(AUDIO, "audio/webm")]  # exact bytes; parameters stripped from the mime


def test_text_is_normalised_and_capped(api, stt):
    stt.result = "  shelf\n\n" + "x" * 5000
    text = post(api).json()["data"]["text"]
    assert text.startswith("shelf x") and len(text) == 2000


@pytest.mark.parametrize("content_type", ["application/json", "text/html", "audio/x-evil", "", "audio"])
def test_unsupported_types_are_rejected(api, stt, content_type):
    response = post(api, content_type=content_type)
    assert response.status_code == 415 and response.json()["error"]["code"] == "UNSUPPORTED_AUDIO"
    assert stt.calls == []


def test_size_limits(api, stt):
    assert post(api, body=b"\x00" * 100).status_code == 422
    assert post(api, body=b"\x00" * (MAX_AUDIO_BYTES + 1)).status_code == 413
    assert stt.calls == []


def test_the_larger_limit_applies_only_to_transcribe(api):
    response = api.post("/api/chat", content=b"{" + b" " * 300_000 + b"}",
                        headers={"content-type": "application/json"})
    assert response.status_code == 413


def test_provider_failure_is_a_generic_502(api, stt):
    stt.result = AgentUnavailable("AuthenticationError")
    response = post(api)
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "AGENT_ERROR"
    assert "Authentication" not in response.text


def test_unconfigured_server_is_503(api):
    api.settings = make_settings(openai_api_key="")
    response = post(api)
    assert response.status_code == 503 and response.json()["error"]["code"] == "AGENT_UNAVAILABLE"


def test_transcribe_is_rate_limited(api, stt):
    limiter.enabled = True
    limiter.reset()
    codes = [post(api).status_code for _ in range(11)]
    assert codes[:10] == [200] * 10 and codes[10] == 429
    limiter.reset()
