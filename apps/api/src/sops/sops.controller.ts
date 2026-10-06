import { TrackActivity } from '../analytics/activity.service';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, ReqMeta, RequestMeta, RequirePermission } from '../common/decorators';
import { Permission } from '../common/permissions';
import { PdfService } from './pdf.service';
import { BulkImportSopsDto, CreateSopDto, ListSopsQuery, SaveStepsDto, SopBulkEditDto, UpdateSopDto, UpdateVersionDto } from './sop.dto';
import { SopWorkflowService } from './sop-workflow.service';
import { SopsService } from './sops.service';

class SubmitDto {
  @IsOptional() @IsString() @MaxLength(2000) changeSummary?: string;
}

class DecisionDto {
  @IsIn(['approved', 'rejected']) decision!: 'approved' | 'rejected';
  @IsOptional() @IsString() @MaxLength(4000) comment?: string;
}

class RejectSopDto {
  @IsString() @MinLength(1) @MaxLength(4000) comment!: string;
}

class ArchiveDto {
  @IsBoolean() archived!: boolean;
}

@Controller('sops')
export class SopsController {
  constructor(
    private readonly sops: SopsService,
    private readonly workflow: SopWorkflowService,
    private readonly pdf: PdfService,
  ) {}

  @Get()
  @RequirePermission(Permission.SopView)
  list(@CurrentUser() actor: AuthUser, @Query() q: ListSopsQuery) {
    return this.sops.list(actor, q);
  }

  /** SOP approval inbox: scoped server-side to the caller's permissions and routed groups. */
  @Get('approvals')
  @RequirePermission(Permission.SopView)
  approvalInbox(@CurrentUser() actor: AuthUser) {
    return this.workflow.inbox(actor);
  }

  @Get('export.csv')
  @RequirePermission(Permission.SopView)
  async exportCsv(@CurrentUser() actor: AuthUser, @Res({ passthrough: true }) res: Response) {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="sops.csv"' });
    return this.sops.exportCsv(actor);
  }

  @Post('bulk/import')
  @HttpCode(200)
  @RequirePermission(Permission.SopEdit)
  @TrackActivity({ event: 'sop.imported', entity: 'sop' })
  bulkImport(@CurrentUser() actor: AuthUser, @Body() dto: BulkImportSopsDto) {
    return this.sops.bulkImportCsv(actor, dto);
  }

  /** Folder moves need edit; archive/unarchive needs publish (enforced in the service). */
  @Patch('bulk')
  @RequirePermission(Permission.SopEdit)
  @TrackActivity({ event: 'sop.bulk_edited', entity: 'sop' })
  bulkEdit(@CurrentUser() actor: AuthUser, @Body() dto: SopBulkEditDto, @ReqMeta() meta: RequestMeta) {
    return this.sops.bulkEdit(actor, dto, meta);
  }

