/**
 * 금액 런타임 전용 Redis 클라이언트 토큰.
 *
 * health의 클라이언트를 빌리지 않는 이유: 그쪽은 헬스체크용으로 `commandTimeout` 3초 ·
 * `maxRetriesPerRequest` 1로 조여 둔 클라이언트이고 모듈 밖으로 export되지도 않는다.
 * 펜스 조회는 **요청 경로**에 있으므로 수명·타임아웃을 이 모듈이 직접 정한다.
 */
export const MONEY_REDIS_CLIENT = 'MONEY_REDIS_CLIENT' as const;
