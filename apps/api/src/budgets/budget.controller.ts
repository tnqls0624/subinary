/**
 * Budget HTTP surface (Phase 5 Build Spec §5.2).
 *
 * All routes require a normal user access token (the global
 * {@link AccessTokenGuard} runs — none are `@Public()`). The authenticated
 * principal is passed to the service as the actor `userId`; the service enforces
 * household membership, the owner/admin role for mutations, and the visibility
 * scope for usage aggregation (PRD §7.2/§26). Request bodies and the query are
 * validated by the global `ZodValidationPipe` against the `@family/contracts`
 * schemas wrapped as DTOs.
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
  budgetCreateRequestSchema,
  budgetUpdateRequestSchema,
  type BudgetListResponse,
  type BudgetSummary,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { BudgetService } from './budget.service';

class BudgetCreateDto extends createZodDto(budgetCreateRequestSchema) {}
class BudgetUpdateDto extends createZodDto(budgetUpdateRequestSchema) {}

/** `GET /v1/budgets?householdId=&month=` — household required, month optional. */
const budgetListQuerySchema = z.object({
  householdId: z.string().uuid(),
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be in YYYY-MM format')
    .optional(),
});
class BudgetListQueryDto extends createZodDto(budgetListQuerySchema) {}

@Controller('budgets')
export class BudgetController {
  constructor(private readonly budgetService: BudgetService) {}

  /**
   * GET /v1/budgets?householdId=&month= — list a household's budgets with each
   * scope's current-month usage (any active member).
   */
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BudgetListQueryDto,
  ): Promise<BudgetListResponse> {
    return this.budgetService.list(user.userId, {
      householdId: query.householdId,
      month: query.month,
    });
  }

  /** POST /v1/budgets — create a budget (owner/admin). */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BudgetCreateDto,
  ): Promise<BudgetSummary> {
    return this.budgetService.create(user.userId, dto);
  }

  /** PATCH /v1/budgets/:id — update name/amount (owner/admin). */
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: BudgetUpdateDto,
  ): Promise<BudgetSummary> {
    return this.budgetService.update(user.userId, id, dto);
  }

  /** DELETE /v1/budgets/:id — delete a budget (owner/admin). */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.budgetService.delete(user.userId, id);
  }
}
