import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { env } from './config/env';

/** Shared HTTP setup for main.ts and the e2e test harness. */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: env.webOrigin, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  // Requests arrive via the Next.js proxy (and usually a TLS proxy in front of it), all on
  // private networks. Trusting private-network hops makes req.ip the real client address
  // (rate limiting, audit log) while X-Forwarded-For from a public peer is still ignored.
  const http = app.getHttpAdapter().getInstance();
  http.set?.('trust proxy', process.env.TRUST_PROXY ?? 'loopback, linklocal, uniquelocal');
  return app;
}
