/**
 * 금액 런타임 전용 Redis 클라이언트 토큰(worker).
 *
 * BullMQ의 연결을 빌리지 않는 이유: `@nestjs/bullmq`가 만든 연결은 큐 전용이고,
 * 그 연결로 일반 키를 읽는 것은 수명·재시도 정책을 큐와 공유하게 만든다. 전환
 * 스위치는 큐보다 오래 살아야 하므로 자기 연결을 갖는다.
 */
export const MONEY_REDIS_CLIENT = 'MONEY_REDIS_CLIENT' as const;
