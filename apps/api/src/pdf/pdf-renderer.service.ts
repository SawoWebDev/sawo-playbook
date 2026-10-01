import { Global, Injectable, Logger, Module, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import puppeteer, { Browser } from 'puppeteer-core';

/** Renders HTML to PDF with a headless Chromium that lives inside the API container. */
@Injectable()
export class PdfRendererService implements OnModuleDestroy {
  private readonly logger = new Logger('PdfRenderer');
  private browser?: Promise<Browser>;

  private launch(): Promise<Browser> {
    this.browser ??= puppeteer
      .launch({
        executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      })
      .then((b) => {
        b.on('disconnected', () => (this.browser = undefined));
        return b;
      });
    return this.browser;
  }

  async htmlToPdf(html: string): Promise<Buffer> {
    try {
      const page = await (await this.launch()).newPage();
      try {
        // The HTML carries an auto-print script for standalone use; the PDF path must not run it.
        await page.setContent(html.replace(/<script>[\s\S]*?<\/script>/g, ''), { waitUntil: 'load' });
        return Buffer.from(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
      } finally {
        await page.close();
      }
    } catch (e) {
      this.browser = undefined;
      this.logger.error(`PDF rendering failed: ${(e as Error).message}`);
      throw new ServiceUnavailableException('PDF rendering failed');
    }
  }

  async onModuleDestroy() {
    if (this.browser) await (await this.browser).close().catch(() => undefined);
  }
}

@Global()
@Module({ providers: [PdfRendererService], exports: [PdfRendererService] })
export class PdfRendererModule {}
