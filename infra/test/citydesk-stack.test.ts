/**
 * Assertions on the synthesized CloudFormation template.
 *
 * The real Lambda entries (apps/citydesk/src/lambda.ts, apps/sim-client/server/lambda.ts) and the
 * built client (apps/sim-client/dist) are not needed: every test points the stack at tiny stand-ins
 * written to a temporary directory inside infra/, which is removed afterwards.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CityDeskStack } from '../lib/citydesk-stack.ts';
import type { CityDeskStackProps } from '../lib/citydesk-stack.ts';
import { ConfigError } from '../lib/config.ts';

const INFRA_DIR = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(INFRA_DIR, '..');
const MODEL_ID = 'us.example.test-model-v1:0';

/** CloudFront managed policy IDs, from the CloudFront developer guide. */
const CACHING_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6';
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const ALL_VIEWER_EXCEPT_HOST_HEADER = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';

type Resource = { Type: string; Properties: Record<string, any>; DeletionPolicy?: string; DependsOn?: string[] };
type Statement = { Sid?: string; Action: string | string[]; Resource: unknown; Effect: string; Condition?: unknown };

/** The same feature flags a real `cdk synth` gets from cdk.json. */
const cdkJsonContext = JSON.parse(readFileSync(join(INFRA_DIR, 'cdk.json'), 'utf8')).context as Record<string, unknown>;

let workDir: string;
let stubs: Pick<CityDeskStackProps, 'mcpEntry' | 'clientApiEntry' | 'clientDist'>;
let template: Template;
let outdir: string;

function synth(props: Partial<CityDeskStackProps> = {}, options: { bundle?: boolean; outdir?: string } = {}): Template {
  const app = new cdk.App({
    outdir: options.outdir,
    context: {
      ...cdkJsonContext,
      // An empty list tells CDK to skip asset bundling for every stack.
      ...(options.bundle === false ? { 'aws:cdk:bundling-stacks': [] } : {}),
    },
  });
  const stack = new CityDeskStack(app, 'CityDeskTest', { bedrockModelId: MODEL_ID, ...stubs, ...props });
  return Template.fromStack(stack);
}

function only(resources: Record<string, unknown>): [string, Resource] {
  const entries = Object.entries(resources);
  expect(entries).toHaveLength(1);
  return entries[0] as [string, Resource];
}

/** The inline policy statements of the execution role of the function matched by `functionProps`. */
function roleStatements(t: Template, functionProps: Record<string, unknown>): Statement[] {
  const [, fn] = only(t.findResources('AWS::Lambda::Function', { Properties: functionProps }));
  const roleId = fn.Properties.Role['Fn::GetAtt'][0] as string;
  const role = t.findResources('AWS::IAM::Role')[roleId] as Resource;
  // No managed policies: everything the function may do is in the statements returned here.
  expect(role.Properties.ManagedPolicyArns).toBeUndefined();
  expect(role.Properties.Policies).toBeUndefined();
  const [, policy] = only(t.findResources('AWS::IAM::Policy', { Properties: { Roles: [{ Ref: roleId }] } }));
  return policy.Properties.PolicyDocument.Statement as Statement[];
}

const arn = (...parts: unknown[]) => ({ 'Fn::Join': ['', parts] });
const PARTITION = { Ref: 'AWS::Partition' };
const REGION = { Ref: 'AWS::Region' };
const ACCOUNT = { Ref: 'AWS::AccountId' };
const PARAMETERS_ARN = arn('arn:', PARTITION, ':ssm:', REGION, ':', ACCOUNT, ':parameter/citydesk/*');

const PARAMETER_STATEMENTS: Statement[] = [
  {
    Sid: 'ReadCityDeskParameters',
    Effect: 'Allow',
    Action: ['ssm:GetParameter', 'ssm:GetParameters'],
    Resource: PARAMETERS_ARN,
  },
  {
    Sid: 'DecryptCityDeskParameters',
    Effect: 'Allow',
    Action: 'kms:Decrypt',
    Resource: arn('arn:', PARTITION, ':kms:', REGION, ':', ACCOUNT, ':key/*'),
    Condition: {
      StringEquals: { 'kms:ViaService': arn('ssm.', REGION, '.amazonaws.com') },
      StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': PARAMETERS_ARN },
    },
  },
];

