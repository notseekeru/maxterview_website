// e2e-onboarding-onboarding.nolean — labelled checkpoints for the onboarding journey.
//
// Purpose: simulate a user coming in on the public Landing, entering the app, and creating +
// navigating to a new interview — the lean "onboarding + dashboard navigation" journey.
// Drive with EITHER the wired MCP browser (browser_* by ref) or host-direct (playwright-core +
// chromium from the nix store). See SKILL.md for both paths and their tradeoffs.
//
// Hermetic: run the app pointed at the no-Clerk dev fallback (frontend WITHOUT a VITE_CLERK_
// PUBLISHABLE_KEY => clerkEnabled=false, backend returns DEV_USER). No Clerk/PayMongo keys needed.
// If the backend runs CLERK_ENABLED=true (real Clerk), sign the page in headlessly first via the
// paymongo-operator skill, or you will hit the signed-out gate instead of the dashboard.
//
// Precondition: the dev stack is up and reachable (make up), frontend at the BASE below.
// This file exports the labelled checkpoint array an agent asserts against while driving the browser
// (via MCP browser_* by ref, or host-direct page.*), mapping each step to a concrete action.

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
