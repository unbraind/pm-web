import { type PackageCatalogEntry } from "../services/package-catalog.ts";
declare const router: import("express-serve-static-core").Router;
/** The realtime event type broadcast on every successful extension mutation. */
export declare const EXTENSIONS_CHANGED_EVENT = "extensions-changed";
/** The catalog entry joined with its live per-project state, for the GET list. */
export interface PackageCatalogRow extends PackageCatalogEntry {
    installed: boolean;
    version: string | null;
    active: boolean;
    enabled: boolean;
    runtimeActive: boolean;
    activationStatus: string | null;
    managed: boolean;
    sourceKind: string | null;
}
export { router as extensionsRouter };
