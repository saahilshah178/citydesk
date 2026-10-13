/**
 * Works out which Bedrock resources `bedrock:InvokeModel` has to be allowed on for a given
 * BEDROCK_MODEL_ID, so the client API role is scoped to that one model.
 *
 * The value can take several shapes:
 *
 *   amazon.nova-lite-v1:0                          a foundation model ID
 *   us.amazon.nova-lite-v1:0                       a cross-Region (system-defined) inference profile ID
 *   global.anthropic.claude-sonnet-4-5-20250929-v1:0   a global inference profile ID
 *   arn:aws:bedrock:...                            a full ARN of any of the above
 *
 * An inference profile needs two things (Bedrock user guide, "Prerequisites for inference
 * profiles"): the profile ARN in the calling account and Region, and the underlying foundation
 * model ARN in every Region the profile can route to. The destination Regions are not knowable at
 * synth time without an API call, so the foundation model is allowed in any Region but only when
 * the call arrives through this profile (`bedrock:InferenceProfileArn`). A global profile also
 * needs the Region-less ARN `arn:aws:bedrock:::foundation-model/<id>`.
 */

/** How a BEDROCK_MODEL_ID value was understood. */
export type BedrockTargetKind = 'foundation-model' | 'inference-profile' | 'ambiguous' | 'arn';

/** One IAM statement's worth of `bedrock:InvokeModel` access. */
export interface BedrockGrant {
  readonly sid: string;
  readonly resources: string[];
  readonly conditions?: Record<string, Record<string, string>>;
}

export interface ArnParts {
  readonly partition: string;
  readonly region: string;
  readonly account: string;
}

/**
 * Prefixes AWS uses for system-defined inference profiles. The list only decides how tidy the
 * policy is: an ID with an unknown prefix falls into the "ambiguous" branch below, which still
 * works.
 */
export const INFERENCE_PROFILE_PREFIXES = ['global', 'us', 'us-gov', 'eu', 'apac', 'jp', 'au', 'ca'] as const;

export function classifyBedrockModelId(modelId: string): BedrockTargetKind {
  if (modelId.startsWith('arn:')) return 'arn';
  const segments = modelId.split('.');
  // "<provider>.<model>" has one dot; a profile ID is "<geo>.<provider>.<model>" and has at least two.
  if (segments.length < 3) return 'foundation-model';
  if ((INFERENCE_PROFILE_PREFIXES as readonly string[]).includes(segments[0] ?? '')) return 'inference-profile';
  // Either a profile with a prefix this list does not know yet, or a plain model whose name
  // contains a dot. Both readings are granted.
  return 'ambiguous';
}

/** Drops the first dot-separated segment: `us.amazon.nova-lite-v1:0` becomes `amazon.nova-lite-v1:0`. */
function withoutFirstSegment(id: string): string {
  return id.slice(id.indexOf('.') + 1);
}

function viaProfile(profileArn: string): Record<string, Record<string, string>> {
  return { StringLike: { 'bedrock:InferenceProfileArn': profileArn } };
}

/**
 * The statements the client API role needs for `bedrock:InvokeModel` on `modelId`.
 * `parts` may hold CloudFormation tokens; the values are only ever concatenated.
 */
export function bedrockInvokeGrants(modelId: string, parts: ArnParts): BedrockGrant[] {
  const { partition, region, account } = parts;
  const base = `arn:${partition}:bedrock`;
  const modelIn = (where: string, id: string) => `${base}:${where}::foundation-model/${id}`;
  const profileArnFor = (id: string) => `${base}:${region}:${account}:inference-profile/${id}`;

  const profileGrants = (profileArn: string, profileId: string): BedrockGrant[] => {
    const model = withoutFirstSegment(profileId);
    const models = [modelIn('*', model)];
    if (profileId.startsWith('global.')) models.push(modelIn('', model));
    return [
      { sid: 'InvokeAssistantInferenceProfile', resources: [profileArn] },
      { sid: 'InvokeAssistantModelThroughProfile', resources: models, conditions: viaProfile(profileArn) },
    ];
  };

  switch (classifyBedrockModelId(modelId)) {
    case 'foundation-model':
      return [{ sid: 'InvokeAssistantModel', resources: [modelIn(region, modelId)] }];

    case 'inference-profile':
      return profileGrants(profileArnFor(modelId), modelId);

    case 'ambiguous': {
      const rest = withoutFirstSegment(modelId);
      const profileArn = profileArnFor(modelId);
      return [
        { sid: 'InvokeAssistantModel', resources: [modelIn(region, modelId), profileArn] },
        {
          sid: 'InvokeAssistantModelThroughProfile',
          resources: [modelIn('*', rest), modelIn('', rest)],
          conditions: viaProfile(profileArn),
        },
      ];
    }

    case 'arn': {
      // ":inference-profile/" does not match an application profile, whose resource type is
      // "application-inference-profile".
      const systemProfileId = /:inference-profile\/(.+)$/.exec(modelId)?.[1];
      if (systemProfileId) return profileGrants(modelId, systemProfileId);
      if (modelId.includes(':application-inference-profile/')) {
        // The model behind an application inference profile is not part of its ARN. Any foundation
        // model is allowed, but only for calls made through this one profile.
        return [
          { sid: 'InvokeAssistantInferenceProfile', resources: [modelId] },
          {
            sid: 'InvokeAssistantModelThroughProfile',
            resources: [modelIn('*', '*'), modelIn('', '*')],
            conditions: viaProfile(modelId),
          },
        ];
      }
      return [{ sid: 'InvokeAssistantModel', resources: [modelId] }];
    }
  }
}
