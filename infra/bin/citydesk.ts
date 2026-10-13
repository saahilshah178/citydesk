/**
 * CDK app entry. Run through the CLI: `pnpm --filter @citydesk/infra exec cdk synth`, or `make synth`
 * from the repo root.
 *
 * Deployer settings come from the environment (the repo-root .env is loaded when present):
 *   BEDROCK_MODEL_ID        required
 *   POLLY_VOICE_ID          default Joanna
 *   POLLY_ENGINE            default neural
 *   DEMO_DAILY_REQUEST_CAP  default 2000
 *   CITYDESK_TABLE          default citydesk-user-requests
 *   LOCATION_PLACE_INDEX    default citydesk-places
 *
 * Paths can be overridden with CDK context, resolved against the current directory (infra/):
 *   -c mcpEntry=<file>  -c clientApiEntry=<file>  -c clientDist=<dir>
 *
 * The stack is environment-agnostic. It deploys to whatever account and Region the CLI resolves,
 * which the Makefile pins to AWS_REGION (default us-east-1).
 */
import * as cdk from 'aws-cdk-lib';

import { CityDeskStack } from '../lib/citydesk-stack.ts';
import { ConfigError, loadDeployConfig } from '../lib/config.ts';
import { loadEnv } from '../lib/env.ts';

loadEnv();

const app = new cdk.App();
const context = (key: string): string | undefined => {
  const value: unknown = app.node.tryGetContext(key);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

try {
  new CityDeskStack(app, 'CityDesk', {
    description: 'CityDesk: MCP server for city services (Open311) and its Echo Show style web client',
    ...loadDeployConfig(process.env),
    mcpEntry: context('mcpEntry'),
    clientApiEntry: context('clientApiEntry'),
    clientDist: context('clientDist'),
  });
} catch (error) {
  if (error instanceof ConfigError) {
    // A settings problem, not a bug: print the sentence and skip the stack trace.
    console.error(`\nCityDesk infra: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
