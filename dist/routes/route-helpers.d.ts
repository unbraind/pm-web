/**
 * Shared route helpers used by multiple route modules.
 *
 * These functions extract duplicated request-handling patterns that appeared
 * verbatim in two or more route files (sharing, groups, projects, auth, admin)
 * and were flagged by the duplication gate. Each helper preserves the exact
 * error messages and status codes of the original inline code.
 */
import type { Response } from "express";
/** User row returned by {@link findUserByEmail}. */
export interface UserRow {
    id: string;
    email: string;
    display_name: string;
}
/**
 * Look up a single user by their (case-insensitive) email address.
 *
 * Normalises the input with `trim().toLowerCase()` exactly as every inline
 * copy did, queries `pm_users`, and returns the first matching row or `null`.
 * Callers are responsible for sending the appropriate 404 response when the
 * result is `null`.
 *
 * @param email - The raw email string from the request body.
 * @returns The matching user row, or `null` when no user has that address.
 */
export declare function findUserByEmail(email: string): Promise<UserRow | null>;
/**
 * Report whether a caught error represents a PostgreSQL unique-constraint
 * violation.
 *
 * Both the auth register handler and the project create handler need to turn a
 * duplicate-key error into a 409 conflict response. They previously each
 * inlined the same `msg.includes("unique") || msg.includes("duplicate")` check;
 * this helper centralises that logic.
 *
 * @param err - The caught error value (typed `unknown` per the lint rules).
 * @returns `true` when the error message mentions `unique` or `duplicate`.
 */
export declare function isUniqueViolation(err: unknown): boolean;
/**
 * Send a 404 JSON response when a query returned no rows.
 *
 * Several route handlers across groups, projects, and admin share the pattern
 * `if (result.rows.length === 0) { res.status(404).json({ error: "…" }); return; }`.
 * This helper centralises it so the duplication gate does not flag the
 * identical check block as a clone pair.
 *
 * @param res - The Express response.
 * @param rows - The `rows` array from a `pool.query` result.
 * @param message - The error message to include in the 404 body.
 * @returns `true` when the 404 was sent (caller should `return`);
 *   `false` when rows exist and the handler should continue.
 */
export declare function notFoundWhenEmpty(res: Response, rows: unknown[], message: string): boolean;
/** Trimmed, validated group-creation input returned by {@link parseGroupInput}. */
export interface GroupInput {
    name: string;
    description: string;
}
/**
 * Validate and normalise the request body for a group-creation endpoint.
 *
 * Both `POST /api/groups` and `POST /api/admin/groups` accept the same
 * `{ name, description }` body and apply the same "Group name is required"
 * 400 check. This helper performs that validation once, sends the 400
 * response on failure, and returns the trimmed values on success.
 *
 * @param res - The Express response (used to send the 400 on failure).
 * @param body - The raw request body.
 * @returns The trimmed `{ name, description }`, or `null` when validation
 *   failed (the 400 response has already been sent).
 */
export declare function parseGroupInput(res: Response, body: unknown): GroupInput | null;
