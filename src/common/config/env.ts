import 'dotenv/config';

function required(name: string, minLength = 0): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required but missing.`);
  }
  if (minLength > 0 && value.length < minLength) {
    throw new Error(
      `Environment variable ${name} must be at least ${minLength} characters long.`,
    );
  }
  return value;
}

/**
 * The zone the shop counts its days in.
 *
 * Reports slice by calendar day, so this decides where one day's takings stop
 * and the next day's begin. It is deliberately NOT the container's clock: the
 * container runs UTC, and reading days off UTC filed every sale between local
 * midnight and 03:00 under the previous day.
 *
 * Validated at boot — a typo here would silently mis-bucket every report.
 */
function timeZone(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    throw new Error(
      `Environment variable ${name} ("${value}") is not a valid IANA time zone, e.g. "Asia/Hebron".`,
    );
  }
  return value;
}

export const env = {
  JWT_SECRET: required('JWT_SECRET', 32),
  DATABASE_URL: required('DATABASE_URL'),
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  PORT: Number(process.env.PORT ?? 3000),
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  STORE_TIMEZONE: timeZone('STORE_TIMEZONE', 'Asia/Hebron'),
};
