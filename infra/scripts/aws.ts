/** Small helpers shared by the deploy scripts. */

const CREDENTIAL_ERRORS = new Set([
  'CredentialsProviderError',
  'ExpiredToken',
  'ExpiredTokenException',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'InvalidSignatureException',
  'SignatureDoesNotMatch',
  'TokenProviderError',
]);

export const CREDENTIALS_HINT = [
  'Provide credentials in one of these ways, then run the command again:',
  '  - export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (plus AWS_SESSION_TOKEN for temporary keys)',
  '  - export AWS_PROFILE=<name> for a profile in ~/.aws/config (run `aws sso login` first for SSO)',
  'The repo-root .env is loaded too, so the variables can live there.',
].join('\n');

export function isCredentialsError(error: unknown): boolean {
  return error instanceof Error && CREDENTIAL_ERRORS.has(error.name);
}

/** One or more readable lines for an AWS SDK failure. AWS error messages do not contain secrets. */
export function describeAwsError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (isCredentialsError(error)) {
    return `No usable AWS credentials (${error.name}: ${error.message}).\n${CREDENTIALS_HINT}`;
  }
  return `${error.name}: ${error.message}`;
}

/** Prints a failure and exits non-zero. */
export function fail(message: string): never {
  console.error(`\nCityDesk infra: ${message}\n`);
  process.exit(1);
}
