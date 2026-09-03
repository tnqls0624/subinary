/**
 * OTA 웹 번들 HTTP 표면 (@capgo/capacitor-updater 자체 호스팅).
 *
 * 두 라우트가 전부이고 **둘 다 인증이 없다.** 앱은 로그인 전에도, 세션이 만료된 뒤에도
 * 업데이트를 받아야 한다 — 인증을 걸면 "로그인이 깨지는 버그를 고친 번들"을 받을 수
 * 없게 되어, 정확히 필요한 순간에 못 쓰는 장치가 된다.
 *
 * 인증이 없어도 새는 것이 없다: 번들은 이미 앱 스토어/사이드로드로 배포되는 **공개
 * 프런트엔드 자산**이고, 개인 데이터는 전부 인증된 `/v1/*` API 뒤에 있다. 대신 경로
 * 순회는 서비스에서 두 겹으로 막는다.
 */
import { createReadStream } from 'node:fs';

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { Public } from '../auth/decorators/public.decorator';
import { OtaService, type OtaUpdateResponse } from './ota.service';

/**
 * 플러그인이 보내는 `AppInfos`. 필요한 것은 `version_name` 하나뿐이라 나머지는
 * 받아만 두고 쓰지 않는다 — 스키마로 좁히면 플러그인이 필드를 늘릴 때마다 400이 난다.
 */
interface AppInfosBody {
  version_name?: string;
  platform?: string;
  device_id?: string;
}

@Controller('ota')
export class OtaController {
  constructor(private readonly otaService: OtaService) {}

  /**
   * POST /v1/ota/updates — 업데이트 확인.
   *
   * 응답 모양은 플러그인이 정한다: `{version, url, checksum}` 또는
   * `{message:'Version not found'}`. 후자는 **에러가 아니다** — 최신이라는 뜻이라
   * 200으로 답한다.
   */
  @Public()
  @Post('updates')
  @HttpCode(HttpStatus.OK)
  updates(@Body() body: AppInfosBody): Promise<OtaUpdateResponse> {
    return this.otaService.resolveUpdate(body?.version_name, body?.platform);
  }

  /**
   * GET /v1/ota/bundle/:file — zip 다운로드.
   *
   * `Content-Length`를 반드시 싣는다. 플러그인이 진행률을 계산하고, 없으면 일부
   * 네트워크에서 chunked 응답을 조기 종료로 오인한다.
   */
  @Public()
  @Get('bundle/:file')
  async bundle(
    @Param('file') file: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { stream, size, name } = await this.otaService.openBundle(file);
    reply
      .header('content-type', 'application/zip')
      .header('content-length', size)
      // 번들은 파일명에 버전이 박혀 불변이다 — 오래 캐시해도 안전하고, 재다운로드를
      // 줄이는 편이 모바일 데이터에 낫다.
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('content-disposition', `attachment; filename="${name}"`);
    return reply.send(stream as ReturnType<typeof createReadStream>);
  }

  /**
   * GET /v1/ota/manifest — 현재 배포된 번들이 무엇인지(운영 확인용).
   *
   * 앱은 쓰지 않는다. 배포 후 "정말 갱신됐나"를 눈으로 보는 창구다 — 그게 없으면
   * 앱을 열어 보는 것 말고 확인할 방법이 없다.
   */
  @Public()
  @Get('manifest')
  async manifest(): Promise<{ deployed: boolean; version?: string; checksum?: string }> {
    const manifest = await this.otaService.readManifest();
    return manifest
      ? { deployed: true, version: manifest.version, checksum: manifest.checksum }
      : { deployed: false };
  }
}
