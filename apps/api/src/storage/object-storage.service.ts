import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '@family/config';

@Injectable()
export class ObjectStorageService implements OnModuleInit {
  private readonly logger = new Logger(ObjectStorageService.name);
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

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  /**
   * Ensures the configured bucket exists (headBucket → createBucket).
   * Failures are logged as warnings and never block application boot —
   * readiness is reported through the health endpoint instead.
   */
  async ensureBucket(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucketName }));
      return;
    } catch {
      // Bucket missing or storage unreachable — attempt to create below.
    }

    try {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucketName }));
      this.logger.log(`Created object storage bucket "${this.bucketName}"`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        `ensureBucket failed for "${this.bucketName}" (boot continues): ${message}`,
      );
    }
  }

  async putObject(
    key: string,
    body: Buffer | Uint8Array | string,
    contentType?: string,
  ): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

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

  /** 지정 key를 멱등 삭제한다. */
  async deleteObject(key: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }),
    );
  }

  /** Throws when the bucket is unreachable; used by the readiness check. */
  async headBucket(): Promise<void> {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.bucketName }));
  }
}
