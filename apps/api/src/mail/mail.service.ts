import { Global, Injectable, Logger, Module } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Mail delivery through SMTP (`SMTP_URL`). Without `SMTP_URL` messages are only
 * logged (dev) and kept in an in-memory outbox (tests). Delivery is fire-and-forget
 * so a mail outage never fails the request that triggered it.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private transporter?: Transporter;
  readonly outbox: MailMessage[] = [];

  async send(msg: MailMessage): Promise<void> {
    this.outbox.push(msg);
    if (this.outbox.length > 200) this.outbox.shift();
    if (process.env.NODE_ENV === 'test') return;
    await this.deliver(msg).catch((e: Error) => this.logger.error(`Could not send mail to ${msg.to}: ${e.message}`));
  }

  private async deliver(msg: MailMessage): Promise<void> {
    const url = process.env.SMTP_URL;
    if (!url) {
      this.logger.log(`(no SMTP_URL) to=${msg.to} subject="${msg.subject}"\n${msg.text}`);
      return;
    }
    this.transporter ??= nodemailer.createTransport(url);
    await this.transporter.sendMail({
      from: process.env.MAIL_FROM ?? 'SAWO Playbook <no-reply@sawo-playbook.local>',
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
    });
  }

  lastTo(email: string): MailMessage | undefined {
    return [...this.outbox].reverse().find((m) => m.to === email);
  }
}

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}
