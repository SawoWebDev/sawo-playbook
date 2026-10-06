import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OrgRole } from '@prisma/client';
import { ASSIGNABLE_ROLES } from '../common/permissions';

export class InviteDto {
  @IsEmail() @MaxLength(320) email!: string;
  @IsIn(ASSIGNABLE_ROLES) role!: OrgRole;
  /** Groups the invitee joins on acceptance. Required for every non-Admin role; checked by the service. */
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) groupIds?: string[];
}

/** Admin creates an active account now. The temporary password is replaced by the user at first sign-in. */
export class CreateUserDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsEmail() @MaxLength(320) email!: string;
  @IsIn(ASSIGNABLE_ROLES) role!: OrgRole;
  /** Required for every non-Admin role; checked by the service, same rule as invitations. */
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) groupIds?: string[];
  @IsString() @MinLength(10) @MaxLength(200) temporaryPassword!: string;
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
  @IsIn(ASSIGNABLE_ROLES) role!: OrgRole;
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

export class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsEmail() @MaxLength(320) email?: string;
}
