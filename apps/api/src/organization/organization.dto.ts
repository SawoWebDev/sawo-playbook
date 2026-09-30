import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class UpdateSettingsDto {
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
