/**
 * Categories module (Phase 4 Build Spec §5.2).
 *
 * Registers {@link CategorySeedService} whose `onModuleInit` seeds the system
 * category catalogue (idempotent). The `DB` provider comes from the global
 * `DatabaseModule` and the global `AccessTokenGuard` (from `AuthModule` in
 * `AppModule`) governs the `/v1/categories` routes, so neither is re-imported
 * here. `CategoryService` is exported for reuse (slug → id resolution).
 */
import { Module } from '@nestjs/common';

import { CategorySeedService } from './category-seed.service';
import { CategoryController } from './category.controller';
import { CategoryService } from './category.service';

@Module({
  controllers: [CategoryController],
  providers: [CategoryService, CategorySeedService],
  exports: [CategoryService],
})
export class CategoriesModule {}
