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

export const env = {
  JWT_SECRET: required('JWT_SECRET', 32),
  DATABASE_URL: required('DATABASE_URL'),
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  PORT: Number(process.env.PORT ?? 3000),
  NODE_ENV: process.env.NODE_ENV ?? 'development',
};
