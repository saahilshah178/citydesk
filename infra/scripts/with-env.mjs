#!/usr/bin/env node
/**
 * Runs a command with the deployer's environment prepared the same way for every tool in the chain
 * (pnpm, tsx scripts, the CDK CLI and the CDK app):
 *
 *   - the repo-root .env is loaded when present; variables that are already set win
 *   - AWS_REGION defaults to us-east-1, and AWS_DEFAULT_REGION is set to the same value so the CDK
 *     CLI and the AWS SDK cannot disagree
 *
 *   node infra/scripts/with-env.mjs <command> [args...]
 *
 * Plain JavaScript with no dependencies, so it also works before `pnpm install`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const envFile = resolve(repoRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const region = process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim() || 'us-east-1';
process.env.AWS_REGION = region;
process.env.AWS_DEFAULT_REGION = region;

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: node infra/scripts/with-env.mjs <command> [args...]');
  process.exit(2);
}

const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) {
  console.error(`with-env: could not run "${command}": ${result.error.message}`);
  process.exit(127);
}
process.exit(result.status ?? 1);
