import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  Matches,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const CREATABLE_SOP_TYPES = ['standard', 'advanced'] as const;
export const SOP_TYPES = ['standard', 'advanced', 'video', 'document'] as const;
export const SOP_SORTS = ['oldest', 'newest', 'modified', 'alphabetical', 'reference'] as const;

export class CreateSopDto {
  @IsString() @MinLength(1) @MaxLength(300) name!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60) referenceNo?: string;
  @IsOptional() @IsIn(CREATABLE_SOP_TYPES) type?: (typeof CREATABLE_SOP_TYPES)[number];
  @IsOptional() @IsUUID() folderId?: string;
}

export class UpdateSopDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(300) name?: string;
  /** Standard ↔ Advanced (step titles); video/document types are created by their own flows (Phase 3). */
  @IsOptional() @IsIn(CREATABLE_SOP_TYPES) type?: (typeof CREATABLE_SOP_TYPES)[number];
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60) referenceNo?: string;
  /** null moves the SOP to the root. */
  @IsOptional() @IsUUID() folderId?: string | null;
}

export class ListSopsQuery {
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @IsIn(['draft', 'pending_approval', 'approved', 'published', 'archived']) status?: string;
  @IsOptional() @IsString() folderId?: string; // uuid or "root"
  @IsOptional() @IsIn(['true', 'false']) includeSubfolders?: 'true' | 'false';
  @IsOptional() @IsIn(SOP_TYPES) type?: (typeof SOP_TYPES)[number];
  @IsOptional() @IsIn(['true', 'false']) checklistOnly?: 'true' | 'false';
  @IsOptional() @IsString() @MaxLength(2000) createdBy?: string; // comma-separated user ids
  @IsOptional() @IsIn(SOP_SORTS) sort?: (typeof SOP_SORTS)[number];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

export class VersionConfigDto {
  @IsOptional() @IsBoolean() cover_sheet?: boolean;
  @IsOptional() @IsBoolean() collaborate?: boolean;
  @IsOptional() @IsBoolean() checklist_sop?: boolean;
  @IsOptional() @IsBoolean() key_points_enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(40) language?: string;
  @IsOptional() @IsIn(['Landscape', 'Portrait']) pdf_orientation?: string;
  @IsOptional() @IsInt() @Min(1) @Max(12) steps_per_page?: number;
  @IsOptional() @IsBoolean() full_image?: boolean;
  @IsOptional() @IsBoolean() step_by_step_pdf?: boolean;
  @IsOptional() @IsString() @MaxLength(20) border_width?: string;
  @IsOptional() @Matches(COLOR) header_footer_color?: string;
  @IsOptional() @IsIn(['Black', 'White']) header_footer_text_color?: string;
  @IsOptional() @IsString() @MaxLength(200) red_card_text?: string;
  @IsOptional() @Matches(COLOR) red_bg?: string;
  @IsOptional() @IsIn(['Black', 'White']) red_text?: string;
  @IsOptional() @Matches(COLOR) green_bg?: string;
  @IsOptional() @IsIn(['Black', 'White']) green_text?: string;
  @IsOptional() @IsBoolean() is_critical?: boolean;
  @IsOptional() @IsString() @MaxLength(500) video_link?: string;
  @IsOptional() @IsString() @MaxLength(40) total_time_required?: string;
}

export class UpdateVersionDto {
  @IsOptional() @ValidateNested() @Type(() => VersionConfigDto) config?: VersionConfigDto;
  @IsOptional() @IsString() @MaxLength(2000) changeSummary?: string;
}

export class StepMediaInput {
  @IsUUID() mediaAssetId!: string;
}

export class StepInput {
  @IsOptional() @IsUUID() id?: string;
  @IsOptional() @IsString() @MaxLength(300) title?: string | null;
  @IsOptional() @IsString() @MaxLength(50_000) description?: string;
  @IsOptional() @IsBoolean() isTextOnly?: boolean;
  @IsOptional() @IsBoolean() isCritical?: boolean;
  @IsOptional() @IsBoolean() usesOkNotokMedia?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(86_400) plannedTimeSeconds?: number;
  @IsOptional() @IsUUID() linkedSopId?: string | null;
  @IsOptional() @IsUUID() linkedSopVersionId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => StepMediaInput) media?: StepMediaInput[];
}

export class SaveStepsDto {
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => StepInput) steps!: StepInput[];
}

export class BulkImportSopsDto {
  @IsString() @MaxLength(2_000_000) csv!: string;
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

class SopBulkPatch {
  @IsOptional() @IsUUID() folderId?: string | null;
  @IsOptional() @IsBoolean() archived?: boolean;
}

export class SopBulkEditDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('all', { each: true }) ids!: string[];
  @ValidateNested() @Type(() => SopBulkPatch) patch!: SopBulkPatch;
}
