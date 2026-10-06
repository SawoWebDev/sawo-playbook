import { Module } from '@nestjs/common';
import { ApprovalPool } from '../approvals/approval-pool';
import { KanbansController } from './kanbans.controller';
import { KanbansService } from './kanbans.service';

@Module({
  controllers: [KanbansController],
  providers: [KanbansService, ApprovalPool],
})
export class KanbansModule {}
