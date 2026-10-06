import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateGroupDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
}

export class RenameGroupDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
}

export class AddMembersDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('all', { each: true }) userIds!: string[];
}
