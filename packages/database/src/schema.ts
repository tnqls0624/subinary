/**
 * Drizzle 스키마 배럴 (Phase 0 Build Spec §6.5).
 *
 * Phase 0에서는 의도적으로 비어 있다 — 도메인 테이블 없음.
 *
 * Phase 1+에서 도메인 테이블(예: households, members, memories,
 * transactions, embeddings 등)을 이 파일(또는 ./schema/ 하위 모듈)에
 * 정의하고 여기서 재-export 한다. 예:
 *
 *   export * from './schema/households';
 *   export * from './schema/members';
 *
 * 참고:
 * - pgvector 확장은 infrastructure/postgres/init/01-extensions.sql 이 생성하므로
 *   마이그레이션에서 확장 생성을 다루지 않는다.
 * - 금액 컬럼은 KRW 정수(integer/bigint), 시각 컬럼은 UTC 저장 후
 *   표시 시 Asia/Seoul 변환 원칙을 따른다.
 */
export {};
