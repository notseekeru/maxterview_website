import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

export type ValidationIssue = { loc: (string | number)[]; msg: string };

export class HttpError extends Error {
    readonly status: ContentfulStatusCode;
    readonly detail: string | ValidationIssue[];

    constructor(status: ContentfulStatusCode, detail: string | ValidationIssue[]) {
        super(typeof detail === "string" ? detail : JSON.stringify(detail));
        this.name = "HttpError";
        this.status = status;
        this.detail = detail;
    }
}

// FastAPI's RequestValidationError puts the source in loc[0] ("body", "query", "path") and frontend/src/lib/api.ts drops it before rendering the field.
export function validationError(error: z.ZodError, source: "body" | "query" | "path" = "body"): HttpError {
    const issues: ValidationIssue[] = error.issues.map((issue) => ({ loc: [source, ...issue.path.map((part) => (typeof part === "symbol" ? String(part) : part))], msg: issue.message }));
    return new HttpError(422, issues);
}