  @Post()
  @RequirePermission(Permission.SopEdit)
  @TrackActivity({ event: 'sop.created', entity: 'sop', id: 'result:id' })
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateSopDto) {
    return this.sops.create(actor, dto);
  }

  @Get(':id')
  @RequirePermission(Permission.SopView)
  get(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sops.get(actor, id);
  }

  @Patch(':id')
  @RequirePermission(Permission.SopEdit)
  update(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSopDto) {
    return this.sops.updateSop(actor, id, dto);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermission(Permission.SopPublish)
  archive(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ArchiveDto, @ReqMeta() meta: RequestMeta) {
    return this.sops.setArchived(actor, id, dto.archived, meta);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.SopEdit)
  @TrackActivity({ event: 'sop.deleted', entity: 'sop', id: 'param:id' })
  remove(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sops.deleteSop(actor, id);
  }

  @Post(':id/duplicate')
  @RequirePermission(Permission.SopEdit)
  @TrackActivity({ event: 'sop.created', entity: 'sop', id: 'result:id' })
  duplicate(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sops.duplicate(actor, id);
  }

  @Get(':id/current')
  @RequirePermission(Permission.SopView)
  @TrackActivity({ event: 'sop.viewed', entity: 'sop', id: 'param:id' })
  current(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sops.getCurrent(actor, id);
  }

  @Post(':id/versions')
  @RequirePermission(Permission.SopEdit)
  @TrackActivity({ event: 'sop.version.created', entity: 'sop', id: 'param:id' })
  newVersion(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sops.createNewVersion(actor, id);
  }

  @Get(':id/versions/:vid')
  @RequirePermission(Permission.SopView)
  @TrackActivity({ event: 'sop.viewed', entity: 'sop', id: 'param:id', params: ['vid'] })
  version(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('vid', ParseUUIDPipe) vid: string) {
    return this.sops.getVersion(actor, id, vid);
  }

  @Patch(':id/versions/:vid')
  @RequirePermission(Permission.SopEdit)
  updateVersion(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) vid: string,
    @Body() dto: UpdateVersionDto,
  ) {
    return this.sops.updateVersion(actor, id, vid, dto);
  }

  @Put(':id/versions/:vid/steps')
  @RequirePermission(Permission.SopEdit)
  @TrackActivity({ event: 'sop.edited', entity: 'sop', id: 'param:id', params: ['vid'] })
  saveSteps(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) vid: string,
    @Body() dto: SaveStepsDto,
  ) {
    return this.sops.saveSteps(actor, id, vid, dto);
  }

  @Post(':id/versions/:vid/abandon')
  @HttpCode(200)
  @RequirePermission(Permission.SopEdit)
  abandon(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('vid', ParseUUIDPipe) vid: string) {
    return this.sops.abandonVersion(actor, id, vid);
  }

  @Post(':id/versions/:vid/submit')
  @HttpCode(200)
  @RequirePermission(Permission.SopSubmit)
  @TrackActivity({ event: 'sop.version.submitted', entity: 'sop', id: 'param:id', params: ['vid'] })
  submit(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) vid: string,
    @Body() dto: SubmitDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.workflow.submit(actor, id, vid, dto.changeSummary, meta);
  }

  @Post(':id/versions/:vid/pre-approve')
  @HttpCode(200)
  @RequirePermission(Permission.SopPreApprove)
  @TrackActivity({ event: 'sop.version.pre_approved', entity: 'sop', id: 'param:id', params: ['vid'] })
  preApprove(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('vid', ParseUUIDPipe) vid: string, @ReqMeta() meta: RequestMeta) {
    return this.workflow.preApprove(actor, id, vid, meta);
  }

  @Post(':id/versions/:vid/reject')
  @HttpCode(200)
  @RequirePermission(Permission.SopReview)
  @TrackActivity({ event: 'sop.version.rejected', entity: 'sop', id: 'param:id', params: ['vid'] })
  reject(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('vid', ParseUUIDPipe) vid: string, @Body() dto: RejectSopDto, @ReqMeta() meta: RequestMeta) {
    return this.workflow.reject(actor, id, vid, dto.comment, meta);
  }

  @Post(':id/versions/:vid/decisions')
  @HttpCode(200)
  @RequirePermission(Permission.SopApprove)
  @TrackActivity({ event: 'sop.version.decided', entity: 'sop', id: 'param:id', params: ['vid'] })
  decide(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) vid: string,
    @Body() dto: DecisionDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.workflow.decide(actor, id, vid, dto.decision, dto.comment, meta);
  }

  @Get(':id/versions/:vid/approvals')
  @RequirePermission(Permission.SopView)
  approvals(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('vid', ParseUUIDPipe) vid: string) {
    return this.workflow.approvals(actor, id, vid);
  }

  @Post(':id/versions/:vid/publish')
  @HttpCode(200)
  @RequirePermission(Permission.SopPublish)
  @TrackActivity({ event: 'sop.version.published', entity: 'sop', id: 'param:id', params: ['vid'] })
  publish(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) vid: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.workflow.publish(actor, id, vid, meta);
  }

  /** Save-and-publish without approval (only when the organization does not require approval). Publishing, so it needs sop.publish. */
  @Post(':id/versions/:vid/finish')
  @HttpCode(200)
  @RequirePermission(Permission.SopPublish)
  @TrackActivity({ event: 'sop.version.published', entity: 'sop', id: 'param:id', params: ['vid'] })
  finish(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) vid: string,
    @Body() dto: SubmitDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.workflow.finish(actor, id, vid, dto.changeSummary, meta);
  }

  @Get(':id/versions/:vid/print')
  @RequirePermission(Permission.ShareExport)
  @TrackActivity({ event: 'sop.exported', entity: 'sop', id: 'param:id', params: ['vid'] })
  async printExport(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) vid: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.sops.getVersion(actor, id, vid); // tenant + visibility check
    const bytes = await this.pdf.pdfForVersion(actor.organizationId, vid);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="sop.pdf"' });
    return new StreamableFile(bytes);
  }
}
