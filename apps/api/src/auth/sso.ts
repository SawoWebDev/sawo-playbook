import { Controller, Get, Injectable } from '@nestjs/common';
import { Public } from '../common/decorators';

/**
 * SSO is pluggable only in the MVP (§16 Phase 0.5, §7.4): a SAML/OIDC provider
 * authenticates the user, resolves a local `User` by `sso_provider_id`/email,
 * then calls `AuthService.startSession()` — issuing the SAME JWT access token +
 * rotating refresh cookie. No parallel session mechanism is ever introduced.
 */
export interface SsoProvider {
  readonly id: string;
  readonly displayName: string;
  /** URL the browser is redirected to in order to begin authentication. */
  authorizationUrl(state: string): Promise<string>;
  /** Validates the callback and returns the verified identity. */
  handleCallback(params: Record<string, string>): Promise<{ subject: string; email: string; name?: string }>;
}

@Injectable()
export class SsoRegistry {
  private readonly providers = new Map<string, SsoProvider>();

  register(p: SsoProvider) {
    this.providers.set(p.id, p);
  }

  list() {
    return [...this.providers.values()].map((p) => ({ id: p.id, displayName: p.displayName }));
  }
}

@Controller('auth/sso')
export class SsoController {
  constructor(private readonly registry: SsoRegistry) {}

  @Public()
  @Get('providers')
  providers() {
    return this.registry.list();
  }
}
