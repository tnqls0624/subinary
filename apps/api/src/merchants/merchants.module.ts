/**
 * 가맹점 아이덴티티 모듈 — `merchant_aliases` CRUD와 가맹점 목록.
 *
 * `DB`는 전역 `DatabaseModule`에서, `/v1/merchants` 라우트 보호는 전역
 * `AccessTokenGuard`(AppModule의 `AuthModule`)가 담당하므로 여기서 재import하지
 * 않는다(다른 도메인 모듈과 동일한 관례).
 */
import { Module } from '@nestjs/common';

import { MerchantController } from './merchant.controller';
import { MerchantService } from './merchant.service';

@Module({
  controllers: [MerchantController],
  providers: [MerchantService],
  exports: [MerchantService],
})
export class MerchantsModule {}
