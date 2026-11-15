# BYOK — per-owner LLM provider keys

**Shipped 2026-09-13.** An owner can point their interviews at their own OpenAI-compatible provider
(OpenAI, DeepSeek, OpenRouter, a self-hosted vLLM…) instead of the deployment's `LLM_*`.
UI: **`/settings/system`** → "Interview engine (BYOK)". Code: `backend-ts/src/byok.ts`
(policy/storage), `llm.LLMConfig` (transport), `frontend/src/components/LLMProviderCard.tsx`.

Customization is deliberately three fields — **base URL + model + API key** (the key is optional;
self-hosted endpoints need none). One config covers the interviewer, the grader and the JSON
formatter (`llm.grader_config` derives from it), so the two stages of scoring cannot drift apart.

## Enable it (one secret)

```bash
# backend-ts/.env (dev) or Infisical env prod -> k8s Secret maxterview-secrets (deployed)
BYOK_ENCRYPTION_KEY=$(docker exec -t maxterview_backend_dev node -e \
  "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")
```

Unset → BYOK is **off**: `GET /settings/llm` reports `enabled: false`, writes answer `503`, and the
settings card renders read-only. Malformed key → same, logged once as `byok.encryption_key_invalid`
(fail closed, the app still boots).

## Contract

|                |                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage        | one row per owner in `llm_credentials` (migration `0009`). `api_key` is Fernet ciphertext; `key_hint` is its **last 4 characters**, so the UI can say which key is saved.                                                                                                                                                           |
| Resolution     | per request, in the `LLMConfigDep` dependency: a usable BYOK row REPLACES the deployment's model entirely (base URL, model, key and grader included), Pro's `LLM_PRO_*` included. No row / BYOK off / undecryptable row → `llm.SYSTEM_CONFIG`.                                                                                      |
| Never returned | no endpoint echoes the key. `PUT` answers the same shape as `GET` (hint only). `POST /settings/llm/test` returns a short status reason, never a provider body (which can echo the request, and the request carries the key).                                                                                                        |
| Reuse          | `api_key: ""` on `PUT` keeps the stored key, so base URL and model stay editable without re-pasting. **A key is optional**: on first save an empty key saves a keyless row — correct for self-hosted endpoints (vLLM and any other keyless OpenAI-compatible server) that authenticate nothing. No key = no `Authorization` header. |
| Quota          | BYOK swaps the TIER cap for that tier's own ceiling (`BYOK_CHAT_TURNS`, 600/day on free; `BYOK_PREMIUM_CHAT_TURNS`, 5000/day on Pro and dev) and the turns stay metered (`/billing/usage` → `byok: true`, `MONETIZATION.md` §2). The cap is never waived: `byok` is self-asserted, so a waiver would be a free ride on whoever's GPU the `base_url` names. The tier label is unchanged. |
| Destinations   | two refusals at save (`_base_url`): this deployment's own `LLM_*` origin **while it needs no key**, and anything off the public internet (`is_global`, IP literal or resolved name). Every public provider is allowed, including the one this deployment uses — bring your own key and nothing is abused.                           |
| Availability   | every tier, including free; Pro's ceiling is the higher one (Quota).                                                                                                                                                                                                                                                                  |
| Removal        | `DELETE /settings/llm` drops the row; the next call is back on the system provider.                                                                                                                                                                                                                                                 |

## API

All paths carry the app's `/api` prefix.

| Method   | Path                     | Body / result                                                                                                                                                                |
| -------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/settings/llm`      | `{enabled, byok, base_url, model, key_hint, system:{configured, base_url, model}}` (`key_hint: null` = keyless row)                                                          |
| `PUT`    | `/api/settings/llm`      | `{base_url, model, api_key?}` → same shape as `GET`                                                                                                                          |
| `DELETE` | `/api/settings/llm`      | `204`                                                                                                                                                                        |
| `POST`   | `/api/settings/llm/test` | probes the **saved** config with a 1-token completion → `{ok, detail}`; the panel calls it on load, so a provider that stopped answering is visible before a turn dies on it |

Validation on write (all `422`): base URL must be `http(s)` with a host and no embedded
credentials/query/fragment; model non-empty; a key, **when supplied**, is 8–500 chars with **no
whitespace** — it goes verbatim into an `Authorization` header, where a stray space or newline is a
malformed (or injected) request.

## Threat notes

- **At rest:** the DB holds ciphertext + a 4-char hint. `BYOK_ENCRYPTION_KEY` is the only thing that can decrypt a row, and it lives in the same secret store as the system `LLM_API_KEY` — so this protects against a DB dump/backup leak, **not** against a compromised backend, which can read live keys from the process anyway. Say so plainly; do not market it as more.
- **In transit:** the browser→backend hop carries the key once, over TLS in deployed envs.
- **Provider sees the key:** it is the client for that provider, by design. The key is sent only to the base URL the owner typed.
- **SSRF surface (bounded 2026-09-14):** `base_url` is attacker-controlled, and the impact is bounded by construction — every call is a `POST {base_url}/chat/completions` (no arbitrary method/path), and no raw provider response body ever reaches the caller (`_completion` returns `None` → `503`; the probe returns a status-class reason only). On top of that `_base_url` refuses at save: anything not on the public internet (`is_global` — RFC1918, CGNAT/Tailscale `100.64/10`, loopback, link-local/IMDS, ULA, reserved, as an IP literal **or** a name that resolves into one), and this deployment's own `LLM_*` origin **while it needs no key**. So "probe my network" and "free-ride my own model with a junk key" are both closed; every public provider still works. **What remains:** DNS rebinding (the check resolves once at save, so a name can be public then and private at call time — re-check per call or deny private egress at the network layer if BYOK becomes a public feature), and a public KEYLESS endpoint picked to free-ride _someone else's_ GPU, which is nobody-here's cost. `BYOK_ALLOW_PRIVATE_HOSTS=true` lifts the private refusal for a single-operator fork whose own box runs the model; on a hosted deployment `localhost` would mean the pod, not the user's laptop, which is why it is off by default. `public_view` echoes `system.base_url` to every signed-in owner (the panel shows it as "System default") — harmless, since that address is exactly what BYOK refuses.

## Ops

- Rotating `BYOK_ENCRYPTION_KEY` orphans saved rows: each degrades to the system provider (`resolve_config` logs `byok.undecryptable_row`) until the owner saves again. Nothing crashes.
- Inspect state: `make psql` → `SELECT owner_id, base_url, model, key_hint, updated_at FROM llm_credentials;`

## Non-goals (deliberate)

No grader-model override, no per-interview provider, no token/cost metering, no key rotation UI, no
multi-row providers, no OAuth flows. Each is a new row or field away if it earns its keep.
