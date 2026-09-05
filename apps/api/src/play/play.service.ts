/**
 * 플레이그라운드 미니앱의 진행 상태 저장소.
 *
 * **값의 뜻을 모르는 저장소다.** `state`는 자유 jsonb이고 서버는 크기와 키 형식만
 * 지킨다. 미니앱마다 모양이 다르고 자주 바뀌는데 저장소가 그 모양을 알면 게임 하나
 * 붙일 때마다 서버를 고쳐야 하고, 그러면 실험이 느려진다.
 *
 * 가구 단위로 격리한다 — 미니앱 상태는 가족이 함께 보는 진행이다. 멤버십 확인은
 * 모든 경로에서 한다(읽기 포함): 상태에는 사용자가 적은 값이 들어가고, 그것을 다른
 * 가구가 읽을 이유가 없다.
 */
import { Inject, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { schema, type Db } from '@family/database';
import type {
  PlayState,
  PlayStateSaveRequest,
} from '@family/contracts';
import { and, asc, eq } from 'drizzle-orm';

import { DB } from '../database/database.constants';

/**
 * 상태 크기 상한(바이트). DB CHECK와 **같은 값**이어야 한다 — 앱이 더 크게 받으면
 * DB가 거절해 500이 나고, 사용자는 "저장이 안 된다"만 본다.
 */
const MAX_STATE_BYTES = 8192;

@Injectable()
export class PlayService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 가구 멤버십 확인. 읽기에도 건다(상태에는 사용자가 적은 값이 들어간다). */
  private async requireMembership(
    householdId: string,
    userId: string,
  ): Promise<string> {
    const [member] = await this.db
      .select({ id: schema.householdMembers.id })
      .from(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.householdId, householdId),
          eq(schema.householdMembers.userId, userId),
          eq(schema.householdMembers.status, 'active'),
        ),
      )
      .limit(1);
    if (!member) throw new ForbiddenException('household membership required');
    return member.id;
  }

  private toSummary(row: schema.PlayState): PlayState {
    return {
      appKey: row.appKey,
      stateKey: row.stateKey,
      state: row.state as Record<string, unknown>,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** 한 미니앱의 상태 전부. 키 오름차순 — 월별 키(`2026-09`)가 자연스럽게 정렬된다. */
  async list(
    userId: string,
    householdId: string,
    appKey: string,
  ): Promise<PlayState[]> {
    await this.requireMembership(householdId, userId);
    const rows = await this.db
      .select()
      .from(schema.playStates)
      .where(
        and(
          eq(schema.playStates.householdId, householdId),
          eq(schema.playStates.appKey, appKey),
        ),
      )
      .orderBy(asc(schema.playStates.stateKey));
    return rows.map((row) => this.toSummary(row));
  }

  /**
   * 상태 저장(upsert). 같은 가구·미니앱·키는 하나뿐이다.
   *
   * 크기를 **앱에서 먼저** 잰다. DB CHECK에 맡기면 위반이 500으로 올라오고 사용자는
   * 이유를 알 수 없다.
   */
  async save(
    userId: string,
    appKey: string,
    stateKey: string,
    input: PlayStateSaveRequest,
  ): Promise<PlayState> {
    await this.requireMembership(input.householdId, userId);

    const bytes = Buffer.byteLength(JSON.stringify(input.state), 'utf8');
    if (bytes > MAX_STATE_BYTES) {
      throw new PayloadTooLargeException(
        `상태가 너무 큽니다(${bytes} > ${MAX_STATE_BYTES}바이트).`,
      );
    }

    const now = new Date();
    const [row] = await this.db
      .insert(schema.playStates)
      .values({
        householdId: input.householdId,
        appKey,
        stateKey,
        state: input.state,
        createdBy: userId,
      })
      .onConflictDoUpdate({
        target: [
          schema.playStates.householdId,
          schema.playStates.appKey,
          schema.playStates.stateKey,
        ],
        // `createdBy`도 갱신한다 — 이 값의 뜻은 "만든 사람"이 아니라 **마지막으로
        // 바꾼 사람**이고, 가족이 함께 쓰는 상태에서 유용한 것은 후자다.
        set: { state: input.state, createdBy: userId, updatedAt: now },
      })
      .returning();
    return this.toSummary(row as schema.PlayState);
  }

  /**
   * 상태 삭제. 없는 것을 지우면 `deleted: false` — 404가 아니다.
   *
   * "지웠다"와 "원래 없었다"는 사용자에게 같은 결과이고, 없는 것을 지우려 한 것이
   * 오류는 아니다(멱등).
   */
  async remove(
    userId: string,
    householdId: string,
    appKey: string,
    stateKey: string,
  ): Promise<boolean> {
    await this.requireMembership(householdId, userId);
    const deleted = await this.db
      .delete(schema.playStates)
      .where(
        and(
          eq(schema.playStates.householdId, householdId),
          eq(schema.playStates.appKey, appKey),
          eq(schema.playStates.stateKey, stateKey),
        ),
      )
      .returning({ id: schema.playStates.id });
    return deleted.length > 0;
  }
}
