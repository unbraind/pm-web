import { OidcFlowError } from "../oidc.ts";
declare const router: import("express-serve-static-core").Router;
/**
 * Map a provider-returned `error` query value to an {@link OidcFlowError}.
 *
 * `access_denied` becomes a 403 "login canceled/denied" error; any other
 * non-empty string becomes a generic provider error. An empty/non-string
 * value returns `null`, meaning "no provider error to report".
 *
 * @param value - The raw `error` query parameter from the callback.
 * @returns A flow error to throw, or `null` when there is none.
 */
export declare function providerAuthorizationError(value: unknown): OidcFlowError | null;
export { router as oidcRouter };
