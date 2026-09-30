import { TrackActivity } from '../analytics/activity.service';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, ReqMeta, RequestMeta, RequirePermission } from '../common/decorators';
import { Permission } from '../common/permissions';
import { SkillsService } from './skills.service';

class MatrixQuery {
  @IsOptional() @IsUUID() folderId?: string;
  @IsOptional() @IsEnum(OrgRole) role?: OrgRole;
}

class HistoryQuery {
  @IsOptional() @IsUUID() associateId?: string;
  @IsOptional() @IsUUID() sopId?: string;
}

class AssessDto {
  @IsUUID() associateId!: string;
  @IsUUID() sopId!: string;
  @IsInt() @Min(0) @Max(4) level!: number;
  @IsOptional() @IsUUID() sopVersionId?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

class AssignDto {
  @IsUUID() trainerId!: string;
  @IsUUID() associateId!: string;
}

@Controller('skills')
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get('matrix')
  @RequirePermission(Permission.SkillsView)
  matrix(@CurrentUser() actor: AuthUser, @Query() q: MatrixQuery) {
    return this.skills.matrix(actor, q);
  }

  @Get('history')
  @RequirePermission(Permission.SkillsView)
  history(@CurrentUser() actor: AuthUser, @Query() q: HistoryQuery) {
    return this.skills.history(actor, q);
  }

  @Post('assessments')
  @RequirePermission(Permission.SkillsUpdate)
  @TrackActivity({ event: 'skills.assessed', entity: 'skill_assessment', id: 'result:id' })
  assess(@CurrentUser() actor: AuthUser, @Body() dto: AssessDto, @ReqMeta() meta: RequestMeta) {
    return this.skills.assess(actor, dto, meta);
  }

  @Post('rebuild')
  @HttpCode(200)
  @RequirePermission(Permission.TrainerAssign)
  rebuild(@CurrentUser() actor: AuthUser) {
    return this.skills.rebuild(actor);
  }

  @Get('trainers')
  @RequirePermission(Permission.SkillsUpdate)
  assignments(@CurrentUser() actor: AuthUser) {
    return this.skills.listAssignments(actor);
  }

  @Post('trainers')
  @RequirePermission(Permission.TrainerAssign)
  assign(@CurrentUser() actor: AuthUser, @Body() dto: AssignDto) {
    return this.skills.assign(actor, dto.trainerId, dto.associateId);
  }

  @Delete('trainers/:trainerId/:associateId')
  @HttpCode(204)
  @RequirePermission(Permission.TrainerAssign)
  async unassign(
    @CurrentUser() actor: AuthUser,
    @Param('trainerId', ParseUUIDPipe) trainerId: string,
    @Param('associateId', ParseUUIDPipe) associateId: string,
  ) {
    await this.skills.unassign(actor, trainerId, associateId);
  }
}
