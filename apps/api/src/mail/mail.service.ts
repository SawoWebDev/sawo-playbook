import { Global, Injectable, Logger, Module } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { QueueService } from '../jobs/queue.service';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Mail delivery. Messages are enqueued on the `mail` BullMQ queue and sent by
 * the worker through SMTP (`SMTP_URL`, e.g. Mailpit in dev). Without a queue
 * (tests) they are recorded in an in-memory outbox and logged.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private transporter?: Transporter;
  readonly outbox: MailMessage[] = [];

  constructor(private readonly queues: QueueService) {}

  async send(msg: MailMessage): Promise<void> {
    this.outbox.push(msg);
    if (this.outbox.length > 200) this.outbox.shift();
    if (await this.queues.add('mail', 'send', msg)) return;
    if (process.env.NODE_ENV !== 'test') {
      this.logger.log(`(no queue) to=${msg.to} subject="${msg.subject}"\n${msg.text}`);
    }
  }

  /** Called by the worker for each queued message. */
  async deliver(msg: MailMessage): Promise<void> {
    const url = process.env.SMTP_URL;
    if (!url) {
      this.logger.log(`(no SMTP_URL) to=${msg.to} subject="${msg.subject}"\n${msg.text}`);
      return;
    }
    this.transporter ??= nodemailer.createTransport(url);
    await this.transporter.sendMail({
      from: process.env.MAIL_FROM ?? 'GembaDocs <no-reply@gembadocs.local>',
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
