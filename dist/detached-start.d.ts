import { type ChildProcess } from "node:child_process";
/** Start the built server and retain its handle only after its own listener is healthy. */
export declare function startDetached(serverPath: string, port: string, pidfile: string, timeout: number): Promise<ChildProcess>;
