import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { JobsOptions, Queue } from 'bullmq';

export const QUEUE_NAMES = { maintenance: 'maintenance', mail: 'mail', pdf: 'pdf' } as const;
type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export function redisConnection() {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return { host: url.hostname, port: Number(url.port || 6379), password: url.password || undefined, maxRetriesPerRequest: null };
}

/** Queues are disabled in the test environment (work runs inline or is asserted directly). */
export function queuesEnabled(): boolean {
  if (process.env.QUEUES_ENABLED) return process.env.QUEUES_ENABLED === 'true';
  return process.env.NODE_ENV !== 'test';
}

/** Producer side of the async pipeline (§9): API enqueues, `worker.ts` consumes. */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger('Queues');
  private readonly queues = new Map<QueueName, Queue>();

  get enabled() {
    return queuesEnabled();
  }

  private queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: redisConnection() });
      this.queues.set(name, q);
    }
    return q;
  }

  /** Returns false when queues are disabled or Redis is unavailable, so callers can fall back. */
  async add(name: QueueName, jobName: string, data: object, opts: JobsOptions = {}): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      await this.queue(name).add(jobName, data, {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 200,
        removeOnFail: 500,
        ...opts,
      });
      return true;
    } catch (e) {
      this.logger.warn(`Could not enqueue ${name}/${jobName}: ${(e as Error).message}`);
      return false;
    }
  }

  async onModuleDestroy() {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
