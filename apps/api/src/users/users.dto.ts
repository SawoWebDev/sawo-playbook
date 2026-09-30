import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OrgRole } from '@prisma/client';

export class InviteDto {
  @IsEmail() @MaxLength(320) email!: string;
  @IsEnum(OrgRole) role!: OrgRole;
}

export class BulkInviteDto {
  /** Either structured rows… */
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => InviteDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  invites?: InviteDto[];

  /** …or raw CSV text with header `email,role`. */
  @IsOptional() @IsString() @MaxLength(200_000) csv?: string;
}

export class ChangeRoleDto {
  @IsEnum(OrgRole) role!: OrgRole;
}

export class AcceptInviteDto {
  @IsString() @MinLength(20) @MaxLength(200) token!: string;
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsString() @MinLength(10) @MaxLength(200) password!: string;
}

export class UpdateProfileDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
}

export class ChangePasswordDto {
  @IsString() @MinLength(1) @MaxLength(200) currentPassword!: string;
  @IsString() @MinLength(10) @MaxLength(200) newPassword!: string;
}

export class ForgotPasswordDto {
  @IsEmail() @MaxLength(320) email!: string;
}

export class ResetPasswordDto {
  @IsString() @MinLength(20) @MaxLength(200) token!: string;
  @IsString() @MinLength(10) @MaxLength(200) newPassword!: string;
}

export class MfaCodeDto {
  @IsString() @MinLength(6) @MaxLength(8) code!: string;
}

export class MfaDisableDto {
  @IsString() @MinLength(1) @MaxLength(200) password!: string;
  @IsString() @MinLength(6) @MaxLength(8) code!: string;
}
