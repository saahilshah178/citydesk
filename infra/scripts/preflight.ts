/**
 * Checks what a deploy needs before anything slow starts, and says what is missing in plain words.
 *
 *   tsx scripts/preflight.ts model        BEDROCK_MODEL_ID and the other deployer settings are valid
 *   tsx scripts/preflight.ts aws          AWS credentials resolve (one STS call)
 *   tsx scripts/preflight.ts model aws    both
 */
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

import { ConfigError, loadDeployConfig } from '../lib/config.ts';
import { loadEnv, resolveRegion } from '../lib/env.ts';
import { describeAwsError, fail } from './aws.ts';

loadEnv();

const checks = process.argv.slice(2);
const known = ['model', 'aws'];
if (checks.length === 0 || checks.some((check) => !known.includes(check))) {
  fail(`usage: preflight.ts <${known.join('|')}> [...]`);
}

if (checks.includes('model')) {
  try {
    const config = loadDeployConfig(process.env);
    console.log(`Bedrock model: ${config.bedrockModelId}`);
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message);
    throw error;
  }
}

if (checks.includes('aws')) {
  const region = resolveRegion();
  try {
    const identity = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
    console.log(`AWS account:   ${identity.Account} as ${identity.Arn}`);
    console.log(`AWS Region:    ${region}`);
  } catch (error) {
    fail(describeAwsError(error));
  }
}
