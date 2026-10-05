import { Module } from '@nestjs/common';
import { BackupExporter } from './backup-export.service';
import { BackupJobs } from './backup-jobs';
import { BackupRestorer } from './backup-restore.service';
import { BackupsController } from './backups.controller';
import { BackupsService } from './backups.service';

@Module({
  controllers: [BackupsController],
  providers: [BackupJobs, BackupExporter, BackupRestorer, BackupsService],
})
export class BackupsModule {}