const MCP_FUNCTION = { Environment: { Variables: Match.objectLike({ CITYDESK_STORE: 'dynamodb' }) } };
const CLIENT_API_FUNCTION = { Environment: { Variables: Match.objectLike({ BEDROCK_MODEL_ID: Match.anyValue() }) } };

beforeAll(() => {
  workDir = mkdtempSync(join(INFRA_DIR, '.tmp-test-'));
  // The MCP stand-in pulls in a CommonJS module that calls require() for a Node built-in, the case
  // the bundling banner exists for.
  writeFileSync(
    join(workDir, 'cjs-dep.cjs'),
    "const os = require('node:os');\nmodule.exports = { platform: () => os.platform() };\n",
  );
  writeFileSync(
    join(workDir, 'mcp-lambda.ts'),
    "import dep from './cjs-dep.cjs';\nexport const handler = async () => ({ statusCode: 200, body: dep.platform() });\n",
  );
  writeFileSync(join(workDir, 'api-lambda.ts'), "export const handler = async () => ({ statusCode: 200, body: 'ok' });\n");
  mkdirSync(join(workDir, 'client-dist'));
  writeFileSync(join(workDir, 'client-dist', 'index.html'), '<!doctype html><title>CityDesk test</title>\n');
  stubs = {
    mcpEntry: join(workDir, 'mcp-lambda.ts'),
    clientApiEntry: join(workDir, 'api-lambda.ts'),
    clientDist: join(workDir, 'client-dist'),
  };
  outdir = join(workDir, 'cdk.out');

  // CDK bundles with `pnpm exec esbuild` from the repo root, where esbuild is not a dependency.
  // `pnpm test` puts infra/node_modules/.bin on PATH, which hides that. Drop every PATH entry inside
  // the repo so this synth only works if the stack itself points the bundler at esbuild, as it must
  // when the Makefile starts the CDK CLI without pnpm.
  const inheritedPath = process.env.PATH;
  process.env.PATH = (inheritedPath ?? '')
    .split(delimiter)
    .filter((entry) => !entry.startsWith(REPO_ROOT))
    .join(delimiter);
  try {
    template = synth({}, { outdir });
  } finally {
    process.env.PATH = inheritedPath;
  }
});

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('DynamoDB table', () => {
  it('has pk/sk string keys, a ttl attribute and provisioned 5/5 capacity', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'citydesk-user-requests',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 },
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      BillingMode: Match.absent(),
    });
  });

  it('is deleted with the stack', () => {
    template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
  });
});

describe('Amazon Location place index', () => {
  it('uses Esri and declares that results are stored', () => {
    template.resourceCountIs('AWS::Location::PlaceIndex', 1);
    template.hasResourceProperties('AWS::Location::PlaceIndex', {
      IndexName: 'citydesk-places',
      DataSource: 'Esri',
      DataSourceConfiguration: { IntendedUse: 'Storage' },
    });
  });
});

