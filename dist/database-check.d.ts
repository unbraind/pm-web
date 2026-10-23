/** Schema revision recorded after all idempotent startup migrations complete. */
export declare const DATABASE_SCHEMA_VERSION = 2;
/** Diagnose configuration, connectivity and schema without changing the database. */
export declare function checkDatabase(): Promise<{
    name: string;
    ok: boolean;
    detail: string;
}>;
