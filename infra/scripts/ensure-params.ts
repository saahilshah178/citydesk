/**
 * Creates the SecureString parameters under /citydesk/ that CloudFormation cannot create. Run before
 * `cdk deploy` (the Makefile does). Safe to run repeatedly. Never prints a secret value.
 *
 *   pnpm --filter @citydesk/infra run params:ensure
 */
import { SSMClient } from '@aws-sdk/client-ssm';

import { ensureParams } from '../lib/ensure-params.ts';
import { loadEnv, resolveRegion } from '../lib/env.ts';
import { PARAM_MCP_BEARER_TOKEN } from '../lib/params.ts';
import { describeAwsError, fail } from './aws.ts';

loadEnv();
const region = resolveRegion();

try {
  const results = await ensureParams({ store: new SSMClient({ region }), env: process.env });
  console.log(`SSM parameters in ${region}:`);
  for (const { name, action, detail } of results) console.log(`  ${action.padEnd(9)} ${name}  (${detail})`);
  console.log(
    `\nThe bearer token is never printed. To read it:\n` +
      `  aws ssm get-parameter --region ${region} --name ${PARAM_MCP_BEARER_TOKEN} --with-decryption --query Parameter.Value --output text`,
  );
} catch (error) {
  fail(`could not prepare SSM parameters in ${region}.\n${describeAwsError(error)}`);
}
