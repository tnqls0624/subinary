/** 헬스체크 전용 ioredis 클라이언트 주입 토큰 (BullMQ 내부 커넥션과 분리) */
export const REDIS_CLIENT = 'WORKER_HEALTH_REDIS_CLIENT';

/** health 응답의 service 필드 값 */
export const SERVICE_NAME = 'worker';
