import { BadRequestException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { MediaAsset } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { AuthUser } from '../common/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { ALLOWED_UPLOADS, imageSize, sniffMime } from './file-sniff';
import { MalwareScanner } from './malware-scanner';

export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface MediaView {
  id: string;
  type: MediaAsset['type'];
  mimeType: string;
  originalFilename: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  url: string;
}

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly scanner: MalwareScanner,
  ) {}

  async upload(actor: AuthUser, file: UploadedFileLike | undefined): Promise<MediaView> {
    if (!file?.buffer?.length) throw new BadRequestException('A non-empty "file" is required');
    const sniffed = sniffMime(file.buffer);
    const rule = sniffed ? ALLOWED_UPLOADS[sniffed] : undefined;
    if (!sniffed || !rule) throw new BadRequestException('Unsupported file type');
    if (file.mimetype && file.mimetype !== sniffed && !(file.mimetype === 'image/jpg' && sniffed === 'image/jpeg')) {
      throw new BadRequestException(`File content (${sniffed}) does not match declared type (${file.mimetype})`);
    }
    if (file.buffer.length > rule.maxBytes) throw new PayloadTooLargeException('File too large');
    const verdict = await this.scanner.scan(file.buffer);
    if (!verdict.clean) throw new BadRequestException(`File rejected by malware scan (${verdict.signature})`);

    const id = randomUUID();
    const safeName = file.originalname.replace(/[^\w.\- ]+/g, '_').slice(-120) || 'upload';
    const storageKey = `org/${actor.organizationId}/media/${id}`;
    await this.storage.put(storageKey, file.buffer, sniffed);
    const dims = rule.type === 'image' ? imageSize(file.buffer, sniffed) : null;
    const asset = await this.prisma.mediaAsset.create({
      data: {
        id,
        organizationId: actor.organizationId,
        type: rule.type,
        storageKey,
        originalFilename: safeName,
        mimeType: sniffed,
        sizeBytes: BigInt(file.buffer.length),
        checksum: createHash('sha256').update(file.buffer).digest('hex'),
        width: dims?.width,
        height: dims?.height,
        createdById: actor.id,
      },
    });
    return this.view(asset);
  }

  async get(actor: AuthUser, id: string): Promise<MediaView> {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id, organizationId: actor.organizationId, lifecycleState: { notIn: ['soft_deleted', 'purged'] } },
    });
    if (!asset) throw new NotFoundException('Media not found');
    return this.view(asset);
  }

  /**
   * Validates that every id is a live asset of the actor's org. Used before any
   * record references media, so a foreign asset id can never be attached (IDOR).
   */
  async assertUsable(organizationId: string, ids: string[]): Promise<void> {
    const unique = [...new Set(ids)];
    if (!unique.length) return;
    const found = await this.prisma.mediaAsset.count({
      where: { id: { in: unique }, organizationId, lifecycleState: { notIn: ['soft_deleted', 'purged'] } },
    });
    if (found !== unique.length) throw new BadRequestException('One or more media assets are invalid');
  }

  async view(asset: MediaAsset): Promise<MediaView> {
    return {
      id: asset.id,
      type: asset.type,
      mimeType: asset.mimeType,
      originalFilename: asset.originalFilename,
      sizeBytes: Number(asset.sizeBytes),
      width: asset.width,
      height: asset.height,
      url: await this.storage.signedUrl(asset.storageKey),
    };
  }
}
