/** Injection token for the ioredis client dedicated to health checks. */
export const REDIS_HEALTH_CLIENT = 'REDIS_HEALTH_CLIENT' as const;

/** Service name reported by health endpoints. */
export const SERVICE_NAME = 'api' as const;
