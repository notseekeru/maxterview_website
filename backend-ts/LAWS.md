# LAWS

1. **Error envelope.** A handled error is `{detail: string}`. A request-validation 422 is `{detail: [{loc, msg}]}` because `frontend/src/lib/api.ts` reads `loc` and `msg` (it drops `body` from `loc` before rendering the field). An unknown route 404 is `{detail: "Not Found"}`. An unhandled exception is 500 `text/plain` "Internal Server Error", Starlette's behaviour, matched deliberately. `/api/client-errors` answers 413 and 422 with a string detail because `main.py` raises rather than validates.

2. **Log event names are frozen verbatim** from the Python source, e.g. `llm.feedback.moves_mismatch`. Never rename, never camelCase. They are Grafana query targets.

3. **Raw SQL stays raw.** `postgres.js` tagged templates, no ORM, no query builder.

4. **Migration filenames and bodies stay byte-identical** to the ported tree's `migrations/0022_*.sql`. The runner reads yoyo's existing `_yoyo_migration` history table.

5. **`latex.ts` spawns through `sh -c 'ulimit -v ...; ulimit -t ...; exec pdflatex ...'`.** Plain spawn is forbidden: Node has no `setrlimit` and the memory ceiling is the sandbox boundary.

6. **Config is read through `src/env.ts`** as a mutable object with a `reconfigure()` hook, never as frozen module constants. `tests/scaffold.test.ts` swaps `APP_ENV` at runtime through that hook.
