/**
 * Category HTTP surface (Phase 4 Build Spec §5.2, extended with custom-category CRUD).
 *
 * All routes require a normal user access token (global {@link AccessTokenGuard}).
 * The authenticated principal is passed to the service, which enforces household
 * membership for reads/writes and blocks mutating system categories. Bodies/query
 * are validated by the global `ZodValidationPipe` against `@family/contracts`.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  categoryCreateRequestSchema,
  categoryUpdateRequestSchema,
  type CategorySummary,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { CategoryService } from './category.service';

/** `GET /v1/categories?householdId=` — the household scope is required. */
const categoryListQuerySchema = z.object({ householdId: z.string().uuid() });
class CategoryListQueryDto extends createZodDto(categoryListQuerySchema) {}
class CategoryCreateDto extends createZodDto(categoryCreateRequestSchema) {}
class CategoryUpdateDto extends createZodDto(categoryUpdateRequestSchema) {}

@Controller('categories')
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  /** GET /v1/categories?householdId=... — system + household categories. */
  @Get()
  list(@Query() query: CategoryListQueryDto): Promise<CategorySummary[]> {
    return this.categoryService.listCategories(query.householdId);
  }

  /** POST /v1/categories — create a household custom category (any active member). */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CategoryCreateDto,
  ): Promise<CategorySummary> {
    return this.categoryService.createCategory(user.userId, dto);
  }

  /** PATCH /v1/categories/:id — rename a household custom category. */
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CategoryUpdateDto,
  ): Promise<CategorySummary> {
    return this.categoryService.updateCategory(user.userId, id, dto);
  }

  /** DELETE /v1/categories/:id — delete a custom category (reverts its txns to 미분류). */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.categoryService.deleteCategory(user.userId, id);
  }
}
