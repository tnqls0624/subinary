import { S3Client } from '@aws-sdk/client-s3';
import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '@family/config';

import { ObjectStorageService } from './object-storage.service';

/**
 * 워커용 스토리지 모듈(Phase 6 Build Spec §6). API의 `StorageModule`을 축약해,
 * `config.storage`로 단일 `S3Client`를 만들고 읽기 전용 `ObjectStorageService`를
 * 제공한다. 모듈 종료 시 클라이언트를 정리한다.
 */
@Module({
  providers: [
    {
      provide: S3Client,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): S3Client => {
        const storage = configService.get<AppConfig['storage']>('storage');
        if (!storage) {
          throw new Error('Storage configuration is missing');
        }
        return new S3Client({
          endpoint: storage.endpoint,
          region: storage.region,
          credentials: {
            accessKeyId: storage.accessKey,
            secretAccessKey: storage.secretKey,
          },
          forcePathStyle: storage.forcePathStyle,
        });
      },
    },
    ObjectStorageService,
  ],
  exports: [S3Client, ObjectStorageService],
})
export class StorageModule implements OnModuleDestroy {
  constructor(@Inject(S3Client) private readonly s3: S3Client) {}

  onModuleDestroy(): void {
    this.s3.destroy();
  }
}
