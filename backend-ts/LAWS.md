# LAWS

The port's contract. A later agent obeys these; changing one is a wave-0 decision, not an edit.

1. **Error envelope.** A handled error is `{detail: string}`. A request-validation 422 is `{detail: [{loc, msg}]}` because `frontend/src/lib/api.ts` reads `loc` and `msg` (it drops `body` from `loc` before rendering the field). An unknown route 404 is `{detail: "Not Found"}`. An unhandled exception is 500 `text/plain` "Internal Server Error", Starlette's behaviour, matched deliberately. `/api/client-errors` answers 413 and 422 with a string detail because `main.py` raises rather than validates.

2. **Log event names are frozen verbatim** from the Python source, e.g. `llm.feedback.moves_mismatch`. Never rename, never camelCase. They are Grafana query targets.

3. **Raw SQL stays raw.** `postgres.js` tagged templates, no ORM, no query builder.

4. **Migration filenames and bodies stay byte-identical** to `backend/migrations/0022_*.sql`. The runner reads yoyo's existing `_yoyo_migration` history table.

5. **`latex.ts` spawns through `sh -c 'ulimit -v ...; ulimit -t ...; exec pdflatex ...'`.** Plain spawn is forbidden: Node has no `setrlimit` and the memory ceiling is the sandbox boundary.

6. **File names mirror Python 1:1** (`app/llm.py` to `src/llm.ts`) so a reviewer can diff them. Route modules are mounted at `/` and declare absolute paths, matching `main.py`'s flat `@api.<verb>("/path")` surface.

7. **Shared files are wave-0 owned:** `package.json`, `tsconfig.json`, `src/app.ts`, `vitest.config.ts`. A later agent needing a change reports it instead of editing.

8. **Config is read through `src/env.ts`** as a mutable object with a `reconfigure()` hook, never as frozen module constants. `backend/tests/test_api.py` swaps `APP_ENV` at runtime and that test must port.

9. **Every agent hands back a report of at most 20 lines**, bound to `reports/<name>.md`.

10. **Code comments only where they state a constraint or a trap.** No narrative comments.

11. **Auth honours `x-dev-sub` in development and test** when it matches `[A-Za-z0-9._:-]{1,128}`; otherwise 400 with detail "Invalid X-Dev-Sub". It is ignored when `APP_ENV` is production.
