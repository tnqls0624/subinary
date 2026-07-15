/** Injection token for the drizzle `Db` instance (PostgresJsDatabase). */
export const DB = 'DB' as const;

/** Internal token holding `{ db, client }` so the raw client can be closed on shutdown. */
export const DB_CONNECTION = 'DB_CONNECTION' as const;
