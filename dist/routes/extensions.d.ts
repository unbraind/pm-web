import { readMaintenanceCapabilities } from "../services/maintenance-providers.ts";
import { Router } from "express";
import { type PackageCatalogEntry } from "../services/package-catalog.ts";
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
/** Capability-read outcome, independent of package inventory and edit permission. */
export type MaintenanceCapabilitiesStatus = {
    status: "available";
} | {
    status: "unavailable";
    error: {
        code: "capabilities_unavailable";
        message: string;
    };
};
/** Build the project package router with an independently wired capability reader. */
export declare function createExtensionsRouter(readCapabilities?: typeof readMaintenanceCapabilities): Router;
/** Default project package router using real command ownership reads. */
export declare const extensionsRouter: Router;
