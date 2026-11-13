declare const router: import("express-serve-static-core").Router;
/**
 * Map a project read failure to its client status and public body. SDK expected errors are recognised by
 * structure as well as by class, so a separately installed SDK copy still maps to 404 or 400.
 * @param error - The failure raised by authorization or the scoped SDK read.
 * @returns The status and body, or undefined when the failure is an unavailable read (503).
 * @internal
 */
export declare function projectReadFailure(error: unknown): {
    status: number;
    body: {
        error: string;
    };
} | undefined;
export { router as pmRouter };
