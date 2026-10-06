import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';

/** Sidebar menu customisation. The allowed items are checked in OrganizationService (NAV_ITEMS). */
export class NavConfigDto {
  @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(60, { each: true }) order!: string[];
  @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(60, { each: true }) hidden!: string[];
}

export class UpdateSettingsDto {
  /** `null` restores the built-in menu. */
  @IsOptional() @ValidateNested() @Type(() => NavConfigDto) navConfig?: NavConfigDto | null;
  @IsOptional() @IsBoolean() approvalRequired?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(20) approvalQuorum?: number;
  @IsOptional() @IsBoolean() allowSelfApproval?: boolean;
  @IsOptional() @IsBoolean() publicSopViewing?: boolean;
}

export class RequestDeletionDto {
  /** Must match the organization name exactly (§7.7 explicit confirmation). */
  @IsString() @MaxLength(200) confirmName!: string;
  /** Re-authentication (§7.7). */
  @IsString() @MaxLength(200) password!: string;
}

export class AuditQueryDto {
  @IsOptional() @IsString() @MaxLength(100) action?: string;
  @IsOptional() @IsString() @MaxLength(100) before?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}
