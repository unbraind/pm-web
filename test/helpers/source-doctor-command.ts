/** Probe the source database diagnostic against real PostgreSQL without a loader snapshot. */
import { checkDatabase } from "../../src/database-check.ts";
console.log(JSON.stringify(await checkDatabase()));