describe('Lambda functions', () => {
  it('defines exactly two application functions, each with a public Function URL', () => {
    const appFunctions = template.findResources('AWS::Lambda::Function', {
      Properties: { Runtime: 'nodejs24.x', Architectures: ['arm64'], Handler: 'index.handler' },
    });
    expect(Object.keys(appFunctions)).toHaveLength(2);

    template.resourceCountIs('AWS::Lambda::Url', 2);
    for (const id of Object.keys(appFunctions)) {
      const target = { 'Fn::GetAtt': [id, 'Arn'] };
      template.hasResourceProperties('AWS::Lambda::Url', {
        TargetFunctionArn: target,
        AuthType: 'NONE',
        InvokeMode: 'BUFFERED',
        Cors: Match.absent(),
      });
      // Function URLs created since October 2025 need both permissions, even with auth NONE.
      template.hasResourceProperties('AWS::Lambda::Permission', {
        FunctionName: target,
        Action: 'lambda:InvokeFunctionUrl',
        Principal: '*',
        FunctionUrlAuthType: 'NONE',
      });
      template.hasResourceProperties('AWS::Lambda::Permission', {
        FunctionName: target,
        Action: 'lambda:InvokeFunction',
        Principal: '*',
        InvokedViaFunctionUrl: true,
      });
    }
    template.resourceCountIs('AWS::Lambda::Permission', 4);
  });

  it('configures the MCP server function', () => {
    const [tableId] = only(template.findResources('AWS::DynamoDB::Table'));
    const [, fn] = only(template.findResources('AWS::Lambda::Function', { Properties: MCP_FUNCTION }));
    expect(fn.Properties).toMatchObject({
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      Handler: 'index.handler',
      MemorySize: 512,
      Timeout: 20,
      Environment: {
        Variables: {
          CITYDESK_STORE: 'dynamodb',
          CITYDESK_TABLE: { Ref: tableId },
          LOCATION_PLACE_INDEX: 'citydesk-places',
          CITYDESK_SSM_PREFIX: '/citydesk',
          ALLOW_PRODUCTION_WRITES: 'false',
        },
      },
    });
    expect(Object.keys(fn.Properties.Environment.Variables)).toHaveLength(5);
    expect(fn.Properties.ReservedConcurrentExecutions).toBeUndefined();
    expect(fn.Properties.VpcConfig).toBeUndefined();
  });

  it('configures the client API function', () => {
    const [, fn] = only(template.findResources('AWS::Lambda::Function', { Properties: CLIENT_API_FUNCTION }));
    expect(fn.Properties).toMatchObject({
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      Handler: 'index.handler',
      MemorySize: 512,
      Timeout: 30,
      Environment: {
        Variables: {
          BEDROCK_MODEL_ID: MODEL_ID,
          POLLY_VOICE_ID: 'Joanna',
          POLLY_ENGINE: 'neural',
          CITYDESK_SSM_PREFIX: '/citydesk',
          DEMO_DAILY_REQUEST_CAP: '600',
          MCP_URL: '/mcp',
          CLIENT_IP_HEADER: 'x-viewer-ip',
          CITYDESK_TABLE: { Ref: only(template.findResources('AWS::DynamoDB::Table'))[0] },
        },
      },
    });
    expect(Object.keys(fn.Properties.Environment.Variables)).toHaveLength(8);
    expect(fn.Properties.ReservedConcurrentExecutions).toBeUndefined();
    expect(fn.Properties.VpcConfig).toBeUndefined();
  });

  it('passes deployer overrides through to the client API function', () => {
    const custom = synth({ pollyVoiceId: 'Matthew', pollyEngine: 'generative', demoDailyRequestCap: 50 }, { bundle: false });
    custom.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ POLLY_VOICE_ID: 'Matthew', POLLY_ENGINE: 'generative', DEMO_DAILY_REQUEST_CAP: '50' }),
      },
    });
  });

  it('keeps each function log group for two weeks and deletes it with the stack', () => {
    for (const functionProps of [MCP_FUNCTION, CLIENT_API_FUNCTION]) {
      const [, fn] = only(template.findResources('AWS::Lambda::Function', { Properties: functionProps }));
      const logGroupId = fn.Properties.LoggingConfig.LogGroup.Ref as string;
      const logGroup = template.findResources('AWS::Logs::LogGroup')[logGroupId] as Resource;
      expect(logGroup.Properties.RetentionInDays).toBe(14);
      expect(logGroup.DeletionPolicy).toBe('Delete');
    }
  });

  it('bundles each entry as a loadable ES module that exports handler', () => {
    const bundles = readdirSync(outdir)
      .filter((name) => name.startsWith('asset.'))
      .map((name) => join(outdir, name, 'index.mjs'))
      .filter((file) => {
        try {
          return readFileSync(file, 'utf8').includes('handler');
        } catch {
          return false;
        }
      });
    expect(bundles).toHaveLength(2);

    const bodies: string[] = [];
    for (const file of bundles) {
      expect(readFileSync(file, 'utf8')).toContain('globalThis.require ??=');
      // Load the bundle in a fresh Node process, as an ES module, and call the handler. A test runner
      // can inject its own `require`, which would hide a broken banner.
      const script = `const m = await import(${JSON.stringify(pathToFileURL(file).href)}); console.log(JSON.stringify(await m.handler()));`;
      const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      const result = JSON.parse(stdout) as { statusCode: number; body: string };
      expect(result.statusCode).toBe(200);
      bodies.push(result.body);
    }
    // 'ok' from the client API stand-in. The platform name comes from require('node:os') inside the
    // CommonJS dependency of the MCP stand-in, which only works because of the banner.
    expect(bodies.sort()).toEqual([process.platform, 'ok'].sort());
  });
});

