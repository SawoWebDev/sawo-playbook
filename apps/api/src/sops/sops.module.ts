import { Module } from '@nestjs/common';
import { ApprovalPool } from '../approvals/approval-pool';
import { PdfService } from './pdf.service';
import { QrController } from './qr.controller';
import { SopVersionRepository } from './sop-version.repository';
import { SopWorkflowService } from './sop-workflow.service';
import { SopsController } from './sops.controller';
import { SopsService } from './sops.service';

@Module({
  controllers: [SopsController, QrController],
  providers: [SopsService, SopWorkflowService, SopVersionRepository, PdfService, ApprovalPool],
  exports: [SopsService],
})
export class SopsModule {}
