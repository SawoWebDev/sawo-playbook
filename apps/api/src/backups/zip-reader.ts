import * as yauzl from 'yauzl';
import { BackupFormatError } from './backup-parse';

const MAX_ENTRIES = 200_000;

/** Read-only random access to a .zip on disk. Entry names are only ever used as map keys, never as file paths. */
export class ZipReader {
  private constructor(
    private readonly zip: yauzl.ZipFile,
    readonly entries: Map<string, yauzl.Entry>,
  ) {}

  static async open(path: string): Promise<ZipReader> {
    const notBackup = (e: unknown) => new BackupFormatError(`This is not a valid backup file (${e instanceof Error ? e.message : e})`);
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
      yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (err, z) => (err || !z ? reject(err ?? new Error('cannot open file')) : resolve(z))),
    ).catch((e) => {
      throw notBackup(e);
    });
    const entries = new Map<string, yauzl.Entry>();
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entries.size >= MAX_ENTRIES) return reject(new Error('too many entries'));
        if (!entry.fileName.endsWith('/')) entries.set(entry.fileName, entry);
        zip.readEntry();
      });
      zip.readEntry();
    }).catch((e) => {
      zip.close();
      throw notBackup(e);
    });
    return new ZipReader(zip, entries);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  size(name: string): number {
    return this.entries.get(name)?.uncompressedSize ?? 0;
  }

  read(name: string, maxBytes: number): Promise<Buffer> {
    const entry = this.entries.get(name);
    if (!entry) return Promise.reject(new BackupFormatError(`"${name}" is missing from the backup file`));
    if (entry.uncompressedSize > maxBytes) return Promise.reject(new BackupFormatError(`"${name}" is larger than the allowed ${Math.round(maxBytes / 1024 / 1024)} MB`));
    return new Promise((resolve, reject) =>
      this.zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return reject(err ?? new Error(`Cannot read "${name}"`));
        const chunks: Buffer[] = [];
        let total = 0;
        stream.on('data', (c: Buffer) => {
          total += c.length;
          if (total > maxBytes) return stream.destroy(new BackupFormatError(`"${name}" is larger than allowed`));
          chunks.push(c);
        });
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
      }),
    );
  }

  async readJson<T>(name: string, maxBytes: number): Promise<T> {
    const buf = await this.read(name, maxBytes);
    try {
      return JSON.parse(buf.toString('utf8')) as T;
    } catch {
      throw new BackupFormatError(`"${name}" is not valid JSON`);
    }
  }

  close(): void {
    this.zip.close();
  }
}
