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
import { isNull } from 'drizzle-orm';

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
      }),
    );

    try {
      await this.db
        .insert(schema.expenseCategories)
        .values(rows)
        .onConflictDoNothing({
          target: schema.expenseCategories.slug,
          where: isNull(schema.expenseCategories.householdId),
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
