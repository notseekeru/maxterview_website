# Hermetic E2E — onboarding & dashboard navigation

The walkthrough an agent follows to simulate a **user onboarding** and **dashboard navigation** in
the frontend, driving it through the **existing Playwright MCP** (`mcp__playwright`, chromium in
`.mcp.json`) — no `@playwright/test`, no new dependency.

Follows the real DOM, not a fake: routes are `react-router-dom` in `frontend/src/App.tsx`.

**Hermetic by design:** run the dev stack against the **no-Clerk dev fallback** — start the frontend
WITHOUT a `VITE_CLERK_PUBLISHABLE_KEY` so `clerkEnabled=false` (renders the gated routes directly)
and the backend returns `DEV_USER`. No Clerk or Stripe keys are needed for this path. It exercises
onboarding + navigation only; it does not place a real Stripe payment.

## Preconditions

- Dev stack up: `make up` (or `docker compose ... up`), backend healthy at 8000, frontend at 5173.
- Frontend **without** a Clerk publishable key (dev fallback). Confirm: visiting `/app` shows a
  banner "Dev mode (no Clerk key) — requests run against the backend's DEV_USER."
- Base URL `http://localhost:5173` (override with `E2E_BASE`).

## The journey (simulates an onboarding user)

1. **Landing loads** — new user arrives at `/`. Assert the marketing hero and CTA(s)
   ("Get started" / "Start practicing").
2. **Enter the app** — click **"Get started"** (header). Assert navigation to `/app`.
3. **Dashboard + banner** — on `/app` assert the **dev-mode banner** (proves we're in DEV_USER
   hermetic mode, not Clerk) and the "New interview" form with `Role` + `Topic (optional)` inputs.
4. **Create interview** — fill `#role` with a role and `#topic` with a topic, submit
   "Start interview".
5. **Route to detail** — after create the SPA calls `onCreated(id)` →
   `navigate(/interviews/${id})`. Assert URL matches `/interviews/{uuid}` and the interview
   header / `InterviewChat` loads (it auto-calls `startInterview` on mount, transitioning to the
   live screen).
6. (Optional nav) use the exit/Home control back to `/app` to see the new interview listed in
   History — this proves dashboard navigation and persistence (backend wrote a real row for
   DEV_USER).

## Driving it (MCP tool sequence)

Issue these `mcp__playwright` calls (see scripts/checkpoints.mjs for the labelled checkpoint array):

```
mcp__playwright navigator / navigate { url: http://localhost:5173/ }
   assert hero text "Practice interviews with an AI coach..."
mcp__playwright click text "Get started"            -> lands on /app
mcp__playwright assert_text "Dev mode (no Clerk key)"
mcp__playwright fill { selector: "#role",  value: "Software Engineer" }
mcp__playwright fill { selector: "#topic", value: "system design" }
mcp__playwright click text "Start interview"
mcp__playwright url                                 -> expect /interviews/{uuid}
mcp__playwright assert_text "Interview"
```

Do not treat a pending interview (`status=pending→in_progress` auto-transition client-side) as a
failure. The chat fires only when you send a turn; this lean journey does not send one.

## Why this and not MCP-vs-playwright-test

You chose **existing Playwright MCP**. Consequence to keep explicit: this is a **scripted walkthrough**
that finishes/succeeds live as you and the agent watch step by step. It has **no pass/fail exit code
and no CI gate** (it is not `@playwright/test`). If you later want an actual deterministic suite /
CI-green regression, that requires the `@playwright/test` runner — a separate, slightly heavier layer.
This skill stays lean by design.

## Guardrails

- Use test data only; interviews created here are real rows for DEV_USER — clean them up in History
  if you care (the journey is harmless).
- This path never touches Clerk/Stripe keys. If you also want the real-payment leg (real Stripe
  hosted checkout + webhook), that is the separate `clerk-stripe-operator` skill — do not mix them.
