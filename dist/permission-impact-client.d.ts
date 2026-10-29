import { type PermissionImpactInput, type PermissionImpactPage } from './permission-impact.ts';
/** Authenticated consequence previews never send credentials to redirects or persist results. */
export declare class PermissionImpactClient {
    private readonly origin;
    private readonly token;
    /** Select an explicit HTTPS origin, with loopback HTTP permitted for development. */
    constructor(baseUrl: string, token: string);
    /** Inspect one existing share proposal after fresh server authorization; no apply method exists. */
    preview(project: string, raw: PermissionImpactInput): Promise<PermissionImpactPage>;
}