describe('IAM: MCP server role', () => {
  it('grants exactly the documented statements', () => {
    const [tableId] = only(template.findResources('AWS::DynamoDB::Table'));
    const [placeIndexId] = only(template.findResources('AWS::Location::PlaceIndex'));
    const [, fn] = only(template.findResources('AWS::Lambda::Function', { Properties: MCP_FUNCTION }));
    const logGroupId = fn.Properties.LoggingConfig.LogGroup.Ref as string;

    expect(roleStatements(template, MCP_FUNCTION)).toEqual([
      {
        Sid: 'WriteOwnLogs',
        Effect: 'Allow',
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: { 'Fn::GetAtt': [logGroupId, 'Arn'] },
      },
      {
        Sid: 'UserRequestsTableReadWrite',
        Effect: 'Allow',
        Action: [
          'dynamodb:BatchGetItem',
          'dynamodb:BatchWriteItem',
          'dynamodb:ConditionCheckItem',
          'dynamodb:DeleteItem',
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
          'dynamodb:Scan',
          'dynamodb:UpdateItem',
        ],
        Resource: { 'Fn::GetAtt': [tableId, 'Arn'] },
      },
      {
        Sid: 'GeocodeWithPlaceIndex',
        Effect: 'Allow',
        Action: 'geo:SearchPlaceIndexForText',
        Resource: { 'Fn::GetAtt': [placeIndexId, 'Arn'] },
      },
      {
        Sid: 'StaticMaps',
        Effect: 'Allow',
        Action: 'geo-maps:GetStaticMap',
        Resource: arn('arn:', PARTITION, ':geo-maps:', REGION, '::provider/default'),
      },
      ...PARAMETER_STATEMENTS,
    ]);
  });
});

describe('IAM: client API role', () => {
  const logStatement = (t: Template): Statement => {
    const [, fn] = only(t.findResources('AWS::Lambda::Function', { Properties: CLIENT_API_FUNCTION }));
    return {
      Sid: 'WriteOwnLogs',
      Effect: 'Allow',
      Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      Resource: { 'Fn::GetAtt': [fn.Properties.LoggingConfig.LogGroup.Ref, 'Arn'] },
    };
  };
  const polly: Statement = { Sid: 'SynthesizeSpeech', Effect: 'Allow', Action: 'polly:SynthesizeSpeech', Resource: '*' };
  // The shared daily request cap: one atomic counter, and only in the COUNTER partition.
  const counter = (t: Template): Statement => ({
    Sid: 'CountDailyRequests',
    Effect: 'Allow',
    Action: 'dynamodb:UpdateItem',
    Resource: { 'Fn::GetAtt': [only(t.findResources('AWS::DynamoDB::Table'))[0], 'Arn'] },
    Condition: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['COUNTER'] } },
  });

  it('grants exactly the documented statements for a cross-Region inference profile ID', () => {
    const profile = arn('arn:', PARTITION, ':bedrock:', REGION, ':', ACCOUNT, `:inference-profile/${MODEL_ID}`);
    expect(roleStatements(template, CLIENT_API_FUNCTION)).toEqual([
      logStatement(template),
      counter(template),
      { Sid: 'InvokeAssistantInferenceProfile', Effect: 'Allow', Action: 'bedrock:InvokeModel', Resource: profile },
      {
        Sid: 'InvokeAssistantModelThroughProfile',
        Effect: 'Allow',
        Action: 'bedrock:InvokeModel',
        Resource: arn('arn:', PARTITION, ':bedrock:*::foundation-model/example.test-model-v1:0'),
        Condition: { StringLike: { 'bedrock:InferenceProfileArn': profile } },
      },
      polly,
      ...PARAMETER_STATEMENTS,
    ]);
  });

  it('scopes a plain foundation model ID to that model in the stack Region', () => {
    const plain = synth({ bedrockModelId: 'example.test-model-v1:0' }, { bundle: false });
    expect(roleStatements(plain, CLIENT_API_FUNCTION)).toEqual([
      logStatement(plain),
      counter(plain),
      {
        Sid: 'InvokeAssistantModel',
        Effect: 'Allow',
        Action: 'bedrock:InvokeModel',
        Resource: arn('arn:', PARTITION, ':bedrock:', REGION, '::foundation-model/example.test-model-v1:0'),
      },
      polly,
      ...PARAMETER_STATEMENTS,
    ]);
  });

  it('adds the Region-less model ARN for a global inference profile ID', () => {
    const id = 'global.example.test-model-v1:0';
    const global = synth({ bedrockModelId: id }, { bundle: false });
    const profile = arn('arn:', PARTITION, ':bedrock:', REGION, ':', ACCOUNT, `:inference-profile/${id}`);
    expect(roleStatements(global, CLIENT_API_FUNCTION)).toEqual([
      logStatement(global),
      counter(global),
      { Sid: 'InvokeAssistantInferenceProfile', Effect: 'Allow', Action: 'bedrock:InvokeModel', Resource: profile },
      {
        Sid: 'InvokeAssistantModelThroughProfile',
        Effect: 'Allow',
        Action: 'bedrock:InvokeModel',
        Resource: [
          arn('arn:', PARTITION, ':bedrock:*::foundation-model/example.test-model-v1:0'),
          arn('arn:', PARTITION, ':bedrock:::foundation-model/example.test-model-v1:0'),
        ],
        Condition: { StringLike: { 'bedrock:InferenceProfileArn': profile } },
      },
      polly,
      ...PARAMETER_STATEMENTS,
    ]);
  });
});

