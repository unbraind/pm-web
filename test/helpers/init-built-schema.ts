/** Exercise the committed runtime schema initializer against the fixture database. */
import { initSchema, pool } from "../../dist/db.js";

try { await initSchema(); }
finally { await pool.end(); }
