import { Module } from '@nestjs/common';

import { OtaController } from './ota.controller';
import { OtaService } from './ota.service';

/** OTA 웹 번들 배포(@capgo/capacitor-updater 자체 호스팅). DB에 의존하지 않는다. */
@Module({
  controllers: [OtaController],
  providers: [OtaService],
})
export class OtaModule {}
