import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Absolute path of the repository root (the directory that holds pnpm-lock.yaml). */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/** Region used when the deployer sets neither AWS_REGION nor AWS_DEFAULT_REGION. */
export const DEFAULT_REGION = 'us-east-1';

/**
 * Loads the repo-root .env into process.env when present. Real environment variables win, which is
 * the same rule scripts/lib/env.ts follows for the smoke test.
 */
export function loadEnv(root: string = REPO_ROOT): void {
  const file = resolve(root, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

/** The region every infra script and the CDK CLI should agree on. */
export function resolveRegion(env: NodeJS.ProcessEnv = process.env): string {
  return nonEmpty(env.AWS_REGION) ?? nonEmpty(env.AWS_DEFAULT_REGION) ?? DEFAULT_REGION;
}

/** Trims a value and maps blank strings (an empty line in .env) to undefined. */
export function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
