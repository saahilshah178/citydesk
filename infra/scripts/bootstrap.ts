/**
 * Runs `cdk bootstrap` only when this account and Region have not been bootstrapped yet.
 *
 * A bootstrapped environment has the SSM parameter /cdk-bootstrap/hnb659fds/version (hnb659fds is the
 * default qualifier, which this app uses). Bootstrap creates the CDKToolkit stack: an S3 bucket and an
 * empty ECR repository for assets plus the deploy roles. `make destroy` leaves it in place.
 *
 *   pnpm --filter @citydesk/infra run bootstrap
 */
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

import { loadEnv, resolveRegion } from '../lib/env.ts';
import { describeAwsError, fail, isCredentialsError } from './aws.ts';

const BOOTSTRAP_VERSION_PARAM = '/cdk-bootstrap/hnb659fds/version';

loadEnv();
const region = resolveRegion();

let account: string | undefined;
try {
  account = (await new STSClient({ region }).send(new GetCallerIdentityCommand({}))).Account;
} catch (error) {
  fail(describeAwsError(error));
}
if (!account) fail('STS did not return an account ID.');

try {
  const result = await new SSMClient({ region }).send(new GetParameterCommand({ Name: BOOTSTRAP_VERSION_PARAM }));
  console.log(`aws://${account}/${region} is already bootstrapped (version ${result.Parameter?.Value ?? 'unknown'}).`);
  process.exit(0);
} catch (error) {
  if (isCredentialsError(error)) fail(describeAwsError(error));
  // ParameterNotFound means "not bootstrapped". Anything else (for example no permission to read the
  // parameter) is handled the same way: bootstrap is idempotent, so running it again is harmless.
  const reason = error instanceof Error ? error.name : String(error);
  console.log(`aws://${account}/${region} does not look bootstrapped (${reason}). Running cdk bootstrap...`);
}

// Run from a directory without a cdk.json. Inside infra/ the CLI synthesizes the whole app before
// bootstrapping, even with an explicit aws://account/region, which needs BEDROCK_MODEL_ID and a build
// and bundles both Lambdas for nothing.
const windows = process.platform === 'win32';
const cdk = resolve(import.meta.dirname, '..', 'node_modules', '.bin', windows ? 'cdk.cmd' : 'cdk');
const result = spawnSync(cdk, ['bootstrap', `aws://${account}/${region}`], {
  cwd: tmpdir(),
  stdio: 'inherit',
  shell: windows,
});
if (result.error) fail(`could not start cdk bootstrap: ${result.error.message}`);
process.exit(result.status ?? 1);
