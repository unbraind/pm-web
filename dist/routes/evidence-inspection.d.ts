import type { Router } from 'express';
/** Mount live read-only inspection before generic mutation dispatch; authorization is refreshed per call. */
export declare function registerEvidenceInspectionRoutes(router: Router): void;
