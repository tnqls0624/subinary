/**
 * FCM HTTP v1 발송 클라이언트 (의존성 없이 node:crypto로 서비스계정 OAuth2 구현).
 *
 * 서비스계정 3값(projectId/clientEmail/privateKey)이 모두 설정돼야 활성화되고,
 * 하나라도 없으면 `enabled=false`로 no-op한다(dev/mock 안전 — AI provider 패턴).
 *
 * 흐름: 서비스계정 JWT(RS256) 서명 → oauth2.googleapis.com/token 교환 →
 * access_token 캐시(만료 60초 전까지 재사용) → fcm.googleapis.com/v1 send.
 * 토큰이 무효(UNREGISTERED/INVALID_ARGUMENT)면 결과에 `invalidToken=true`를 실어
 * 호출부가 구독을 revoke하게 한다. iOS/Android는 FCM 한 채널로 발송(APNs는
 * Firebase 콘솔에 인증키 업로드로 위임).
 *
 * 로그/발송 페이로드에 금액·가맹점 원문을 남기는 것은 호출부(processor) 정책을
 * 따른다 — 여기서는 title/body를 그대로 전달만 한다.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign } from 'node:crypto';

import type { AppConfig } from '@family/config';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** access_token 재사용 안전 여유(초) — 만료 직전 갱신. */
const TOKEN_SKEW_SEC = 60;
/** 발송 HTTP 타임아웃(ms). */
const SEND_TIMEOUT_MS = 5_000;

/** 발송할 알림 1건(수신 토큰 + 표시 내용 + 딥링크 data). */
export interface FcmMessage {
  token: string;
  title: string;
  body: string;
  /** data 페이로드(문자열만) — 예: { deepLink: '/transactions?txn=<id>' }. */
  data?: Record<string, string>;
}

/** 발송 결과. `invalidToken`이면 호출부가 구독을 영구 revoke한다. */
export interface FcmSendResult {
  ok: boolean;
  invalidToken: boolean;
  /** 재시도 가치가 있는 일시 오류(5xx/429/네트워크)인지. */
  retryable: boolean;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

@Injectable()
export class FcmService {
  private readonly logger = new Logger(FcmService.name);
  private readonly projectId?: string;
  private readonly clientEmail?: string;
  private readonly privateKey?: string;
  private cachedToken: CachedToken | null = null;
  private tokenInflight: Promise<string> | null = null;

  constructor(configService: ConfigService) {
    const cfg = configService.get<AppConfig['notifications']>('notifications');
    this.projectId = cfg?.fcmProjectId;
    this.clientEmail = cfg?.fcmClientEmail;
    this.privateKey = cfg?.fcmPrivateKey;
    if (!this.enabled) {
      this.logger.log('FCM disabled (service account not configured) — push is a no-op');
    }
  }

  /** 세 값이 모두 있으면 활성. */
  get enabled(): boolean {
    return Boolean(this.projectId && this.clientEmail && this.privateKey);
  }

  /**
   * 알림 1건을 발송한다. 비활성이면 조용히 성공(no-op) 처리한다 —
   * 호출부는 enabled를 먼저 확인해 발송 루프 자체를 건너뛰는 것이 이상적.
   */
  async send(message: FcmMessage): Promise<FcmSendResult> {
    if (!this.enabled) {
      return { ok: true, invalidToken: false, retryable: false };
    }
    let accessToken: string;
    try {
      accessToken = await this.getAccessToken();
    } catch (error) {
      this.logger.warn(
        `FCM token exchange failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return { ok: false, invalidToken: false, retryable: true };
    }

    const url = `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`;
    const payload = {
      message: {
        token: message.token,
        notification: { title: message.title, body: message.body },
        ...(message.data ? { data: message.data } : {}),
        android: { priority: 'high' as const },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: { aps: { sound: 'default' } },
        },
      },
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (res.ok) {
        return { ok: true, invalidToken: false, retryable: false };
      }
      // 토큰 폐기는 **오직 UNREGISTERED**일 때만(Firebase 권장). FCM v1은 잘못된
      // 메시지 페이로드·설정 오류에도 400 INVALID_ARGUMENT를 반환하므로, 400을
      // 토큰 무효로 오탐하면 코드 버그 한 번에 전체 구독이 대량 폐기된다.
      // UNREGISTERED는 errorCode(상세) 또는 error.status 문자열로 판정한다.
      const bodyText = await res.text().catch(() => '');
      const invalidToken = /UNREGISTERED/.test(bodyText);
      // 5xx/429는 재시도. 400(INVALID_ARGUMENT 등)은 재시도해도 같은 결과이므로
      // 재시도하지 않고(토큰도 유지) 잡을 성공 종료 — 페이로드/설정 버그는 로그로
      // 드러나되 구독을 파괴하지 않는다.
      const retryable = res.status === 429 || res.status >= 500;
      // 원문에 토큰/PII가 없도록 상태코드와 판정 결과만 로그.
      this.logger.warn(
        `FCM send non-ok status=${res.status} invalidToken=${invalidToken} retryable=${retryable}`,
      );
      return { ok: false, invalidToken, retryable };
    } catch (error) {
      this.logger.warn(
        `FCM send error: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return { ok: false, invalidToken: false, retryable: true };
    }
  }

  /** 캐시된 access_token을 반환하거나 새로 교환한다(single-flight). */
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs > now) {
      return this.cachedToken.accessToken;
    }
    if (this.tokenInflight) return this.tokenInflight;
    this.tokenInflight = this.exchangeToken()
      .then((token) => {
        this.tokenInflight = null;
        return token;
      })
      .catch((error) => {
        this.tokenInflight = null;
        throw error;
      });
    return this.tokenInflight;
  }

  /** 서비스계정 JWT를 서명해 access_token으로 교환한다. */
  private async exchangeToken(): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    const expSec = nowSec + 3600;
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: this.clientEmail,
      scope: FCM_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat: nowSec,
      exp: expSec,
    };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
      JSON.stringify(claims),
    )}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    const signature = signer.sign(this.privateKey as string);
    const jwt = `${signingInput}.${signature.toString('base64url')}`;

    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`oauth token status ${res.status}`);
    }
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) {
      throw new Error('oauth response missing access_token');
    }
    const expiresInSec = json.expires_in ?? 3600;
    this.cachedToken = {
      accessToken: json.access_token,
      expiresAtMs: Date.now() + (expiresInSec - TOKEN_SKEW_SEC) * 1000,
    };
    return json.access_token;
  }
}

/** JSON 문자열 → base64url(패딩 없음). */
function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}
