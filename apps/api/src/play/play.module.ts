import { Module } from '@nestjs/common';

import { PlayController } from './play.controller';
import { PlayService } from './play.service';

@Module({
  controllers: [PlayController],
  providers: [PlayService],
})
export class PlayModule {}
