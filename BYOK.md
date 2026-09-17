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
| Quota | BYOK swaps the TIER cap for a flat, higher ceiling (`BYOK_CHAT_TURNS`, default 1000/day) and the turns stay metered (`/usage` → `byok: true`, `MONETIZATION.md` §2). The cap is never waived: it is self-asserted, so a waiver would be a free ride on whoever's GPU the `base_url` names. The tier label is unchanged. |
| Destinations | two refusals at save (`_base_url`): this deployment's own `LLM_*` origin **while it needs no key**, and anything off the public internet (`is_global`, IP literal or resolved name). Every public provider is allowed, including the one this deployment happens to use — bring your own key for it and nothing is being abused (see the threat notes). |
| Availability | every tier, including free. Not a premium perk. |
| Removal | `DELETE /settings/llm` drops the row; the next call is back on the system provider. |

Signature-check + `README`-level summary of the two-stage pipeline are unchanged: BYOK changes
*who* answers, not *how* the interview is graded.

## API

All paths carry the app's `/api` prefix (the table below shows it).

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
- **SSRF surface (bounded 2026-09-14):** `base_url` is attacker-controlled. The impact is bounded by
  construction — every call is a `POST {base_url}/chat/completions` (no arbitrary method/path),
  and no raw provider response body ever reaches the caller (`_completion` returns `None` → `503`;
  the probe returns a status-class reason only). On top of that, `_base_url` refuses at save time:
  anything that is not on the public internet (`is_global` — RFC1918, CGNAT/Tailscale `100.64/10`,
  loopback, link-local/IMDS, ULA, reserved, as an IP literal **or** as a name that resolves into
  one), and this deployment's own `LLM_*` origin **while it needs no key**. So "probe my network"
  and "free-ride my own model with a junk key" are both closed; every public provider still works.
  What remains: DNS rebinding (the check resolves once at save, so a name can be public then and
  private at call time — re-check per call or deny private egress at the network layer if BYOK
  becomes a public feature), and a public KEYLESS endpoint picked precisely to free-ride *someone
  else's* GPU, which is nobody-here's cost. `BYOK_ALLOW_PRIVATE_HOSTS=true` lifts the private
  refusal for a single-operator fork whose own box runs the model: on a hosted deployment
  `localhost` would mean the pod, not the user's laptop, which is why it is off by default.
  `public_view` still echoes `system.base_url` to every signed-in owner (the settings panel shows
  it as "System default"); harmless now, since that address is exactly what BYOK refuses.
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
