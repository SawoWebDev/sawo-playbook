import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join, normalize, sep } from 'path';
import { FilesController } from './files.controller';

/**
 * File storage on a local directory (a Docker volume). Files are private;
 * browsers receive short-lived HMAC-signed URLs served by `FilesController` (§7.8).
 */
@Injectable()
export class StorageService {
  private readonly root = process.env.STORAGE_DIR ?? './storage';

  private path(key: string): string {
    const full = normalize(join(this.root, key));
    if (!full.startsWith(normalize(this.root) + sep)) throw new Error('Invalid storage key');
    return full;
  }

  private secret(): string {
    return process.env.JWT_ACCESS_SECRET ?? '';
  }

  private sign(key: string, exp: number, name = ''): string {
    return createHmac('sha256', this.secret()).update(`${key}\n${exp}\n${name}`).digest('base64url');
  }

  async put(key: string, body: Buffer, _contentType?: string): Promise<void> {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  /** Time-limited GET URL for browsers (default 10 minutes), relative to the app origin. */
  async signedUrl(key: string, opts: { ttlSeconds?: number; downloadName?: string } = {}): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? 600);
    const name = opts.downloadName ?? '';
    const q = new URLSearchParams({ exp: String(exp), sig: this.sign(key, exp, name) });
    if (name) q.set('name', name);
    return `/api/files/${Buffer.from(key).toString('base64url')}?${q}`;
  }

  /** Returns the storage key if the signature is valid and unexpired. */
  verify(token: string, exp: string, sig: string, name = ''): string | null {
    const key = Buffer.from(token, 'base64url').toString();
    const expNum = Number(exp);
    if (!Number.isFinite(expNum) || expNum < Date.now() / 1000) return null;
    const expected = Buffer.from(this.sign(key, expNum, name));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given) ? key : null;
  }
}
