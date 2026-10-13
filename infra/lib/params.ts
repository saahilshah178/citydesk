/**
 * Names of the SSM Parameter Store entries CityDesk uses. One file so the stack, the deploy scripts
 * and the tests cannot drift apart.
 */

/** Every CityDesk parameter lives under this path. Both Lambdas get it as CITYDESK_SSM_PREFIX. */
export const SSM_PREFIX = '/citydesk';

/** SecureString. Bearer token the MCP endpoint accepts. Created by scripts/ensure-params.ts. */
export const PARAM_MCP_BEARER_TOKEN = `${SSM_PREFIX}/mcp-bearer-token`;

/** SecureString, optional. Boston Open311 API key. Created by scripts/ensure-params.ts. */
export const PARAM_BOSTON_OPEN311_API_KEY = `${SSM_PREFIX}/boston-open311-api-key`;

/** SecureString, optional. SeeClickFix API key. Created by scripts/ensure-params.ts. */
export const PARAM_SEECLICKFIX_API_KEY = `${SSM_PREFIX}/seeclickfix-api-key`;

/** String. Browser origins allowed to call the MCP endpoint. Created by the CloudFormation stack. */
export const PARAM_ALLOWED_ORIGINS = `${SSM_PREFIX}/allowed-origins`;

/**
 * Parameters that exist outside CloudFormation (it cannot create SecureString values), so
 * `make destroy` has to remove them itself.
 */
export const SCRIPT_MANAGED_PARAMS = [
  PARAM_MCP_BEARER_TOKEN,
  PARAM_BOSTON_OPEN311_API_KEY,
  PARAM_SEECLICKFIX_API_KEY,
] as const;
