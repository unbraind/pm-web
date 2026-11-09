/**
 * Whether the built-in storage notice must be shown.
 *
 * Reads `PM_WEB_STORAGE_NOTICE` from the given environment (defaulting to
 * `process.env` so the value is resolved per request, matching how other
 * tunables such as the idempotency windows are read). Only the exact value
 * `off` (case-insensitive, surrounding whitespace ignored) disables the
 * notice; every other value — unset, `on`, or anything unrecognized — keeps
 * it enabled. A conservative parse is deliberate: an invalid value must
 * never silently hide a legal notice, and the client independently falls
 * back to "shown" when the config read fails.
 *
 * @param env - Environment to read `PM_WEB_STORAGE_NOTICE` from; defaults to
 *   `process.env` so tests can inject a controlled environment.
 * @returns `true` when the built-in storage notice is enabled.
 */
export declare function storageNoticeEnabled(env?: NodeJS.ProcessEnv): boolean;
/**
 * Unauthenticated UI configuration surface: a single GET returning
 * `{ storageNotice: boolean }`.
 *
 * Mounted under the static-asset rate tier: every page load of the SPA and
 * the standalone legal pages fetches it once, so it belongs in the same
 * per-IP budget as other unauthenticated reads, not in the tight auth tier.
 * No authentication is required by design — the value is not sensitive and
 * must be readable before sign-in (the notice is shown on the auth screen).
 */
export declare const uiConfigRouter: import("express-serve-static-core").Router;
