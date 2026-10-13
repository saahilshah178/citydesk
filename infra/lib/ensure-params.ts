/**
 * Creates the SecureString parameters CloudFormation cannot create. Kept apart from the CLI wrapper
 * in scripts/ensure-params.ts so the "never print a secret" rule is covered by a unit test.
 */
import { randomBytes } from 'node:crypto';

import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import type { GetParameterCommandOutput, PutParameterCommandOutput } from '@aws-sdk/client-ssm';

import { nonEmpty } from './env.ts';
import { PARAM_BOSTON_OPEN311_API_KEY, PARAM_MCP_BEARER_TOKEN, PARAM_SEECLICKFIX_API_KEY } from './params.ts';

/** The slice of SSMClient this module needs. Lets a test pass a fake. */
export interface ParameterStore {
  send(command: GetParameterCommand): Promise<GetParameterCommandOutput>;
  send(command: PutParameterCommand): Promise<PutParameterCommandOutput>;
}

export type ParamAction = 'created' | 'updated' | 'unchanged' | 'kept' | 'skipped';

export interface ParamResult {
  readonly name: string;
  readonly action: ParamAction;
  /** Why, in words that are safe to print. Never contains a value. */
  readonly detail: string;
}

export interface EnsureParamsOptions {
  readonly store: ParameterStore;
  readonly env: NodeJS.ProcessEnv;
  /** Override for tests. Default: 32 random bytes, base64url encoded. */
  readonly newToken?: () => string;
}

/** Optional API keys: parameter name and the deployer environment variable that feeds it. */
export const API_KEY_PARAMS = [
  { name: PARAM_BOSTON_OPEN311_API_KEY, envVar: 'BOSTON_OPEN311_API_KEY', description: 'Boston Open311 API key' },
  { name: PARAM_SEECLICKFIX_API_KEY, envVar: 'SEECLICKFIX_API_KEY', description: 'SeeClickFix API key' },
] as const;

export function generateBearerToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Returns the stored parameter, or undefined when it does not exist. */
async function read(store: ParameterStore, name: string): Promise<{ type?: string; value?: string } | undefined> {
  try {
    const result = await store.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return { type: result.Parameter?.Type, value: result.Parameter?.Value };
  } catch (error) {
    if (error instanceof Error && error.name === 'ParameterNotFound') return undefined;
    throw error;
  }
}

async function put(store: ParameterStore, name: string, value: string, description: string, overwrite: boolean) {
  await store.send(
    new PutParameterCommand({
      Name: name,
      Value: value,
      Type: 'SecureString', // encrypted with the AWS managed key alias/aws/ssm, which has no monthly fee
      Tier: 'Standard',
      Overwrite: overwrite,
      Description: description,
    }),
  );
}

/**
 * - /citydesk/mcp-bearer-token: created with a fresh random token when missing, otherwise left alone
 *   so MCP clients that already hold the token keep working across deploys.
 * - /citydesk/boston-open311-api-key and /citydesk/seeclickfix-api-key: written when the matching
 *   environment variable is set, and rewritten only when the value changed.
 */
export async function ensureParams(options: EnsureParamsOptions): Promise<ParamResult[]> {
  const { store, env } = options;
  const results: ParamResult[] = [];

  const token = await read(store, PARAM_MCP_BEARER_TOKEN);
  if (token) {
    const wrongType = token.type !== 'SecureString';
    results.push({
      name: PARAM_MCP_BEARER_TOKEN,
      action: 'kept',
      detail: wrongType
        ? `already exists as ${token.type ?? 'an unknown type'}; delete it and rerun to store it as a SecureString`
        : 'already exists, left unchanged',
    });
  } else {
    try {
      await put(store, PARAM_MCP_BEARER_TOKEN, (options.newToken ?? generateBearerToken)(), 'CityDesk MCP bearer token', false);
      results.push({ name: PARAM_MCP_BEARER_TOKEN, action: 'created', detail: 'new random 32-byte token' });
    } catch (error) {
      // Another deploy created it between the read and the write. Theirs wins.
      if (!(error instanceof Error && error.name === 'ParameterAlreadyExists')) throw error;
      results.push({ name: PARAM_MCP_BEARER_TOKEN, action: 'kept', detail: 'already exists, left unchanged' });
    }
  }

  for (const { name, envVar, description } of API_KEY_PARAMS) {
    const wanted = nonEmpty(env[envVar]);
    if (!wanted) {
      results.push({ name, action: 'skipped', detail: `${envVar} is not set` });
      continue;
    }
    const current = await read(store, name);
    if (current?.type === 'SecureString' && current.value === wanted) {
      results.push({ name, action: 'unchanged', detail: `matches ${envVar}` });
      continue;
    }
    await put(store, name, wanted, `CityDesk: ${description}`, current !== undefined);
    results.push({ name, action: current ? 'updated' : 'created', detail: `from ${envVar}` });
  }

  return results;
}
