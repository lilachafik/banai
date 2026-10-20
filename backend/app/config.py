"""Application settings loaded from environment variables."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

# Configurable prototype limits for the AI agent (not business rules).
OPENAI_TIMEOUT_SECONDS = 30
OPENAI_MAX_RETRIES = 1
PROPOSAL_TTL_SECONDS = 30 * 60
MIN_SIGNING_KEY_LENGTH = 32


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "local"
    cors_origins: str = "http://localhost:5173"
    openai_api_key: str = ""
    openai_chat_model: str = ""
    proposal_signing_key: str = ""
    chat_rate_limit: str = "10/minute"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def signing_configured(self) -> bool:
        return len(self.proposal_signing_key) >= MIN_SIGNING_KEY_LENGTH

    @property
    def agent_configured(self) -> bool:
        return bool(self.openai_api_key and self.openai_chat_model) and self.signing_configured


@lru_cache
def get_settings() -> Settings:
    return Settings()
