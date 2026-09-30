import { MediaType } from '@prisma/client';

/** Upload allow-list (§7.8 "upload MIME/size validation"). Video/document types arrive with Phase 3. */
export const ALLOWED_UPLOADS: Record<string, { type: MediaType; maxBytes: number }> = {
  'image/png': { type: 'image', maxBytes: 20 * 1024 * 1024 },
  'image/jpeg': { type: 'image', maxBytes: 20 * 1024 * 1024 },
  'image/gif': { type: 'image', maxBytes: 20 * 1024 * 1024 },
  'image/webp': { type: 'image', maxBytes: 20 * 1024 * 1024 },
  'application/pdf': { type: 'pdf', maxBytes: 25 * 1024 * 1024 },
};

export const MAX_UPLOAD_BYTES = Math.max(...Object.values(ALLOWED_UPLOADS).map((v) => v.maxBytes));

/**
 * Detects the real content type from magic bytes so a client cannot smuggle
 * e.g. HTML/SVG/script content under an image MIME type.
 */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return null;
}

/** Best-effort pixel dimensions for PNG/GIF/JPEG/WebP (VP8X/VP8/VP8L). */
export function imageSize(buf: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === 'image/png' && buf.length >= 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === 'image/gif' && buf.length >= 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
      return null;
    }
    if (mime === 'image/webp' && buf.length >= 30) {
      const chunk = buf.subarray(12, 16).toString('ascii');
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    return null;
  }
  return null;
}
