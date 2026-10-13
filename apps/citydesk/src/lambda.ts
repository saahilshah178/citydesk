/**
 * AWS Lambda entry point for the CityDesk MCP server, behind a Function URL (payload format 2.0).
 *
 * Stateless by design: every invocation builds a fresh MCP server for the caller, answers in JSON,
 * and keeps all memory in DynamoDB. The bearer token and the allowed browser origins come from SSM
 * Parameter Store under CITYDESK_SSM_PREFIX; environment variables are the fallback for local runs.
 */
import { fileURLToPath } from 'node:url';
import { toFunctionUrlHandler, type FunctionUrlEvent, type FunctionUrlResult } from 'open311-mcp';
import { createApp } from './app.ts';
import { ParameterReader } from './aws/parameters.ts';
import { buildRuntime } from './bootstrap.ts';

const env = process.env;
const list = (value: string | undefined): string[] => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const log = (event: string, data?: Record<string, unknown>): void => {
  console.log(JSON.stringify({ event, ...data }));
};

const parameters = env.CITYDESK_SSM_PREFIX
  ? new ParameterReader({ prefix: env.CITYDESK_SSM_PREFIX }, [
      'mcp-bearer-token',
      'allowed-origins',
      'boston-open311-api-key',
      'seeclickfix-api-key',
    ])
  : undefined;

// API keys are read once per cold start and handed to the Open311 clients through the environment
// object they already read keys from.
const runtimeEnv: Record<string, string | undefined> = { ...env };
if (parameters) {
  try {
    runtimeEnv.BOSTON_OPEN311_API_KEY ??= await parameters.get('boston-open311-api-key');
    runtimeEnv.SEECLICKFIX_API_KEY ??= await parameters.get('seeclickfix-api-key');
  } catch (err) {
    log('parameters_unavailable', { error: err instanceof Error ? err.message : String(err) });
  }
}

const { runtime, hooks, summary } = await buildRuntime({
  env: runtimeEnv,
  log,
  // The deploy copies the address index next to the bundled handler.
  addressIndexPaths: [fileURLToPath(new URL('./addresses.json.gz', import.meta.url))],
});
log('cold_start', { summary });

const app = createApp({
  runtime,
  hooks,
  bearerTokens: async () => [...list(env.MCP_BEARER_TOKENS), ...(parameters ? await parameters.list('mcp-bearer-token') : [])],
  allowedOrigins: async () => [...list(env.MCP_ALLOWED_ORIGINS), ...(parameters ? await parameters.list('allowed-origins') : [])],
  sessions: 'none',
});

const functionUrl = toFunctionUrlHandler(app);

export const handler = async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => functionUrl(event);
