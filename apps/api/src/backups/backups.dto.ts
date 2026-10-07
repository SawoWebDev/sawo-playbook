import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional } from 'class-validator';
import { BACKUP_SECTIONS, BackupSection } from './backup-format';

/** Sections to include. Omitted means a full backup; an empty list is refused. */
export class StartBackupDto {
  @IsOptional() @IsArray() @ArrayMaxSize(BACKUP_SECTIONS.length) @IsIn(BACKUP_SECTIONS, { each: true })
  sections?: BackupSection[];

  /** Write sign-in password hashes into the People section. For the one-time transfer only. */
  @IsOptional() @IsBoolean()
  includePasswords?: boolean;
}
