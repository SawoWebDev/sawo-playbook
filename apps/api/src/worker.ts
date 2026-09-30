import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue, Worker } from 'bullmq';
import { AppModule } from './app.module';
import { MaintenanceService } from './jobs/maintenance.service';
import { QUEUE_NAMES, redisConnection } from './jobs/queue.service';
import { MailMessage, MailService } from './mail/mail.service';
import { PdfService } from './sops/pdf.service';

/**
 * Background worker (§9 Redis + BullMQ):
 *  - maintenance: deletion finalisation, retention purge, media cleanup (scheduled)
 *  - mail: SMTP delivery of invitations / password resets
 *  - pdf: canonical PDF pre-rendering after publish
 * Start with `node dist/worker.js` (prod) or `npm run worker:dev`.
 */
const EVERY_MS = Number(process.env.MAINTENANCE_INTERVAL_MS ?? 60 * 60 * 1000);

async function main() {
  const logger = new Logger('Worker');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  const maintenance = app.get(MaintenanceService);
  const mail = app.get(MailService);
  const pdf = app.get(PdfService, { strict: false });
  const connection = redisConnection();

  const scheduler = new Queue(QUEUE_NAMES.maintenance, { connection });
  await scheduler.upsertJobScheduler('maintenance-tick', { every: EVERY_MS }, { name: 'tick', opts: { removeOnComplete: 50, removeOnFail: 100 } });

  const workers = [
    new Worker(
      QUEUE_NAMES.maintenance,
      async () => {
        const result = await maintenance.runAll(new Date());
        logger.log(`maintenance: ${JSON.stringify(result)}`);
        return result;
      },
      { connection, concurrency: 1 },
    ),
    new Worker(QUEUE_NAMES.mail, async (job) => mail.deliver(job.data as MailMessage), { connection, concurrency: 5 }),
    new Worker(
      QUEUE_NAMES.pdf,
      async (job) => {
        const { organizationId, versionId } = job.data as { organizationId: string; versionId: string };
        await pdf.pdfForVersion(organizationId, versionId);
      },
      { connection, concurrency: 2 },
    ),
  ];
  for (const w of workers) w.on('failed', (job, err) => logger.error(`${w.name} job ${job?.id} failed: ${err.message}`));

  const shutdown = async () => {
    await Promise.all(workers.map((w) => w.close()));
    await scheduler.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  logger.log(`Worker started (maintenance every ${EVERY_MS} ms; mail; pdf)`);
}

void main();
