/**
 * 데이터베이스 헬스체크 쿼리 (Phase 0 Build Spec §6.5).
 *
 * 두 함수 모두 throw 하지 않고 boolean을 반환한다 —
 * 호출부(HealthService)가 up/down 판정에 그대로 사용한다.
 * 실패 원인(에러 메시지)은 자격증명 등 민감정보를 포함할 수 있으므로
 * 이 계층에서 로그로 출력하지 않는다.
 */
import { sql } from 'drizzle-orm';

import type { Db } from './client.js';

/** `SELECT 1` 왕복으로 연결 상태를 확인한다. 성공 시 true. */
export async function checkConnection(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

/** `pg_extension`에 pgvector(`vector`) 확장이 설치되어 있는지 확인한다. */
export async function checkPgVector(db: Db): Promise<boolean> {
  try {
    const rows = await db.execute(sql`select 1 from pg_extension where extname = 'vector'`);
    return rows.length > 0;
  } catch {
    return false;
  }
}
