import { S3Client } from '@aws-sdk/client-s3';
import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '@family/config';

import { ObjectStorageService } from './object-storage.service';

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
