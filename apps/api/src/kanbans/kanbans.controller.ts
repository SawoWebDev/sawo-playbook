import { TrackActivity } from '../analytics/activity.service';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, ReqMeta, RequestMeta, RequirePermission } from '../common/decorators';
import { Permission } from '../common/permissions';
import { BulkEditDto, BulkIdsDto, BulkImportDto, CreateKanbanDto, ListKanbansQuery, UpdateKanbanDto } from './kanban.dto';
import { KanbansService } from './kanbans.service';

@Controller('kanbans')
export class KanbansController {
  constructor(private readonly kanbans: KanbansService) {}

  @Get()
  @RequirePermission(Permission.SopView)
  list(@CurrentUser() actor: AuthUser, @Query() q: ListKanbansQuery) {
    return this.kanbans.list(actor, q);
  }

  @Get('export.csv')
  @RequirePermission(Permission.KanbanBulk)
  async exportCsv(@CurrentUser() actor: AuthUser, @Res({ passthrough: true }) res: Response) {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="kanbans.csv"' });
    return this.kanbans.exportCsv(actor);
  }

  @Post('bulk/import')
  @HttpCode(200)
  @RequirePermission(Permission.KanbanBulk)
  @TrackActivity({ event: 'kanban.imported', entity: 'kanban' })
  bulkImport(@CurrentUser() actor: AuthUser, @Body() dto: BulkImportDto, @ReqMeta() meta: RequestMeta) {
    return this.kanbans.bulkImport(actor, dto.csv, dto.dryRun ?? false, meta);
  }

  @Patch('bulk')
  @RequirePermission(Permission.KanbanBulk)
  bulkEdit(@CurrentUser() actor: AuthUser, @Body() dto: BulkEditDto, @ReqMeta() meta: RequestMeta) {
    return this.kanbans.bulkEdit(actor, dto, meta);
  }

  @Post('bulk/print')
  @HttpCode(200)
  @RequirePermission(Permission.ShareExport)
  @TrackActivity({ event: 'kanban.printed', entity: 'kanban' })
  async print(@CurrentUser() actor: AuthUser, @Body() dto: BulkIdsDto, @Res({ passthrough: true }) res: Response) {
    const pdf = await this.kanbans.printPdf(actor, dto.ids);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="kanbans.pdf"' });
    return new StreamableFile(pdf);
  }

  @Post()
  @RequirePermission(Permission.KanbanEdit)
  @TrackActivity({ event: 'kanban.created', entity: 'kanban', id: 'result:id' })
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateKanbanDto) {
    return this.kanbans.create(actor, dto);
  }

  @Get(':id')
  @RequirePermission(Permission.SopView)
  get(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.kanbans.get(actor, id);
  }

  @Patch(':id')
  @RequirePermission(Permission.KanbanEdit)
  @TrackActivity({ event: 'kanban.updated', entity: 'kanban', id: 'param:id' })
  update(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateKanbanDto) {
    return this.kanbans.update(actor, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.KanbanEdit)
  @TrackActivity({ event: 'kanban.deleted', entity: 'kanban', id: 'param:id' })
  async remove(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.kanbans.remove(actor, id);
  }
}
