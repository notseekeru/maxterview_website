# BYOK — per-owner LLM provider keys

**Status: shipped 2026-09-13.** An owner can point their interviews at their own
OpenAI-compatible provider (OpenAI, DeepSeek, OpenRouter, Ollama, a self-hosted llama.cpp…)
instead of the deployment's `LLM_*` provider. UI: **`/app/settings/system`** → "Interview
engine (BYOK)". Code: `backend/src/app/byok.py` (policy/storage), `llm.LLMConfig` (transport),
`frontend/src/components/LLMProviderCard.tsx`.

Customization is deliberately three fields: **base URL + model + API key** (the key is optional —
self-hosted endpoints need none). One config covers the interviewer, the grader and the JSON
formatter (`llm.grader_config` derives from it), so there is no second place for the two stages of
scoring to drift apart.

## Enable it (one secret)

```bash
# backend/.env (dev) or Infisical env prod -> k8s Secret maxterview-secrets (deployed)
BYOK_ENCRYPTION_KEY=$(docker exec -t maxterview_backend_dev uv run python -c \
  "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")
```

Unset → BYOK is **off**: `GET /settings/llm` reports `enabled: false`, writes answer
`503`, and the settings card renders read-only. Malformed key → same, logged once as
`byok.encryption_key_invalid` (fail closed, the app still boots).

## Contract

| | |
|---|---|
| Storage | one row per owner in `llm_credentials` (migration `0009`). `api_key` is Fernet ciphertext; `key_hint` is its **last 4 characters** so the UI can say which key is saved. |
| Resolution | per request, in the `LLMConfigDep` dependency: a usable BYOK row REPLACES `LLM_*` entirely (base URL, model, key — grader included). No row / BYOK off / undecryptable row → `llm.SYSTEM_CONFIG`. |
| Never returned | no endpoint echoes the key. `PUT` answers the same shape as `GET` (hint only). `POST /settings/llm/test` returns a short status reason, never a provider body (which can echo the request, and the request carries the key). |
| Reuse | `api_key: ""` on `PUT` keeps the stored key, so base URL and model stay editable without re-pasting. **A key is optional**: on the first save an empty key saves a keyless row — the right answer for self-hosted endpoints (Ollama, llama.cpp, vLLM) that authenticate nothing. No key = no `Authorization` header. |
| Quota | BYOK turns skip the daily chat-turn cap and are not metered (`/usage` → `byok: true`, `MONETIZATION.md` §2). The owner pays their provider; the tier label is unchanged. |
| Availability | every tier, including free. Not a premium perk. |
| Removal | `DELETE /settings/llm` drops the row; the next call is back on the system provider. |

Signature-check + `README`-level summary of the two-stage pipeline are unchanged: BYOK changes
*who* answers, not *how* the interview is graded.

## API

| Method | Path | Body / result |
|---|---|---|
| `GET` | `/api/settings/llm` | `{enabled, byok, base_url, model, key_hint, system:{configured, base_url, model}}` (`key_hint: null` = keyless row) |
| `PUT` | `/api/settings/llm` | `{base_url, model, api_key?}` → same shape as `GET` |
| `DELETE` | `/api/settings/llm` | `204` |
| `POST` | `/api/settings/llm/test` | probes the **saved** config with a 1-token completion → `{ok, detail}` |

Validation on write (all `422`): base URL must be `http(s)` with a host and no embedded
credentials/query/fragment (so `https://api.openai.com/v1` and `http://localhost:11434/v1` are
fine, `ftp://…` and `https://user:pw@…` are not); model non-empty; a key, **when supplied**, is
8–500 chars with **no whitespace** — it goes verbatim into an `Authorization` header, where a stray
space or newline is a malformed (or injected) request.

## Threat notes

- **At rest:** the DB holds ciphertext + a 4-char hint. `BYOK_ENCRYPTION_KEY` is the only thing
  that can decrypt a row, and it lives in the same secret store as the system `LLM_API_KEY` — so
  this protects against a DB dump/backup leak, not against a compromised backend (which can read
  live keys from the process anyway). Say so plainly; do not market it as more.
- **In transit:** the browser→backend hop carries the key once, over TLS in deployed envs.
- **Provider sees the key:** it is the client for that provider, by design. The key is sent only
  to the base URL the owner typed.
- **SSRF surface (accepted):** `base_url` is attacker-controlled. The impact is bounded by
  construction — every call is a `POST {base_url}/chat/completions` (no arbitrary method/path),
  and no raw provider response body ever reaches the caller (`_completion` returns `None` → `503`;
  the probe returns a status-class reason only). A private-host/IP allow-list is the upgrade path
  if that ever changes (e.g. a GET probe or an echoed body).
- **Prompt injection:** unchanged — the key is not part of any prompt, and the transcript guard in
  `llm.INJECTION_GUARD` still applies.
- **A BYOK owner can weaken their own grading** by pointing at a weak model; that is their
  interview to lose, and nothing on the deployment's side is affected.
- **Logs** never contain keys, hints or provider response bodies (`byok.undecryptable_row` is the
  only BYOK log line, and it carries no owner id).

## Ops

- Rotating `BYOK_ENCRYPTION_KEY` orphans saved rows: each degrades to the system provider
  (`resolve_config` logs `byok.undecryptable_row`) until the owner saves again. Nothing crashes.
- Inspect state: `make psql` → `SELECT owner_id, base_url, model, key_hint, updated_at FROM llm_credentials;`
- Tests: `uv run pytest tests/test_byok.py` (encryption, validation, fallbacks, probe hygiene) plus
  the settings round trip in `tests/test_api.py`. **Zero-touch:** tests use generated throwaway
  keys and `api.example.com`; no real credential is read or written.

## Non-goals (deliberate)

No grader-model override, no per-interview provider, no token/cost metering, no key rotation UI,
no multi-row providers, no OAuth flows. Each is a new row or field away if it earns its keep.
