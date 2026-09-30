import { Global, Module } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';
import { QueueService } from './queue.service';

@Global()
@Module({
  providers: [MaintenanceService, QueueService],
  exports: [MaintenanceService, QueueService],
})
export class JobsModule {}
