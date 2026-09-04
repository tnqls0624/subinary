/**
 * 가맹점 아이덴티티 HTTP 표면 — 목록 조회 + 별칭 등록/해제.
 *
 * 전 라우트가 일반 사용자 access token(전역 {@link AccessTokenGuard})을 요구하고,
 * 가구 멤버십/역할은 서비스 계층이 강제한다. body/query 검증은 전역
 * `ZodValidationPipe`가 `@family/contracts` 스키마로 수행한다.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  merchantAliasCreateRequestSchema,
  merchantIdentityRejectRequestSchema,
  type MerchantAliasCreateResponse,
  type MerchantAliasDeleteResponse,
  type MerchantIdentityRejectResponse,
  type MerchantListResponse,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { MerchantService } from './merchant.service';

const merchantListQuerySchema = z.object({ householdId: z.string().uuid() });
class MerchantListQueryDto extends createZodDto(merchantListQuerySchema) {}
class MerchantAliasCreateDto extends createZodDto(
  merchantAliasCreateRequestSchema,
) {}
class MerchantIdentityRejectDto extends createZodDto(
  merchantIdentityRejectRequestSchema,
) {}

@Controller('merchants')
export class MerchantController {
  constructor(private readonly merchantService: MerchantService) {}

  /** GET /v1/merchants?householdId=... — 지출 큰 순 가맹점 목록(별칭·카테고리 포함). */
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MerchantListQueryDto,
  ): Promise<MerchantListResponse> {
    return this.merchantService.listMerchants(user.userId, query.householdId);
  }

  /** POST /v1/merchants/aliases — "이 이름들은 같은 가게" 확정 + 과거 데이터 백필. */
  @Post('aliases')
  @HttpCode(HttpStatus.CREATED)
  createAliases(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MerchantAliasCreateDto,
  ): Promise<MerchantAliasCreateResponse> {
    return this.merchantService.createAliases(user.userId, dto);
  }

  /**
   * POST /v1/merchants/identity-feedback — "이 이름들은 같은 가게가 아니다".
   *
   * **상태를 바꾸지 않는다.** append-only 판단만 남기고, 그것이 다음 제안을 거른다.
   * 확정은 이 경로가 아니라 `POST aliases`가 처리한다(사실을 만드는 쪽에서 함께
   * 기록해야 하나가 실패했을 때 상태가 갈리지 않는다).
   */
  @Post('identity-feedback')
  @HttpCode(HttpStatus.CREATED)
  rejectIdentity(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MerchantIdentityRejectDto,
  ): Promise<MerchantIdentityRejectResponse> {
    return this.merchantService.rejectIdentityCandidate(user.userId, dto);
  }

  /** DELETE /v1/merchants/aliases/:id — 별칭 해제 + 해당 거래 원복. */
  @Delete('aliases/:id')
  deleteAlias(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<MerchantAliasDeleteResponse> {
    return this.merchantService.deleteAlias(user.userId, id);
  }
}