describe('static client and CloudFront distribution', () => {
  it('keeps the bucket private and readable only by this distribution', () => {
    const [bucketId] = only(template.findResources('AWS::S3::Bucket'));
    const [distributionId] = only(template.findResources('AWS::CloudFront::Distribution'));
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      WebsiteConfiguration: Match.absent(),
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      Bucket: { Ref: bucketId },
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 's3:GetObject',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Condition: {
              StringEquals: {
                'AWS:SourceArn': arn('arn:', PARTITION, ':cloudfront::', ACCOUNT, ':distribution/', { Ref: distributionId }),
              },
            },
          }),
        ]),
      },
    });
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: { OriginAccessControlOriginType: 's3', SigningBehavior: 'always', SigningProtocol: 'sigv4' },
    });
  });

  it('serves three behaviours: the bucket by default, /api/* and /mcp from the Function URLs', () => {
    const [bucketId] = only(template.findResources('AWS::S3::Bucket'));
    const [mcpId] = only(template.findResources('AWS::Lambda::Function', { Properties: MCP_FUNCTION }));
    const [apiId] = only(template.findResources('AWS::Lambda::Function', { Properties: CLIENT_API_FUNCTION }));
    const [mcpUrlId] = only(
      template.findResources('AWS::Lambda::Url', { Properties: { TargetFunctionArn: { 'Fn::GetAtt': [mcpId, 'Arn'] } } }),
    );
    const [apiUrlId] = only(
      template.findResources('AWS::Lambda::Url', { Properties: { TargetFunctionArn: { 'Fn::GetAtt': [apiId, 'Arn'] } } }),
    );

    const [, distribution] = only(template.findResources('AWS::CloudFront::Distribution'));
    const config = distribution.Properties.DistributionConfig;

    expect(config).toMatchObject({ Enabled: true, DefaultRootObject: 'index.html', PriceClass: 'PriceClass_100' });
    // Error responses are distribution-wide and would rewrite the MCP server's own 403/404 answers.
    expect(config.CustomErrorResponses).toBeUndefined();
    expect(config.Aliases).toBeUndefined();
    expect(config.WebACLId).toBeUndefined();
    expect(config.Logging).toBeUndefined();

    type Origin = { Id: string; DomainName: unknown; OriginAccessControlId?: unknown; CustomOriginConfig?: Record<string, unknown> };
    const origins = config.Origins as Origin[];
    expect(origins).toHaveLength(3);
    const originFor = (domainName: unknown) => {
      const origin = origins.find((candidate) => JSON.stringify(candidate.DomainName) === JSON.stringify(domainName));
      expect(origin).toBeDefined();
      return origin as Origin;
    };
    // A Function URL looks like https://<id>.lambda-url.<region>.on.aws/ and the origin is its host.
    const urlHost = (urlId: string) => ({ 'Fn::Select': [2, { 'Fn::Split': ['/', { 'Fn::GetAtt': [urlId, 'FunctionUrl'] }] }] });
    const bucketOrigin = originFor({ 'Fn::GetAtt': [bucketId, 'RegionalDomainName'] });
    const apiOrigin = originFor(urlHost(apiUrlId));
    const mcpOrigin = originFor(urlHost(mcpUrlId));

    expect(bucketOrigin.OriginAccessControlId).toBeDefined();
    for (const origin of [apiOrigin, mcpOrigin]) {
      // The Function URLs are public (auth NONE), so no origin access control signs these requests.
      expect(origin.OriginAccessControlId).toBeUndefined();
      expect(origin.CustomOriginConfig).toMatchObject({ OriginProtocolPolicy: 'https-only' });
    }
    expect(apiOrigin.CustomOriginConfig?.OriginReadTimeout).toBeGreaterThanOrEqual(30);
    expect(mcpOrigin.CustomOriginConfig?.OriginReadTimeout).toBeGreaterThanOrEqual(20);

    expect(config.DefaultCacheBehavior).toMatchObject({
      TargetOriginId: bucketOrigin.Id,
      CachePolicyId: CACHING_OPTIMIZED,
      ViewerProtocolPolicy: 'redirect-to-https',
    });
    expect(config.DefaultCacheBehavior.OriginRequestPolicyId).toBeUndefined();

    const allMethods = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'];
    const behaviours = config.CacheBehaviors as Array<Record<string, any>>;
    expect(behaviours.map((behaviour) => behaviour.PathPattern)).toEqual(['/api/*', '/mcp']);
    for (const [index, origin] of [apiOrigin, mcpOrigin].entries()) {
      const behaviour = behaviours[index] as Record<string, any>;
      expect(behaviour).toMatchObject({
        TargetOriginId: origin.Id,
        CachePolicyId: CACHING_DISABLED,
        OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST_HEADER,
        ViewerProtocolPolicy: 'https-only',
      });
      expect([...(behaviour.AllowedMethods as string[])].sort()).toEqual(allMethods);
      // Legacy forwarding settings must not sit next to the policies.
      expect(behaviour.ForwardedValues).toBeUndefined();
      // The visitor's address is handed to the origin on the way in.
      expect(behaviour.FunctionAssociations).toEqual([
        { EventType: 'viewer-request', FunctionARN: { 'Fn::GetAtt': [only(template.findResources('AWS::CloudFront::Function'))[0], 'FunctionARN'] } },
      ]);
    }
    // The static site needs no function.
    expect(config.DefaultCacheBehavior.FunctionAssociations).toBeUndefined();
  });

  it('forwards the visitor address with a CloudFront function that overwrites what the visitor sent', () => {
    const [, fn] = only(template.findResources('AWS::CloudFront::Function'));
    expect(fn.Properties.FunctionConfig.Runtime).toBe('cloudfront-js-2.0');
    expect(fn.Properties.AutoPublish).toBe(true);
    // Run the deployed code the way CloudFront would.
    const handler = new Function(`${fn.Properties.FunctionCode as string}; return handler;`)() as (event: unknown) => { headers: Record<string, { value: string }> };
    const out = handler({ viewer: { ip: '203.0.113.7' }, request: { method: 'POST', uri: '/mcp', headers: { 'x-viewer-ip': { value: '10.0.0.1' }, authorization: { value: 'Bearer t' } } } });
    expect(out.headers['x-viewer-ip']).toEqual({ value: '203.0.113.7' });
    expect(out.headers.authorization).toEqual({ value: 'Bearer t' });
  });

  it('uploads the built client and invalidates the distribution', () => {
    const [bucketId] = only(template.findResources('AWS::S3::Bucket'));
    const [distributionId] = only(template.findResources('AWS::CloudFront::Distribution'));
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      DestinationBucketName: { Ref: bucketId },
      DistributionId: { Ref: distributionId },
      DistributionPaths: ['/*'],
      Prune: true,
    });
  });
});

