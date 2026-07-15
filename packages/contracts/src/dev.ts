import { z } from 'zod';

/** `POST /v1/dev/test-job` — enqueue a BullMQ test job. */
export const testJobEnqueueResponseSchema = z.object({
  jobId: z.string(),
  queue: z.string(),
  status: z.string(),
});
export type TestJobEnqueueResponse = z.infer<typeof testJobEnqueueResponseSchema>;

/** `GET /v1/dev/test-job/:id` — test job state/result. */
export const testJobStatusResponseSchema = z.object({
  jobId: z.string(),
  state: z.string(),
  result: z.unknown().optional(),
  failedReason: z.string().optional(),
});
export type TestJobStatusResponse = z.infer<typeof testJobStatusResponseSchema>;

/** `POST /v1/dev/storage-test` — object storage put/get round trip. */
export const storageTestResponseSchema = z.object({
  ok: z.boolean(),
  bucket: z.string(),
  key: z.string(),
  roundTripMs: z.number(),
});
export type StorageTestResponse = z.infer<typeof storageTestResponseSchema>;
