import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  MinLength,
  ValidateNested,
} from 'class-validator';

export const CREATABLE_SOP_TYPES = ['standard', 'advanced'] as const;

export class CreateSopDto {
  @IsString() @MinLength(1) @MaxLength(300) name!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60) referenceNo?: string;
  @IsOptional() @IsIn(CREATABLE_SOP_TYPES) type?: (typeof CREATABLE_SOP_TYPES)[number];
  @IsOptional() @IsUUID() folderId?: string;
}

export class UpdateSopDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(300) name?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60) referenceNo?: string;
  /** null moves the SOP to the root. */
  @IsOptional() @IsUUID() folderId?: string | null;
}

export class ListSopsQuery {
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @IsIn(['draft', 'pending_approval', 'approved', 'published', 'archived']) status?: string;
  @IsOptional() @IsString() folderId?: string; // uuid or "root"
  @IsOptional() @IsIn(['true', 'false']) includeSubfolders?: 'true' | 'false';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class VersionConfigDto {
  @IsOptional() @IsBoolean() cover_sheet?: boolean;
  @IsOptional() @IsBoolean() collaborate?: boolean;
  @IsOptional() @IsBoolean() checklist_sop?: boolean;
  @IsOptional() @IsBoolean() key_points_enabled?: boolean;
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
