/**
 * OTA 웹 번들 배포 — 자체 호스팅 (@capgo/capacitor-updater).
 *
 * ## 왜 자체 호스팅인가
 *
 * 앱은 `webDir`에 구운 정적 번들로 돌아간다(오프라인 셸). 웹만 바뀐 릴리스마다
 * Xcode/Gradle 재빌드를 하는 것이 실제 병목이었다. `server.url`로 원격을 직접 로드하면
 * 재빌드는 없어지지만 WebView origin이 바뀌어 **네이티브 인증 판정이 무너진다**
 * (`isTrustedNativeClient`가 origin으로 확인한다 — capacitor.config.ts 주석 참고).
 *
 * OTA는 origin을 그대로 두고 **웹 자산만** 교체한다. 그래서 인증·생체인식·1년 세션이
 * 하나도 안 바뀐다.
 *
 * ## Capgo 클라우드를 쓰지 않는다
 *
 * 플러그인의 기본 `updateUrl`/`statsUrl`은 Capgo 서버를 향한다. 가족 2인 앱의 기기
 * 정보를 외부로 보낼 이유가 없어 `statsUrl`/`channelUrl`을 빈 문자열로 끄고
 * `updateUrl`을 이 API로 돌렸다.
 *
 * ## 프로토콜 (플러그인이 정한 모양)
 *
 * 앱이 `POST /v1/ota/updates`에 자기 정보(`version_name`·`platform`·`device_id` …)를
 * 보내고, 서버는 둘 중 하나로 답한다.
 *
 *   - 새 번들 있음: `{ version, url, checksum }`
 *   - 없음:         `{ message: 'Version not found', version }`
 *
 * `checksum`은 **zip의 SHA256**이다. 플러그인이 다운로드 후 대조하므로, 이 값이 틀리면
 * 앱은 번들을 버린다 — 전송 중 손상과 잘못된 파일 배치를 둘 다 잡는다.
 *
 * ## 저장소
 *
 * 매니페스트와 zip은 컨테이너에 마운트된 디렉토리(`OTA_BUNDLE_DIR`)에 둔다. DB에 넣지
 * 않는 이유: 번들은 수십 MB 바이너리이고 롤백은 "옛 zip을 다시 가리키기"라 파일이
 * 자연스러운 단위다. 배포 스크립트가 zip을 넣고 매니페스트를 갱신한다.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';

/** 매니페스트 파일 이름. 배포 스크립트가 이 이름으로 쓴다. */
const MANIFEST_FILE = 'manifest.json';
/** zip이 놓이는 하위 디렉토리. */
const BUNDLE_SUBDIR = 'bundles';

/** 매니페스트 모양. 배포 스크립트와 이 서비스만 읽고 쓴다. */
interface OtaManifest {
  /** semver. 플러그인이 설치된 번들 버전과 문자열 비교한다. */
  version: string;
  /** `bundles/` 안의 파일명. 경로가 아니라 **이름만** 둔다(순회 방지). */
  file: string;
  /** zip의 SHA256(hex). 플러그인이 다운로드 후 대조한다. */
  checksum: string;
  /** 사람이 읽을 배포 메모(선택). */
  note?: string;
}

export interface OtaUpdateResponse {
  version?: string;
  url?: string;
  checksum?: string;
  message?: string;
}

@Injectable()
export class OtaService {
  private readonly logger = new Logger(OtaService.name);
  private readonly bundleDir: string;
  private readonly publicBaseUrl: string;

  constructor() {
    this.bundleDir = process.env.OTA_BUNDLE_DIR ?? '/srv/ota';
    // 다운로드 URL은 **절대 URL**이어야 한다(네이티브가 받는다). 앱 origin은
    // capacitor://localhost라 상대 경로를 쓰면 자기 자신을 가리킨다.
    //
    // config 스키마를 거치지 않고 env를 직접 읽는 이유: `PUBLIC_BASE_URL`은 배포
    // 도메인이라 앱 설정(포트·TZ)과 성격이 다르고, 그 스키마에 이미 없다. 없으면
    // 아래 resolveUpdate가 업데이트를 내려주지 않는다(조용히 깨진 URL을 주는 대신).
    this.publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  }

