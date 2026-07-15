/**
 * Cards module (Phase 4 Build Spec §5.1).
 *
 * The `DB` provider comes from the global `DatabaseModule` and the global
 * `AccessTokenGuard` (from `AuthModule` in `AppModule`) governs the
 * `/v1/cards/*` routes, so neither is re-imported here. `CardService` is
 * exported for potential reuse by the transactions module (card auto-linking).
 */
import { Module } from '@nestjs/common';

import { CardController } from './card.controller';
import { CardService } from './card.service';

@Module({
  controllers: [CardController],
  providers: [CardService],
  exports: [CardService],
})
export class CardsModule {}
