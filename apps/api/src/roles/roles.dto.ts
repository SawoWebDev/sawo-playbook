import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';

export class SetRolePermissionsDto {
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) @MaxLength(100, { each: true }) permissions!: string[];
}
