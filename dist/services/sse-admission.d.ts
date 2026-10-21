import type { Response } from "express";
/** Bound concurrent join queries and their waiting sockets independently of stream lifetime. */
export declare function createSSEAdmission(concurrency: number, maxPending: number): (res: Response) => Promise<(() => void) | null>;
