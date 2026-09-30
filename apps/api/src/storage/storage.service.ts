import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Global, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';

function cfg(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/**
 * S3-compatible object storage (MinIO in Docker). Objects are private; browsers
 * receive short-lived signed URLs (§7.8). Two clients: one for the internal
 * endpoint (API ↔ MinIO), one only used to *sign* URLs for the public endpoint.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger('Storage');
  readonly bucket = cfg('S3_BUCKET', 'gembadocs');
  private readonly client: S3Client;
  private readonly signer: S3Client;

  constructor() {
    const common = {
      region: cfg('S3_REGION', 'us-east-1'),
      forcePathStyle: true,
      credentials: {
        accessKeyId: cfg('S3_ACCESS_KEY', 'gemba'),
        secretAccessKey: cfg('S3_SECRET_KEY', 'gemba-minio-secret'),
      },
    };
    this.client = new S3Client({ ...common, endpoint: cfg('S3_ENDPOINT', 'http://localhost:9000') });
    this.signer = new S3Client({
      ...common,
      endpoint: cfg('S3_PUBLIC_ENDPOINT', cfg('S3_ENDPOINT', 'http://localhost:9000')),
    });
  }

  async onModuleInit() {
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
        return;
      } catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404) {
          await this.client.send(new CreateBucketCommand({ Bucket: this.bucket })).catch(() => undefined);
          return;
        }
        if (attempt === 10) {
          this.logger.error(`Object storage unreachable: ${(e as Error).message}`);
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Time-limited GET URL for browsers (default 10 minutes). */
  signedUrl(key: string, opts: { ttlSeconds?: number; downloadName?: string } = {}): Promise<string> {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: opts.downloadName
          ? `attachment; filename="${opts.downloadName.replace(/["\\\r\n]/g, '_')}"`
          : undefined,
      }),
      { expiresIn: opts.ttlSeconds ?? 600 },
    );
  }
}

@Global()
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
