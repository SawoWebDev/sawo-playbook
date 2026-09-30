import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SsoController, SsoRegistry } from './sso';
import { TokenService } from './token.service';

@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController, SsoController],
  providers: [AuthService, TokenService, SsoRegistry],
  exports: [AuthService, TokenService, SsoRegistry, JwtModule],
})
export class AuthModule {}
