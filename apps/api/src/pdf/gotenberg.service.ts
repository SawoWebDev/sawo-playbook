import { Global, Injectable, Logger, Module, ServiceUnavailableException } from '@nestjs/common';

/** Thin client for the Gotenberg HTML→PDF service (ADR 0001). */
@Injectable()
export class GotenbergService {
  private readonly logger = new Logger('Gotenberg');
  private readonly url = process.env.PDF_RENDERER_URL ?? 'http://localhost:3001';

  async htmlToPdf(html: string, opts: { landscape?: boolean } = {}): Promise<Buffer> {
    const form = new FormData();
    form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
    form.append('printBackground', 'true');
    form.append('preferCssPageSize', 'true');
    if (opts.landscape) form.append('landscape', 'true');
    let res: Response;
    try {
      res = await fetch(`${this.url}/forms/chromium/convert/html`, { method: 'POST', body: form });
    } catch (e) {
      this.logger.error(`PDF renderer unreachable: ${(e as Error).message}`);
      throw new ServiceUnavailableException('PDF renderer unavailable');
    }
    if (!res.ok) {
      this.logger.error(`PDF renderer returned ${res.status}: ${await res.text().catch(() => '')}`);
      throw new ServiceUnavailableException('PDF rendering failed');
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

@Global()
@Module({ providers: [GotenbergService], exports: [GotenbergService] })
export class GotenbergModule {}
