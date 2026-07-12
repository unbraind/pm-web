import { OidcFlowError } from "../oidc.js";
declare const router: import("express-serve-static-core").Router;
export declare function providerAuthorizationError(value: unknown): OidcFlowError | null;
export { router as oidcRouter };
