import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '@family/config';

/**
 * 워커용 경량 오브젝트 스토리지 클라이언트(Phase 6 Build Spec §6).
 *
 * API의 `ObjectStorageService`와 달리 워커는 원문 번들을 **읽기만** 하므로
 * `getObject`만 노출한다(버킷 생성/쓰기·readiness는 API 책임). 버킷 이름은
 * `config.storage`에서 가져오고, 실제 S3 접속은 `StorageModule`이 제공하는
 * `S3Client`(endpoint/region/credentials/forcePathStyle)로 수행한다.
 */
@Injectable()
export class ObjectStorageService {
  private readonly bucketName: string;

  constructor(
    @Inject(S3Client) private readonly s3: S3Client,
    configService: ConfigService,
  ) {
    const storage = configService.get<AppConfig['storage']>('storage');
    if (!storage) {
      throw new Error('Storage configuration is missing');
    }
    this.bucketName = storage.bucket;
  }

  get bucket(): string {
    return this.bucketName;
  }

  /** 지정 key의 원문 바이트를 Buffer로 반환한다. 빈 응답은 오류로 처리. */
  async getObject(key: string): Promise<Buffer> {
    const response = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
    );
    if (!response.Body) {
      throw new Error(`Object "${key}" returned an empty body`);
    }
    const bytes = await response.Body.transformToByteArray();
    return Buffer.from(bytes);
  }
}
