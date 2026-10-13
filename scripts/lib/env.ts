import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Loads the repo-root .env into process.env when present. Real environment variables win. */
export function loadEnv(root: string = resolve(import.meta.dirname, '..', '..')): void {
  const file = resolve(root, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export const USER_AGENT =
  'citydesk/0.1 (+https://github.com/saahilshah178/citydesk; Open311 civic hackathon client)';
