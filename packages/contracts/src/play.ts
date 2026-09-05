import { z } from 'zod';

/**
 * 플레이그라운드 미니앱의 진행 상태 계약.
 *
 * ## 저장소는 값의 뜻을 모른다
 *
 * `state`는 자유 jsonb다. 미니앱마다 모양이 다르고 자주 바뀌는데, 저장소가 그 모양을
 * 알면 게임 하나 붙일 때마다 계약과 마이그레이션을 고쳐야 한다. 그러면 실험이 느려지고,
 * 실험이 느리면 안 쓰일 기능을 미리 설계하게 된다.
 *
 * **대신 모양 검증은 미니앱 코드가 한다.** 예측 게임의 `{amount, decidedAt}`은
 * `apps/web/src/lib/forecast.ts`가 파싱하고, 깨진 값을 만나면 "기록 없음"으로 다룬다 —
 * 저장소가 지키는 것은 크기와 키 형식뿐이다.
 *
 * ## 왜 가구 단위인가
 *
 * "우리 이번 달 얼마 쓸까"는 가족이 함께 답하는 질문이다. 개인별로 나누면 같은 화면을
 * 보는 두 사람이 서로 다른 진행을 본다. 개인 상태가 필요해지면 그때 축을 더한다.
 */

/** 미니앱 식별자·상태 키의 공통 제약 — DB CHECK와 같은 값이다. */
const keySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  // 경로에 그대로 실리므로 슬래시·공백을 막는다. 키가 경로를 벗어나면 라우팅이 깨진다.
  .regex(/^[A-Za-z0-9_-]+$/, '영문·숫자·_·- 만 쓸 수 있어요');

export const playAppKeySchema = keySchema;
export const playStateKeySchema = keySchema;

/** `PUT /v1/play/:appKey/:stateKey` */
export const playStateSaveRequestSchema = z.object({
  householdId: z.string().uuid(),
  /**
   * 미니앱이 정한 모양의 값. 서버는 뜻을 모르고 크기만 본다(8KB).
   *
   * `null`을 허용하지 않는 이유: "값이 없음"은 저장이 아니라 **삭제**이고, 그것은
   * DELETE가 표현한다. null을 저장할 수 있으면 "적었는데 비운 것"과 "안 적은 것"이
   * 같은 모양이 되어 미니앱이 둘을 구분할 수 없다.
   */
  state: z.record(z.string(), z.unknown()),
});
export type PlayStateSaveRequest = z.infer<typeof playStateSaveRequestSchema>;

export const playStateSchema = z.object({
  appKey: z.string(),
  stateKey: z.string(),
  state: z.record(z.string(), z.unknown()),
  updatedAt: z.string(),
});
export type PlayState = z.infer<typeof playStateSchema>;

/** `GET /v1/play/:appKey` — 그 미니앱의 상태 전부(키 오름차순). */
export const playStateListResponseSchema = z.object({
  items: z.array(playStateSchema),
});
export type PlayStateListResponse = z.infer<typeof playStateListResponseSchema>;

/** `DELETE /v1/play/:appKey/:stateKey` */
export const playStateDeleteResponseSchema = z.object({
  deleted: z.boolean(),
});
export type PlayStateDeleteResponse = z.infer<
  typeof playStateDeleteResponseSchema
>;
