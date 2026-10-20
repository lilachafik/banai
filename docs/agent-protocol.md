# AI Agent & Proposal Protocol (Phase 5)

The chat agent proposes changes; it never applies them. Every change goes through the
same typed ops as manual editing ([schema.md](schema.md)), is dry-run on the
authoritative Python engine, and is applied only after the customer presses **Confirm**.

## Flow
1. The customer sends a message. The frontend posts `POST /api/chat {messages, design, revision}`
   with the **latest committed design**. The agent is called only here: never on manual edits,
   input changes or mouse moves.
2. The backend builds a system prompt (rules, catalog ids, prototype limits, a derived summary of
   the current design and its full JSON) and calls OpenAI Chat Completions with **15 function
   tools, one per op**. Tool parameters are generated from the Pydantic op models
   (`app/agent/tools.py`), so they cannot drift from the domain.
3. Tool calls become ops `{op: <tool name>, ...args}` and are processed one by one
   (`app/agent/orchestrator.py`):
   - parsed with the domain op models (unknown tools, non-object arguments, unknown keys,
     unbounded ints and bad ids are rejected);
   - **ids are filled in** for every component an op creates, so replaying the approved ops is
     deterministic;
   - **dry-run** with `apply_ops` (pure; the input is never mutated, every step is fully validated).
4. If a call fails, the `{code, path, message}` error is returned to the model as the tool result and
   it may resend the whole batch, at most **2 repair rounds**. Then the customer gets a "please
   rephrase" reply and no proposal.
5. A text-only reply (a clarifying question or an answer) produces no proposal.
6. A valid batch is returned as a **signed proposal**. The bullet list on the card is generated
   server-side from the validated ops (`app/agent/summary.py`), never from LLM text, so the card
   always describes exactly what Confirm will do.
7. **Confirm** posts `POST /api/proposals/apply {design, revision, proposal}`; the frontend commits
   the returned design. **Cancel** is client-only.

## Proposal format
```jsonc
{
  "proposalId": "<32 hex>",
  "baseRevision": 3,              // the revision the agent saw
  "baseHash": "<sha256 hex>",     // SHA-256 of the canonical design JSON
  "expiresAt": 1792540800,        // unix seconds; TTL 30 min (configurable)
  "ops": [{ "op": "add_shelf", "compartmentId": "cmp_left", "y": 1000, "id": "shf_31ef24c9" }],
  "summary": ["Add a shelf at 100.0 cm in compartment 1"],
  "signature": "<HMAC-SHA256 hex over every other field, key PROPOSAL_SIGNING_KEY>"
}
```
The server stores nothing. Canonical JSON = sorted keys, compact separators, UTF-8.

## `/api/proposals/apply` checks (in order)
| Check | Result |
|---|---|
| Signature valid (`hmac.compare_digest`) | else **403 INVALID_SIGNATURE** |
| Not expired | else **409 EXPIRED** |
| Design is valid | else **422 INVALID_DESIGN** |
| `revision == baseRevision` **and** `hash(design) == baseHash` | else **409 STALE** |
| Ops apply cleanly | else **422 INVALID_PROPOSAL** |
| | **200** `{design, revision: revision + 1}` |

The revision is client-supplied; the design hash is the real staleness guard.

## Stale proposals in the UI
- The pending proposal lives in the store **outside** the committed design (`pendingProposal`).
- A manual edit bumps the revision, so the card shows "Design changed – ask the agent to
  re-propose" and Confirm is disabled. The agent is not called.
- If a manual edit lands while an apply request is in flight, the response is **not** committed.
- A 409 from the server also marks the card stale (or expired).
- A newer proposal marks the previous one "Replaced".
- The conversation sent to the agent includes its earlier replies with their proposed changes and
  notes such as "The customer cancelled the proposal", so it knows what happened.

## Limits and errors
| Limit | Value (configurable prototype default) |
|---|---|
| Messages per request | 30 (roles `user` / `assistant` only; the last must be `user`) |
| Characters per message | 2000 |
| Ops per proposal | 100 |
| Repair rounds | 2 |
| Rate limit on `/api/chat` | 10/minute per client IP (`CHAT_RATE_LIMIT`) |
| Request body | 256 KB (413), `Content-Length` required for POST/PUT (411) |
| OpenAI timeout / retries | 30 s / 1 |

| Error | Status |
|---|---|
| `VALIDATION_ERROR` (no input echoed, only field paths) | 422 |
| `INVALID_DESIGN` | 422 |
| `AGENT_UNAVAILABLE` (no key, model or signing key) | 503 |
| `AGENT_ERROR` (any OpenAI failure; generic message, no secrets) | 502 |
| `RATE_LIMITED` | 429 |

The frontend shows its own fixed texts for these errors and renders all agent text with
`textContent`.

## Configuration (`backend/.env`)
`OPENAI_API_KEY`, `OPENAI_CHAT_MODEL` (default in this project: `gpt-4.1-mini`; swappable),
`PROPOSAL_SIGNING_KEY` (≥ 32 characters), optional `CHAT_RATE_LIMIT`.

## Tests
- `backend/tests/agent/`: signing, orchestrator (tool calls → ops, repair loop, ids, awareness,
  untrusted input), and both endpoints (stale, tampered, expired, invalid, 422/502/503/429/413),
  with a scripted fake LLM.
- `backend/tests/agent/test_live.py`: one real OpenAI call, skipped unless `RUN_LIVE=1`.
- `frontend/tests/unit/chat/controller.test.js`: send / confirm / cancel / stale / in-flight edit.
- `frontend/tests/e2e/chat.spec.js`: the UI flow with mocked agent endpoints.

## Voice dictation (Phase 5b, scope change 2026-10-20)
Dictation only: no spoken replies and no voice conversation. The approval flow is unchanged.
1. The mic button (shown only when the browser can record in a secure context) records with
   `MediaRecorder`, up to **60 s**. The microphone is released as soon as recording stops.
2. The recording is posted as the **raw request body** to `POST /api/transcribe` with its audio
   `Content-Type` (`audio/webm|ogg|mp4|mpeg|wav`, codec parameters allowed).
3. The backend sends it to OpenAI (`OPENAI_TRANSCRIBE_MODEL`, default `gpt-4o-transcribe`) and
   returns `{text}` (whitespace-normalised, ≤ 2000 chars). Audio is never stored or logged.
4. The text is put **in the chat input** for the customer to review and edit. It is never sent
   to the agent automatically; Send and then Confirm are still required.

| Error | Status |
|---|---|
| `UNSUPPORTED_AUDIO` (content type not allowed) | 415 |
| `PAYLOAD_TOO_LARGE` (> 2 MB; the per-path body cap, other routes stay at 256 KB) | 413 |
| `EMPTY_AUDIO` (< 1 KB) | 422 |
| `AGENT_UNAVAILABLE` (no key or model) / `AGENT_ERROR` (provider failure) | 503 / 502 |
| `RATE_LIMITED` (`TRANSCRIBE_RATE_LIMIT`, default 10/minute per IP) | 429 |

Browser errors (microphone blocked or missing, nothing heard) and server errors are shown as
fixed texts under the composer.

Known behaviour: speech-to-text models can return invented text for non-speech audio (noise,
tones). No transcription prompt is sent, which keeps such output obviously wrong rather than
plausible; review-before-send is the safeguard.

## Known limitations
- Behind a proxy (Railway), the rate limiter needs the real client IP: run uvicorn with
  `--proxy-headers` and trusted forwarded IPs (Phase 9).
- Rate limit counters are in memory per process.
- No ghost preview of a pending proposal (optional in the architecture; not built).