describe('SSM parameter', () => {
  it('stores the client origin as a plain String at /citydesk/allowed-origins', () => {
    const [distributionId] = only(template.findResources('AWS::CloudFront::Distribution'));
    template.resourceCountIs('AWS::SSM::Parameter', 1);
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/citydesk/allowed-origins',
      Type: 'String',
      Value: arn('https://', { 'Fn::GetAtt': [distributionId, 'DomainName'] }),
      Tier: Match.absent(),
    });
  });

  it('does not make either function depend on the distribution', () => {
    const [distributionId] = only(template.findResources('AWS::CloudFront::Distribution'));
    for (const functionProps of [MCP_FUNCTION, CLIENT_API_FUNCTION]) {
      const [, fn] = only(template.findResources('AWS::Lambda::Function', { Properties: functionProps }));
      expect(JSON.stringify(fn)).not.toContain(distributionId);
    }
  });
});

describe('outputs', () => {
  it('exposes the URLs, the table name and the place index name', () => {
    const [distributionId] = only(template.findResources('AWS::CloudFront::Distribution'));
    const [tableId] = only(template.findResources('AWS::DynamoDB::Table'));
    const [mcpId] = only(template.findResources('AWS::Lambda::Function', { Properties: MCP_FUNCTION }));
    const [mcpUrlId] = only(
      template.findResources('AWS::Lambda::Url', { Properties: { TargetFunctionArn: { 'Fn::GetAtt': [mcpId, 'Arn'] } } }),
    );
    const domain = { 'Fn::GetAtt': [distributionId, 'DomainName'] };

    template.hasOutput('ClientUrl', { Value: arn('https://', domain) });
    template.hasOutput('McpUrl', { Value: arn('https://', domain, '/mcp') });
    template.hasOutput('McpFunctionUrl', { Value: arn({ 'Fn::GetAtt': [mcpUrlId, 'FunctionUrl'] }, 'mcp') });
    template.hasOutput('TableName', { Value: { Ref: tableId } });
    template.hasOutput('PlaceIndexName', { Value: 'citydesk-places' });
  });
});

