// e2e-onboarding-onboarding.nolean — a Playwright-MCP walkthrough of onboarding + dashboard nav.
//
// Purpose: simulate a user coming in on the public Landing, entering the app, and creating +
// navigating to a new interview — the lean "onboarding + dashboard navigation" journey.
// Runs through the EXISTING Playwright MCP server (chromium) — no @playwright/test dependency.
//
// Hermetic: run the app pointed at the no-Clerk dev fallback (frontend WITHOUT a VITE_CLERK_
// PUBLISHABLE_KEY => clerkEnabled=false, backend returns DEV_USER). No Clerk/Stripe keys needed.
//
// Precondition: the dev stack is up and reachable (make up), frontend at the BASE below.
// This file is invoked by an agent (or by the runner) issuing mcp__playwright calls; see
// references/onboarding-walkthrough.md for the line-by-line steps and expected asserts.

export const E2E_BASE = process.env.E2E_BASE ?? "http://localhost:5173";
export const ROLE = process.env.E2E_ROLE ?? "Software Engineer QA Walkthrough";
export const TOPIC = "system design for a mock-interview coach";

// The journey in labelled, assertable checkpoints. Each returns a pass/fail message.
// The agent drives the MCP browser and evaluates these; a "mock-test" for an ad-hoc run.
export const CHECKPOINTS = [
  { step: 1, name: "Landing loads", expectedAt: "/" },
  { step: 2, name: "Click 'Get started' navigates to /app", expectedAt: "/app", click: "Get started" },
  { step: 3, name: "Dev-mode banner visible on /app", text: "Dev mode (no Clerk key)" },
  { step: 4, name: "Fill role + topic in 'New interview' form", fill: ["#role", "#topic"] },
  { step: 5, name: "Submit 'Start interview'", submit: "Start interview" },
  { step: 6, name: "Navigates to /interviews/:id (created)", urlPattern: /\/interviews\/[0-9a-f-]+/ },
];
