/**
 * Category HTTP surface (Phase 4 Build Spec §5.2).
 *
 * Requires normal user authentication (the global {@link AccessTokenGuard}
 * runs). The `householdId` query is validated by the global `ZodValidationPipe`
 * and scopes the listing to system categories plus that household's custom
 * ones (Phase 4: system only).
 */
import { Controller, Get, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { CategorySummary } from '@family/contracts';

import { CategoryService } from './category.service';

/** `GET /v1/categories?householdId=` — the household scope is required. */
const categoryListQuerySchema = z.object({ householdId: z.string().uuid() });
class CategoryListQueryDto extends createZodDto(categoryListQuerySchema) {}

@Controller('categories')
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  /** GET /v1/categories?householdId=... — system + household categories. */
  @Get()
  list(@Query() query: CategoryListQueryDto): Promise<CategorySummary[]> {
    return this.categoryService.listCategories(query.householdId);
  }
}
