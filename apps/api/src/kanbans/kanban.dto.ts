import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const KANBAN_SORT_FIELDS = ['partCode', 'partDescription', 'supplier', 'location', 'updatedAt', 'createdAt'] as const;
export const KANBAN_TEMPLATES = ['01', '02'] as const;

class KanbanFields {
  @IsOptional() @IsString() @MaxLength(5000) partDescription?: string | null;
  @IsOptional() @IsUUID() pictureAssetId?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) supplier?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) supplierPartNo?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) usedFor?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) orderWhen?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) orderQty?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) deliveryTime?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) location?: string | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999_999) price?: number | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999_999) carriage?: number | null;
  @IsOptional() @IsString() @MaxLength(5000) customField1?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) customField2?: string | null;
  @IsOptional() @IsIn(['url', 'sop', 'email']) orderingType?: 'url' | 'sop' | 'email';
  @IsOptional() @IsString() @MaxLength(5000) orderingUrl?: string | null;
  @IsOptional() @IsUUID() orderingSopId?: string | null;
  @IsOptional() @IsString() @MaxLength(320) orderingEmail?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) tag?: string | null;
  @IsOptional() @IsString() @MaxLength(30) color?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) barcode?: string | null;
  @IsOptional() @IsIn(KANBAN_TEMPLATES) template?: (typeof KANBAN_TEMPLATES)[number];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) mediaAssetIds?: string[];
}

export class CreateKanbanDto extends KanbanFields {
  @IsString() @MinLength(1) @MaxLength(100) partCode!: string;
}

export class UpdateKanbanDto extends KanbanFields {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) partCode?: string;
}

export class ListKanbansQuery {
  @IsOptional() @IsString() @MaxLength(5000) search?: string;
  @IsOptional() @IsString() @MaxLength(1000) tag?: string;
  @IsOptional() @IsString() @MaxLength(5000) supplier?: string;
  @IsOptional() @IsString() @MaxLength(5000) location?: string;
  @IsOptional() @IsIn(KANBAN_SORT_FIELDS) sort?: (typeof KANBAN_SORT_FIELDS)[number];
  @IsOptional() @IsIn(['asc', 'desc']) dir?: 'asc' | 'desc';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class BulkImportDto {
  @IsString() @MaxLength(2_000_000) csv!: string;
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

class BulkPatch {
  @IsOptional() @IsString() @MaxLength(1000) tag?: string | null;
  @IsOptional() @IsString() @MaxLength(30) color?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) location?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) supplier?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) orderWhen?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) orderQty?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) deliveryTime?: string | null;
  @IsOptional() @IsIn(KANBAN_TEMPLATES) template?: (typeof KANBAN_TEMPLATES)[number];
}

export class BulkEditDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000) @IsUUID('all', { each: true }) ids!: string[];
  @ValidateNested() @Type(() => BulkPatch) patch!: BulkPatch;
}

export class BulkIdsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('all', { each: true }) ids!: string[];
}
