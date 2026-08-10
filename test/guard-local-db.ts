import 'dotenv/config';

/**
 * Jest globalSetup for the e2e suite — production write guard.
 *
 * Every e2e spec in this folder creates real rows: stores, users, products,
 * invoices, debts. The repo's committed `.env` points DATABASE_URL at the
 * production Neon database, so a run that forgets to override it writes test
 * data straight into live store records, and a spec that crashes mid-run
 * leaves that data behind.
 *
 * Overriding DATABASE_URL on the command line works (dotenv does not clobber
 * an already-set process.env value) but is procedural — one forgotten prefix
 * is one production incident. This turns it into a hard failure instead.
 *
 * To run the suite:
 *   DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export default function guardLocalDatabase(): void {
  const raw = process.env.DATABASE_URL;

  if (!raw) {
    throw new Error(
      'DATABASE_URL is not set — refusing to run the e2e suite.',
    );
  }

  let hostname: string;
  try {
    hostname = new URL(raw).hostname;
  } catch {
    throw new Error(
      'DATABASE_URL is not a parseable URL — refusing to run the e2e suite.',
    );
  }

  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error(
      `\n\n  Refusing to run the e2e suite against "${hostname}".\n\n` +
        '  These tests write real rows and are only safe against a local\n' +
        '  throwaway database. Point DATABASE_URL at one first:\n\n' +
        '    DATABASE_URL="postgresql://postgres@localhost:5432/casheer_dev" npm run test:e2e\n',
    );
  }
}
