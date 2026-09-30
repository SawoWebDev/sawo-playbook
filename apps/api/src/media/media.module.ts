import { Global, Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MalwareScanner } from './malware-scanner';
import { MediaService } from './media.service';

@Global()
@Module({
  controllers: [MediaController],
  providers: [MediaService, MalwareScanner],
  exports: [MediaService, MalwareScanner],
})
export class MediaModule {}
