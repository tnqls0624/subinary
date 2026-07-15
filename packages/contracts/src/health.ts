import { z } from 'zod';

/** A single dependency check result inside the readiness response. */
export const healthCheckItemSchema = z.object({
  name: z.string(),
  status: z.enum(['up', 'down']),
  detail: z.string().optional(),
  latencyMs: z.number().optional(),
});
export type HealthCheckItem = z.infer<typeof healthCheckItemSchema>;

/** `GET /v1/health/live` — liveness. No dependency checks. */
export const livezResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  timestamp: z.string(),
});
export type LivezResponse = z.infer<typeof livezResponseSchema>;

/**
 * `GET /v1/health/ready` — readiness with dependency checks.
 * Any `down` check turns `status` into `'degraded'` (served with HTTP 503).
 */
export const readyzResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.string(),
  timestamp: z.string(),
  checks: z.array(healthCheckItemSchema),
});
export type ReadyzResponse = z.infer<typeof readyzResponseSchema>;
