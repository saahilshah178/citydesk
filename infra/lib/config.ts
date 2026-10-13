import { nonEmpty } from './env.ts';

/** Settings the stack takes from the deployer's environment at synth time. */
export interface DeployConfig {
  /** Bedrock model ID, inference profile ID, or ARN the assistant calls. */
  readonly bedrockModelId: string;
  readonly pollyVoiceId: string;
  readonly pollyEngine: string;
  readonly demoDailyRequestCap: number;
  readonly tableName: string;
  readonly placeIndexName: string;
}

export const DEFAULTS = {
  pollyVoiceId: 'Joanna',
  pollyEngine: 'neural',
  // Metered requests (assistant turns and speech) per UTC day across all visitors. About 30 full
  // demo conversations; raise it with DEMO_DAILY_REQUEST_CAP if the demo gets busy.
  demoDailyRequestCap: 600,
  tableName: 'citydesk-user-requests',
  placeIndexName: 'citydesk-places',
} as const;

/** Engines Amazon Polly's SynthesizeSpeech accepts. */
const POLLY_ENGINES = ['standard', 'neural', 'long-form', 'generative'];

/** A problem with the deployer's settings. The message is written to be read on its own. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export const MISSING_MODEL_MESSAGE =
  'BEDROCK_MODEL_ID is not set. Export it, or add it to .env at the repo root, with the Bedrock ' +
  'model ID or inference profile ID the assistant should call. It becomes an environment variable ' +
  'of the client API Lambda and scopes its bedrock:InvokeModel permission. See docs/aws.md.';

export function loadDeployConfig(env: NodeJS.ProcessEnv = process.env): DeployConfig {
  const bedrockModelId = nonEmpty(env.BEDROCK_MODEL_ID);
  if (!bedrockModelId) throw new ConfigError(MISSING_MODEL_MESSAGE);
  if (/\s/.test(bedrockModelId)) {
    throw new ConfigError(`BEDROCK_MODEL_ID must not contain whitespace (got "${bedrockModelId}").`);
  }

  const pollyEngine = nonEmpty(env.POLLY_ENGINE) ?? DEFAULTS.pollyEngine;
  if (!POLLY_ENGINES.includes(pollyEngine)) {
    throw new ConfigError(`POLLY_ENGINE must be one of ${POLLY_ENGINES.join(', ')} (got "${pollyEngine}").`);
  }

  const capText = nonEmpty(env.DEMO_DAILY_REQUEST_CAP);
  const demoDailyRequestCap = capText === undefined ? DEFAULTS.demoDailyRequestCap : Number(capText);
  if (!Number.isInteger(demoDailyRequestCap) || demoDailyRequestCap < 1) {
    throw new ConfigError(`DEMO_DAILY_REQUEST_CAP must be a positive whole number (got "${capText}").`);
  }

  return {
    bedrockModelId,
    pollyVoiceId: nonEmpty(env.POLLY_VOICE_ID) ?? DEFAULTS.pollyVoiceId,
    pollyEngine,
    demoDailyRequestCap,
    tableName: nonEmpty(env.CITYDESK_TABLE) ?? DEFAULTS.tableName,
    placeIndexName: nonEmpty(env.LOCATION_PLACE_INDEX) ?? DEFAULTS.placeIndexName,
  };
}