  /**
   * 앱의 업데이트 확인에 답한다.
   *
   * 매니페스트가 없으면 "없음"이다 — 에러가 아니다. OTA를 아직 한 번도 배포하지 않은
   * 상태가 정상이고, 그때 500을 내면 앱이 매번 실패를 재시도한다.
   */
  async resolveUpdate(
    currentVersion?: string,
    platform?: string,
  ): Promise<OtaUpdateResponse> {
    const manifest = await this.readManifest();
    // 요청을 남긴다. Caddy는 access log가 꺼져 있어 warn만 기록하므로, 이 줄이 없으면
    // "앱이 업데이트를 확인했는가"를 알 방법이 아예 없다 — 앱을 열어 보는 것 말고는.
    //
    // `platform`을 함께 남기는 이유: iOS와 Android는 **따로 빌드·설치**하므로 한쪽만
    // 갱신된 상태가 정상적으로 존재한다. 플랫폼 없이 로그를 보면 "앱이 받았다"가 어느
    // 쪽인지 알 수 없어, 안 받은 쪽을 받았다고 착각한다.
    //
    // PII 없음: 번들 버전과 플랫폼 문자열뿐이고 기기 식별자는 받지도 쓰지도 않는다.
    this.logger.log(
      `ota check: platform=${platform ?? 'unknown'} ` +
        `app=${currentVersion ?? 'unknown'} latest=${manifest?.version ?? 'none'}`,
    );
    if (!manifest) {
      return { message: 'Version not found' };
    }
    // 같은 버전이면 내려줄 것이 없다. 플러그인도 자체 비교를 하지만, 서버가 먼저
    // 잘라내면 불필요한 다운로드 시도가 로그를 채우지 않는다.
    if (currentVersion && currentVersion === manifest.version) {
      return { message: 'Version not found', version: manifest.version };
    }
    if (!this.publicBaseUrl) {
      // 절대 URL을 못 만들면 내려주지 않는다. 상대 경로를 주면 앱이 자기 자신
      // (capacitor://localhost)에서 zip을 찾아 조용히 실패한다.
      this.logger.error('PUBLIC_BASE_URL이 없어 OTA 다운로드 URL을 만들 수 없습니다');
      return { message: 'Version not found', version: manifest.version };
    }
    return {
      version: manifest.version,
      url: `${this.publicBaseUrl}/v1/ota/bundle/${encodeURIComponent(manifest.file)}`,
      checksum: manifest.checksum,
    };
  }

  /**
   * zip 파일 스트림. 경로 순회를 막기 위해 **파일명만** 받는다.
   *
   * `basename()`으로 한 번 자르고, resolve 결과가 번들 디렉토리 안인지 다시 본다 —
   * 둘 중 하나만으로도 막히지만, 이 경로는 인증 없이 열려 있어 두 겹으로 둔다.
   */
  async openBundle(
    requested: string,
  ): Promise<{ stream: ReturnType<typeof createReadStream>; size: number; name: string }> {
    const name = basename(requested);
    if (!name.endsWith('.zip')) throw new NotFoundException('bundle not found');

    const dir = resolve(this.bundleDir, BUNDLE_SUBDIR);
    const full = resolve(dir, name);
    if (!full.startsWith(`${dir}/`)) throw new NotFoundException('bundle not found');

    let size: number;
    try {
      const info = await stat(full);
      if (!info.isFile()) throw new Error('not a file');
      size = info.size;
    } catch {
      throw new NotFoundException('bundle not found');
    }
    // 다운로드가 시작됐다는 사실을 남긴다. 확인(check)만 있고 이 줄이 없으면
    // "앱이 새 번들을 받기 시작했는지"를 구분할 수 없다.
    this.logger.log(`ota download: ${name} (${size} bytes)`);
    return { stream: createReadStream(full), size, name };
  }

  /** 현재 매니페스트(운영 확인용). 없으면 null. */
  async readManifest(): Promise<OtaManifest | null> {
    try {
      const raw = await readFile(join(this.bundleDir, MANIFEST_FILE), 'utf8');
      const parsed = JSON.parse(raw) as OtaManifest;
      if (!parsed.version || !parsed.file || !parsed.checksum) {
        this.logger.warn('OTA 매니페스트에 필수 필드가 없습니다');
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /** 파일의 SHA256(hex). 배포 검증용. */
  static async checksumOf(path: string): Promise<string> {
    const buf = await readFile(path);
    return createHash('sha256').update(buf).digest('hex');
  }
}
