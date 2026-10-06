import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, ReqMeta, RequestMeta, RequirePermission } from '../common/decorators';
import { Permission } from '../common/permissions';
import { BulkEditDto, BulkIdsDto, BulkImportDto, CreateKanbanDto, ListKanbansQuery, RejectRevisionDto, UpdateKanbanDto } from './kanban.dto';
import { KanbansService } from './kanbans.service';

/**
 * Live kanbans are read-only from here except through publish. Writes create revisions (drafts) that move through
 * the approval workflow. Each route declares the permission it needs; the service applies the stage-specific rules.
 */
@Controller('kanbans')
export class KanbansController {
  constructor(private readonly kanbans: KanbansService) {}

  @Get()
  @RequirePermission(Permission.KanbanView)
  list(@CurrentUser() actor: AuthUser, @Query() q: ListKanbansQuery) {
    return this.kanbans.list(actor, q);
  }

  @Get('export.csv')
  @RequirePermission(Permission.KanbanView)
  async exportCsv(@CurrentUser() actor: AuthUser, @Res({ passthrough: true }) res: Response) {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="kanbans.csv"' });
    return this.kanbans.exportCsv(actor);
  }

  /** Imports become drafts, one per valid row; nothing is published. */
  @Post('bulk/import')
  @HttpCode(200)
  @RequirePermission(Permission.KanbanCreate)
  bulkImport(@CurrentUser() actor: AuthUser, @Body() dto: BulkImportDto, @ReqMeta() meta: RequestMeta) {
    return this.kanbans.bulkImport(actor, dto.csv, dto.dryRun ?? false, meta);
  }

  /** Direct publisher-level bulk edit of live cards (audited as a direct publish). */
  @Patch('bulk')
  @RequirePermission(Permission.KanbanBulk)
  bulkEdit(@CurrentUser() actor: AuthUser, @Body() dto: BulkEditDto, @ReqMeta() meta: RequestMeta) {
    return this.kanbans.bulkEdit(actor, dto, meta);
  }

  @Post('bulk/print')
  @HttpCode(200)
  @RequirePermission(Permission.ShareExport)
  async print(@CurrentUser() actor: AuthUser, @Body() dto: BulkIdsDto, @Res({ passthrough: true }) res: Response) {
    const pdf = await this.kanbans.printPdf(actor, dto.ids);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="kanbans.pdf"' });
    return new StreamableFile(pdf);
  }

  // ───────────── approval workflow (declared before ':id' so 'revisions' is not parsed as a card id) ─────────────

  /** Approval inbox: scoped to the caller's permissions and routing. */
  @Get('revisions')
  @RequirePermission(Permission.KanbanView)
  inbox(@CurrentUser() actor: AuthUser) {
    return this.kanbans.inbox(actor);
  }

  @Get('revisions/:rid')
  @RequirePermission(Permission.KanbanView)
  getRevision(@CurrentUser() actor: AuthUser, @Param('rid', ParseUUIDPipe) rid: string) {
    return this.kanbans.getRevision(actor, rid);
  }

  @Post('revisions/:rid/submit')
  @HttpCode(200)
  @RequirePermission(Permission.KanbanSubmit)
  submit(@CurrentUser() actor: AuthUser, @Param('rid', ParseUUIDPipe) rid: string, @ReqMeta() meta: RequestMeta) {
    return this.kanbans.submit(actor, rid, meta);
  }

  @Post('revisions/:rid/pre-approve')
  @HttpCode(200)
  @RequirePermission(Permission.KanbanPreApprove)
  preApprove(@CurrentUser() actor: AuthUser, @Param('rid', ParseUUIDPipe) rid: string, @ReqMeta() meta: RequestMeta) {
    return this.kanbans.preApprove(actor, rid, meta);
  }

  @Post('revisions/:rid/approve')
  @HttpCode(200)
  @RequirePermission(Permission.KanbanApprove)
  approve(@CurrentUser() actor: AuthUser, @Param('rid', ParseUUIDPipe) rid: string, @ReqMeta() meta: RequestMeta) {
    return this.kanbans.approve(actor, rid, meta);
  }

  @Post('revisions/:rid/reject')
  @HttpCode(200)
  @RequirePermission(Permission.KanbanReview)
  reject(@CurrentUser() actor: AuthUser, @Param('rid', ParseUUIDPipe) rid: string, @Body() dto: RejectRevisionDto, @ReqMeta() meta: RequestMeta) {
    return this.kanbans.reject(actor, rid, dto.comment, meta);
  }

  @Post('revisions/:rid/publish')
  @HttpCode(200)
  @RequirePermission(Permission.KanbanPublish)
  publish(@CurrentUser() actor: AuthUser, @Param('rid', ParseUUIDPipe) rid: string, @ReqMeta() meta: RequestMeta) {
    return this.kanbans.publish(actor, rid, meta);
  }

  @Delete('revisions/:rid')
  @HttpCode(204)
  @RequirePermission(Permission.KanbanEdit)
  async discard(@CurrentUser() actor: AuthUser, @Param('rid', ParseUUIDPipe) rid: string, @ReqMeta() meta: RequestMeta) {
    await this.kanbans.discard(actor, rid, meta);
  }

  // ───────────── cards ─────────────

  /** Creates a draft. The card is not live until a publisher publishes it. */
  @Post()
  @RequirePermission(Permission.KanbanCreate)
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateKanbanDto, @ReqMeta() meta: RequestMeta) {
    return this.kanbans.create(actor, dto, meta);
  }

  @Get(':id')
  @RequirePermission(Permission.KanbanView)
  get(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.kanbans.get(actor, id);
  }

  @Get(':id/history')
  @RequirePermission(Permission.KanbanView)
  history(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.kanbans.history(actor, id);
  }

  /** Saves a draft of this card. The live card is unchanged until the draft is published. */
  @Patch(':id')
  @RequirePermission(Permission.KanbanEdit)
  update(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateKanbanDto, @ReqMeta() meta: RequestMeta) {
    return this.kanbans.update(actor, id, dto, meta);
  }

  /** Deletes a published card (publish authority required; see service). */
  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.KanbanDelete)
  async remove(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    await this.kanbans.remove(actor, id, meta);
  }
}