describe('cost guard rails', () => {
  it('contains no resource type with a standing monthly charge', () => {
    const types = new Set(Object.values(template.toJSON().Resources as Record<string, Resource>).map((r) => r.Type));
    const forbidden = [
      /^AWS::EC2::/, // VPC, NAT gateway, endpoints
      /^AWS::ApiGateway/,
      /^AWS::SecretsManager::/,
      /^AWS::WAF/,
      /^AWS::KMS::/, // a customer managed key costs a monthly fee
      /^AWS::ElasticLoadBalancing/,
      /^AWS::Route53::/,
      /^AWS::CertificateManager::/,
      /^AWS::ECS::|^AWS::RDS::|^AWS::ElastiCache::/,
    ];
    for (const type of types) {
      for (const pattern of forbidden) expect(type).not.toMatch(pattern);
    }
  });

  it('matches the expected resource inventory', () => {
    const counts: Record<string, number> = {};
    for (const resource of Object.values(template.toJSON().Resources as Record<string, Resource>)) {
      counts[resource.Type] = (counts[resource.Type] ?? 0) + 1;
    }
    expect(counts).toEqual({
      'AWS::CloudFront::Distribution': 1,
      'AWS::CloudFront::Function': 1,
      'AWS::CloudFront::OriginAccessControl': 1,
      'AWS::DynamoDB::Table': 1,
      'AWS::IAM::Policy': 3,
      'AWS::IAM::Role': 4,
      // Two application functions plus the two CDK custom resource handlers below.
      'AWS::Lambda::Function': 4,
      'AWS::Lambda::LayerVersion': 1,
      'AWS::Lambda::Permission': 4,
      'AWS::Lambda::Url': 2,
      'AWS::Location::PlaceIndex': 1,
      'AWS::Logs::LogGroup': 3,
      'AWS::S3::Bucket': 1,
      'AWS::S3::BucketPolicy': 1,
      'AWS::SSM::Parameter': 1,
      'Custom::CDKBucketDeployment': 1,
      'Custom::S3AutoDeleteObjects': 1,
    });
  });
});

describe('input validation', () => {
  it('names the missing file when a Lambda entry does not exist', () => {
    const missing = join(workDir, 'nope.ts');
    expect(() => synth({ mcpEntry: missing }, { bundle: false })).toThrow(ConfigError);
    expect(() => synth({ mcpEntry: missing }, { bundle: false })).toThrow(/MCP server Lambda entry not found at .*nope\.ts/);
    expect(() => synth({ clientApiEntry: missing }, { bundle: false })).toThrow(/Client API Lambda entry not found/);
  });

  it('tells the deployer to build the client when its dist directory is missing', () => {
    expect(() => synth({ clientDist: join(workDir, 'no-dist') }, { bundle: false })).toThrow(
      /Static client build not found at .*no-dist\. Run `make build`/,
    );
  });
});
