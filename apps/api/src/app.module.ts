import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ActivityModule } from './analytics/activity.service';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BackupsModule } from './backups/backups.module';
import { ChecklistsModule } from './checklists/checklists.module';
import { AuthorizationGuard } from './common/authorization.guard';
import { FoldersModule } from './folders/folders.module';
import { HealthController } from './health/health.controller';
import { JobsModule } from './jobs/jobs.module';
import { KanbansModule } from './kanbans/kanbans.module';
import { MailModule } from './mail/mail.service';
import { MediaModule } from './media/media.module';
import { SopsModule } from './sops/sops.module';
import { StorageModule } from './storage/storage.module';
import { OrganizationModule } from './organization/organization.module';
import { UsersModule } from './users/users.module';
import { GroupsModule } from './groups/groups.module';
import { RolesModule } from './roles/roles.module';
import { PdfRendererModule } from './pdf/pdf-renderer.service';
import { PrismaModule } from './prisma/prisma.module';
import { SkillsModule } from './skills/skills.module';

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
      skipIf: () => process.env.NODE_ENV === 'test' && process.env.ENABLE_THROTTLE_IN_TEST !== '1',
    }),
    PrismaModule,
    AuditModule,
    ActivityModule,
    MailModule,
    AuthModule,
    UsersModule,
    GroupsModule,
    RolesModule,
    OrganizationModule,
    StorageModule,
    PdfRendererModule,
    MediaModule,
    FoldersModule,
    SopsModule,
    BackupsModule,
    ChecklistsModule,
    KanbansModule,
    SkillsModule,
    AnalyticsModule,
    JobsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthorizationGuard },
  ],
})
export class AppModule {}
