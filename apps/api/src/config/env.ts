function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const env = {
  get nodeEnv() {
    return process.env.NODE_ENV ?? 'development';
  },
  get port() {
    return Number(process.env.PORT ?? 4000);
  },
  get jwtAccessSecret() {
    return required('JWT_ACCESS_SECRET');
  },
  get jwtAccessTtlSeconds() {
    return Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900);
  },
  get refreshTtlDays() {
    return Number(process.env.REFRESH_TTL_DAYS ?? 30);
  },
  get cookieSecure() {
    return process.env.COOKIE_SECURE !== 'false';
  },
  get webOrigin() {
    return process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  },
  get publicAppUrl() {
    return process.env.PUBLIC_APP_URL ?? 'http://localhost:3000';
  },
};
