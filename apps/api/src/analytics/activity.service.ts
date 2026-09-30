import { CallHandler, ExecutionContext, Global, Injectable, Logger, Module, NestInterceptor, SetMetadata } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { mergeMap, Observable } from 'rxjs';
import { AuthUser } from '../common/auth-user';
import { PrismaService, Tx } from '../prisma/prisma.service';

export interface ActivityInput {
  organizationId: string;
  actorId?: string | null;
  eventType: string;
  entityType?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * §6.9 ActivityEvent: append-only analytics stream, NOT the compliance record
 * (that is AuditLog). Emission failures are logged and never break the request.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger('Activity');

  constructor(private readonly prisma: PrismaService) {}

  async emit(e: ActivityInput, tx?: Tx): Promise<void> {
    try {
      await (tx ?? this.prisma).activityEvent.create({
        data: {
          organizationId: e.organizationId,
          actorId: e.actorId ?? null,
          eventType: e.eventType,
          entityType: e.entityType,
          entityId: e.entityId,
          metadata: e.metadata ?? {},
        },
      });
    } catch (err) {
      if (tx) throw err;
      this.logger.warn(`Failed to record activity ${e.eventType}: ${(err as Error).message}`);
    }
  }
}

export const ACTIVITY_KEY = 'gemba:activity';

export interface ActivitySpec {
  event: string;
  entity: string;
  /** Where to read the entity id: a route param name (`param:id`) or a response field (`result:id`). */
  id?: `param:${string}` | `result:${string}`;
  /** Route params to copy into metadata. */
  params?: string[];
}

/** Declares that a successful call to this route emits an ActivityEvent. */
export const TrackActivity = (spec: ActivitySpec) => SetMetadata(ACTIVITY_KEY, spec);

@Injectable()
export class ActivityInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly activity: ActivityService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const spec = this.reflector.get<ActivitySpec | undefined>(ACTIVITY_KEY, ctx.getHandler());
    if (!spec) return next.handle();
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    return next.handle().pipe(
      mergeMap(async (result) => {
        const user = req.user;
        if (!user) return result;
        const params = (req.params ?? {}) as Record<string, string>;
        let entityId: string | undefined;
        if (spec.id?.startsWith('param:')) entityId = params[spec.id.slice(6)];
        else if (spec.id?.startsWith('result:') && result && typeof result === 'object') {
          const v = (result as Record<string, unknown>)[spec.id.slice(7)];
          entityId = typeof v === 'string' ? v : undefined;
        }
        const metadata: Record<string, string> = {};
        for (const p of spec.params ?? []) if (params[p]) metadata[p] = params[p];
        await this.activity.emit({
          organizationId: user.organizationId,
          actorId: user.id,
          eventType: spec.event,
          entityType: spec.entity,
          entityId,
          metadata,
        });
        return result;
      }),
    );
  }
}

@Global()
@Module({
  providers: [ActivityService, { provide: APP_INTERCEPTOR, useClass: ActivityInterceptor }],
  exports: [ActivityService],
})
export class ActivityModule {}
