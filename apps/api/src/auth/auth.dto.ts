import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class SignupDto {
  @IsString() @MinLength(2) @MaxLength(200) organizationName!: string;
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsEmail() @MaxLength(320) email!: string;
  @IsString() @MinLength(10) @MaxLength(200) password!: string;
}

export class LoginDto {
  @IsEmail() @MaxLength(320) email!: string;
  @IsString() @MinLength(1) @MaxLength(200) password!: string;
}

export class LoginMfaDto {
  @IsString() @MinLength(20) @MaxLength(2000) mfaToken!: string;
  @IsString() @MinLength(6) @MaxLength(8) code!: string;
}
