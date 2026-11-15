# w0-scaffold

Created: `biome.json`, `vitest.config.ts`, `tsconfig.test.json`, `.gitignore`, `reports/.gitkeep`, `LAWS.md`, `src/{env,errors,app,main}.ts`, `src/routes/{interviews,chat,templates,resumes,voice,settings}.ts`, `tests/scaffold.test.ts`.

Endpoints implemented in `src/app.ts`: `GET /api/health` -> `{status:"ok",up:1}`; `POST /api/client-errors` -> 204, 413 over 4096 bytes, 422 on a bad report (string detail, matching `main.py`). Also `notFound` -> `{detail:"Not Found"}` and `onError` -> HttpError envelope, else text/plain "Internal Server Error"; without those the envelope in errors.ts had no owner. Middleware order: request context, CORS when origins configured, rate limit, each a no-op with an `AI HERE` naming `src/logs.ts` / `src/ratelimit.ts`.

env.ts: derived 68 vars via the grep, all present, plus `port` (PORT, default 8000; uvicorn takes its port from argv, so 8000 is the deployed mapping, not a Python getenv). No `os.getenv` was missed.

Guesses: (1) `LATEX_TIMEOUT`/`LATEX_QUEUE_WAIT` are `float()` in latex.py, typed `int` because the helper set is str/int/bool/commaList and the shipped dials are whole seconds. (2) route modules are mounted at `/` and must declare absolute paths, because the chat family owns `/interviews/{id}/chat`; LAWS 6 records it. (3) `client-errors` does not emit `browser.error` yet (no logger in wave 0); `AI HERE` marks it.

Shared-file edits needed to make the gates pass: tsconfig `include` was `["src","scripts","tests"]` with `rootDir: "src"`, so typecheck died on `tests/`. Set build include to `["src"]`, added `tsconfig.test.json` (rootDir ".", noEmit, include src+tests+scripts), and pointed `typecheck` at both. No dependency added.

Gates, verbatim tails: `npm install` -> `added 186 packages` / `found 0 vulnerabilities` exit 0. `npm run typecheck` -> `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json`, no output, exit 0. `npm run build` -> `tsc -p tsconfig.json`, no output, exit 0. Extra: `npm test` 8 passed; `node dist/main.js` with `DATABASE_URL=postgres://dummy` served `/api/health` 200, 404 envelope, 413 and 204. `npx biome check` cannot run on this nix host (dynamically linked binary).

Not committed: `backend/` is untracked, nothing staged.
