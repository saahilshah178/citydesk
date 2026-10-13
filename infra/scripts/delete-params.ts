/**
 * Removes the parameters scripts/ensure-params.ts created. `cdk destroy` cannot, because they are not
 * part of the stack. /citydesk/allowed-origins is deleted with the stack itself.
 *
 *   pnpm --filter @citydesk/infra run params:delete
 */
import { DeleteParametersCommand, SSMClient } from '@aws-sdk/client-ssm';

import { loadEnv, resolveRegion } from '../lib/env.ts';
import { SCRIPT_MANAGED_PARAMS } from '../lib/params.ts';
import { describeAwsError, fail } from './aws.ts';

loadEnv();
const region = resolveRegion();

try {
  const result = await new SSMClient({ region }).send(new DeleteParametersCommand({ Names: [...SCRIPT_MANAGED_PARAMS] }));
  console.log(`SSM parameters in ${region}:`);
  for (const name of result.DeletedParameters ?? []) console.log(`  deleted   ${name}`);
  // "Invalid" is how DeleteParameters reports a name that does not exist.
  for (const name of result.InvalidParameters ?? []) console.log(`  absent    ${name}`);
} catch (error) {
  fail(`could not delete SSM parameters in ${region}.\n${describeAwsError(error)}`);
}
