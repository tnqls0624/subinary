/**
 * System-category seeder (Phase 4 Build Spec §5.2).
 *
 * On module init, upserts `DEFAULT_CATEGORIES` (`@family/shared`) as system
 * categories (`householdId = null`, `isSystem = true`). Idempotent: the insert
 * uses `onConflictDoNothing` against the partial unique index
 * `(slug) WHERE household_id IS NULL`, so re-running on every boot is a no-op
 * once the defaults exist. No PII is involved and none is logged.
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { isNull, sql } from 'drizzle-orm';

import { DEFAULT_CATEGORIES } from '@family/shared';
import { schema, type Db } from '@family/database';

import { DB } from '../database/database.constants';

@Injectable()
export class CategorySeedService implements OnModuleInit {
  private readonly logger = new Logger(CategorySeedService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  async onModuleInit(): Promise<void> {
    const rows: schema.NewExpenseCategory[] = DEFAULT_CATEGORIES.map(
      (category) => ({
        householdId: null,
        slug: category.slug,
        name: category.name,
        isSystem: true,
        isTransfer: category.isTransfer ?? false,
      }),
    );

    try {
      await this.db
        .insert(schema.expenseCategories)
        .values(rows)
        // `isTransfer`는 conflict 시에도 동기화한다 — `DEFAULT_CATEGORIES`가 SSOT여야
        // 기존 시스템 카테고리에 플래그를 소급 적용할 수 있다(신규 삽입만 하면 이미
        // 존재하는 카테고리는 영원히 false로 남는다). 시스템 카테고리는 사용자가 수정할
        // 수 없으므로(category.service가 403) 덮어써도 사용자 편집을 잃지 않는다.
        .onConflictDoUpdate({
          target: schema.expenseCategories.slug,
          targetWhere: isNull(schema.expenseCategories.householdId),
          set: { isTransfer: sql`excluded.is_transfer` },
        });
      this.logger.log(
        `system expense categories ensured (${rows.length} defaults)`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`failed to seed system expense categories: ${message}`);
      throw error;
    }
  }
}
