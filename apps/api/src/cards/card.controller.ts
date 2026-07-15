/**
 * Payment-card HTTP surface (Phase 4 Build Spec §5.1).
 *
 * All routes require normal user authentication (the global
 * {@link AccessTokenGuard} runs — none are `@Public()`). The authenticated
 * principal is passed to the service as `actorUserId`; the service enforces
 * household membership and card ownership. Bodies and the `householdId` query
 * are validated by the global `ZodValidationPipe` against the
 * `@family/contracts` schemas wrapped as DTOs.
 */
import {
  Body,
  Controller,
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
  cardCreateRequestSchema,
  cardUpdateRequestSchema,
  type CardSummary,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { CardService } from './card.service';

class CardCreateDto extends createZodDto(cardCreateRequestSchema) {}
class CardUpdateDto extends createZodDto(cardUpdateRequestSchema) {}

/** `GET /v1/cards?householdId=` — the household scope is required. */
const cardListQuerySchema = z.object({ householdId: z.string().uuid() });
class CardListQueryDto extends createZodDto(cardListQuerySchema) {}

@Controller('cards')
export class CardController {
  constructor(private readonly cardService: CardService) {}

  /** GET /v1/cards?householdId=... — list a household's cards. */
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CardListQueryDto,
  ): Promise<CardSummary[]> {
    return this.cardService.list(user.userId, query.householdId);
  }

  /** POST /v1/cards — register a card (caller becomes its owner). */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CardCreateDto,
  ): Promise<CardSummary> {
    return this.cardService.create(user.userId, dto);
  }

  /** GET /v1/cards/:id — card summary for a member. */
  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<CardSummary> {
    return this.cardService.get(user.userId, id);
  }

  /** PATCH /v1/cards/:id — update alias/visibility/status (owner or owner/admin). */
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CardUpdateDto,
  ): Promise<CardSummary> {
    return this.cardService.update(user.userId, id, dto);
  }
}
