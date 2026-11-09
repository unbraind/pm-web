// ═══════════════════════════════════════════════════════════════
// UI CONFIG ROUTES — unauthenticated client configuration
// ═══════════════════════════════════════════════════════════════
//
// pm-web ships a minimal built-in storage notice (public/index.html
// `#cookie-consent`, driven by public/src/cookie-consent.ts). Operators who
// run their own consent manager at the reverse proxy — an edge-injected
// banner plus consent-gated analytics — must be able to switch that built-in
// notice off, so visitors never see two banners and the package text never
// contradicts the operator's deployment.
//
// The switch is the `PM_WEB_STORAGE_NOTICE` environment variable (`on`,
// the default, or `off`). The banner is a classic script without the SPA's
// `api()` wrapper and it also runs on the standalone legal pages, so the
// smallest supported exposure is one unauthenticated JSON endpoint the
// script can fetch. It returns a single boolean and nothing else: no
// operator-specific names, hosts, cookie names, or vendors, so the public
// package stays usable by any self-hoster.
import { Router } from "express";
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
export function storageNoticeEnabled(env = process.env) {
    return env.PM_WEB_STORAGE_NOTICE?.trim().toLowerCase() !== "off";
}
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
export const uiConfigRouter = Router();
uiConfigRouter.get("/", (_req, res) => {
    res.json({ storageNotice: storageNoticeEnabled() });
});
//# sourceMappingURL=ui-config.js.map