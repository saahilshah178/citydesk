import { existsSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as location from 'aws-cdk-lib/aws-location';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

import { bedrockInvokeGrants } from './bedrock.ts';
import { ConfigError, DEFAULTS } from './config.ts';
import { REPO_ROOT } from './env.ts';
import { PARAM_ALLOWED_ORIGINS, SSM_PREFIX } from './params.ts';

/** Executables of this package's dev dependencies (esbuild among them). */
const INFRA_BIN = join(REPO_ROOT, 'infra', 'node_modules', '.bin');

/** Where the application code lives, relative to the repo root. */
export const DEFAULT_PATHS = {
  mcpEntry: 'apps/citydesk/src/lambda.ts',
  clientApiEntry: 'apps/sim-client/server/lambda.ts',
  clientDist: 'apps/sim-client/dist',
} as const;

export interface CityDeskStackProps extends cdk.StackProps {
  /** Bedrock model ID, inference profile ID, or ARN for the assistant. Required. */
  readonly bedrockModelId: string;
  /** MCP server Lambda entry file. Default: apps/citydesk/src/lambda.ts in this repo. */
  readonly mcpEntry?: string;
  /** Client API Lambda entry file. Default: apps/sim-client/server/lambda.ts in this repo. */
  readonly clientApiEntry?: string;
  /** Built static client directory. Default: apps/sim-client/dist in this repo. */
  readonly clientDist?: string;
  /** Default: citydesk-user-requests. */
  readonly tableName?: string;
  /** Default: citydesk-places. */
  readonly placeIndexName?: string;
  /** Default: Joanna. */
  readonly pollyVoiceId?: string;
  /** Default: neural. */
  readonly pollyEngine?: string;
  /** Default: 2000. */
  readonly demoDailyRequestCap?: number;
}

/**
 * Everything CityDesk runs on. Nothing here has a standing monthly charge: no VPC, NAT gateway,
 * API Gateway, Secrets Manager, WAF or customer managed KMS key, and no reserved concurrency.
 */
export class CityDeskStack extends cdk.Stack {
  readonly table: dynamodb.Table;
  readonly placeIndex: location.CfnPlaceIndex;
  readonly mcpFunction: nodejs.NodejsFunction;
  readonly clientApiFunction: nodejs.NodejsFunction;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CityDeskStackProps) {
    super(scope, id, props);

    const mcpEntry = requireFile(
      props.mcpEntry ?? join(REPO_ROOT, DEFAULT_PATHS.mcpEntry),
      'MCP server Lambda entry',
      'Pass -c mcpEntry=<file> to point at a different handler.',
    );
    const clientApiEntry = requireFile(
      props.clientApiEntry ?? join(REPO_ROOT, DEFAULT_PATHS.clientApiEntry),
      'Client API Lambda entry',
      'Pass -c clientApiEntry=<file> to point at a different handler.',
    );
    const clientDist = requireDirectory(
      props.clientDist ?? join(REPO_ROOT, DEFAULT_PATHS.clientDist),
      'Static client build',
      'Run `make build` (or `pnpm --filter @citydesk/sim-client build`) first, or pass -c clientDist=<dir>.',
    );

    cdk.Tags.of(this).add('project', 'citydesk');

    // ---- 1. DynamoDB: each user's filed and followed requests ----------------------------------
    // Provisioned 5/5 sits inside the always-free 25 RCU / 25 WCU. On-demand has no free allowance.
    this.table = new dynamodb.Table(this, 'UserRequests', {
      tableName: props.tableName ?? DEFAULTS.tableName,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      // Inside the always-free allowance (25 of each per Region), with headroom for the counters
      // that cap spend: those must keep working when the demo is busy.
      readCapacity: 10,
      writeCapacity: 10,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ---- 2. Amazon Location place index (classic Places API, SearchPlaceIndexForText) ----------
    // IntendedUse "Storage" because geocoded coordinates are saved with each filed request. The
    // default, "SingleUse", declares that results will not be stored. Storage is billed at a higher
    // rate per request (see docs/aws.md).
    this.placeIndex = new location.CfnPlaceIndex(this, 'Places', {
      indexName: props.placeIndexName ?? DEFAULTS.placeIndexName,
      dataSource: 'Esri',
      dataSourceConfiguration: { intendedUse: 'Storage' },
      description: 'CityDesk geocoder for spoken addresses and landmarks. Results are stored.',
    });

    // ---- 3. MCP server Lambda ------------------------------------------------------------------
    this.mcpFunction = this.nodeFunction('Mcp', {
      description: 'CityDesk MCP server (Streamable HTTP) for Open311 city services',
      entry: mcpEntry,
      timeout: cdk.Duration.seconds(20),
      // The Boston address index built by `pnpm sync:addresses`. The handler loads it from beside
      // the bundle and falls back to live lookups on data.boston.gov when it is not there.
      copyFiles: [join(REPO_ROOT, '.citydesk', 'addresses.json.gz')],
      environment: {
        CITYDESK_STORE: 'dynamodb',
        CITYDESK_TABLE: this.table.tableName,
        LOCATION_PLACE_INDEX: this.placeIndex.indexName,
        CITYDESK_SSM_PREFIX: SSM_PREFIX,
        ALLOW_PRODUCTION_WRITES: 'false',
      },
    });
    this.mcpFunction.node.addDependency(this.placeIndex);

    this.mcpFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'UserRequestsTableReadWrite',
        actions: [
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
        resources: [this.table.tableArn],
      }),
    );
    this.mcpFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'GeocodeWithPlaceIndex',
        actions: ['geo:SearchPlaceIndexForText'],
        resources: [this.placeIndex.attrArn],
      }),
    );
    this.mcpFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'StaticMaps',
        actions: ['geo-maps:GetStaticMap'],
        // The Maps API has a single resource per Region and no account in its ARN.
        resources: [this.formatArn({ service: 'geo-maps', account: '', resource: 'provider', resourceName: 'default' })],
      }),
    );
    for (const statement of this.parameterReadStatements()) this.mcpFunction.addToRolePolicy(statement);

    // Auth is NONE on purpose: the handler checks a bearer token and validates Origin itself.
    const mcpUrl = this.mcpFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.BUFFERED,
    });

    // ---- 4. Client API Lambda (assistant turns through Bedrock, speech through Polly) -----------
    this.clientApiFunction = this.nodeFunction('ClientApi', {
      description: 'CityDesk web client backend: Bedrock assistant and Polly speech',
      entry: clientApiEntry,
      timeout: cdk.Duration.seconds(30),
      environment: {
        BEDROCK_MODEL_ID: props.bedrockModelId,
        POLLY_VOICE_ID: props.pollyVoiceId ?? DEFAULTS.pollyVoiceId,
        POLLY_ENGINE: props.pollyEngine ?? DEFAULTS.pollyEngine,
        CITYDESK_SSM_PREFIX: SSM_PREFIX,
        DEMO_DAILY_REQUEST_CAP: String(props.demoDailyRequestCap ?? DEFAULTS.demoDailyRequestCap),
        // The browser reaches the MCP server on the page's own origin, through the /mcp behaviour.
        MCP_URL: '/mcp',
        // Set by the CloudFront function below; the per-address rate limit keys on it.
        CLIENT_IP_HEADER: 'x-viewer-ip',
        // The daily request cap is one atomic counter in the table, shared by every warm instance.
        CITYDESK_TABLE: this.table.tableName,
      },
    });
    this.clientApiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'CountDailyRequests',
        actions: ['dynamodb:UpdateItem'],
        resources: [this.table.tableArn],
        // Only items in the COUNTER partition: this function cannot read or change anyone's requests.
        conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['COUNTER'] } },
      }),
    );

    const grants = bedrockInvokeGrants(props.bedrockModelId, {
      partition: this.partition,
      region: this.region,
      account: this.account,
    });
    for (const grant of grants) {
      this.clientApiFunction.addToRolePolicy(
        new iam.PolicyStatement({
          sid: grant.sid,
          actions: ['bedrock:InvokeModel'],
          resources: grant.resources,
          conditions: grant.conditions,
        }),
      );
    }
    this.clientApiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'SynthesizeSpeech',
        actions: ['polly:SynthesizeSpeech'],
        // SynthesizeSpeech only supports resource-level permissions for custom lexicons, which
        // CityDesk does not use.
        resources: ['*'],
      }),
    );
    for (const statement of this.parameterReadStatements()) this.clientApiFunction.addToRolePolicy(statement);

    const clientApiUrl = this.clientApiFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.BUFFERED,
    });

    // ---- 5. Static client: private S3 bucket behind CloudFront -----------------------------------
    const siteBucket = new s3.Bucket(this, 'ClientBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // /api/* and /mcp go to the Function URLs through the same distribution, so the browser only
    // ever talks to one origin. Nothing is cached, and every viewer header except Host is passed on
    // (Authorization, Origin, MCP-Protocol-Version, Mcp-Session-Id, Accept, X-CityDesk-Device, ...).
    // A Function URL rejects a Host header that is not its own, hence "except Host".
    // Behind CloudFront the functions see an edge node's address, not the visitor's. This function
    // writes the visitor's address into a header (replacing anything the visitor sent under that
    // name), so the per-visitor rate limits have something to key on. A caller who goes straight to
    // a Function URL can make the header up, which is why the functions also limit by the address
    // the connection really came from and enforce daily ceilings that no header can dodge.
    const viewerAddress = new cloudfront.Function(this, 'ViewerAddress', {
      comment: 'CityDesk: pass the visitor address to the origin as x-viewer-ip',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event) { var request = event.request; request.headers['x-viewer-ip'] = { value: event.viewer.ip }; return request; }",
      ),
    });

    const functionBehavior = (origin: cloudfront.IOrigin): cloudfront.BehaviorOptions => ({
      origin,
      functionAssociations: [{ function: viewerAddress, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      // A bearer token must never travel in clear text, so plain HTTP is refused, not redirected.
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'CityDesk: static client, /api/* (client API) and /mcp (MCP server)',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        // The origin waits a little longer than the function may run (30 s), so a slow model turn
        // comes back as the function's own answer instead of a CloudFront 504.
        '/api/*': functionBehavior(new origins.FunctionUrlOrigin(clientApiUrl, { readTimeout: cdk.Duration.seconds(35) })),
        '/mcp': functionBehavior(new origins.FunctionUrlOrigin(mcpUrl, { readTimeout: cdk.Duration.seconds(30) })),
      },
      // No custom error responses: they apply to every behaviour and would turn the MCP server's
      // 403 and 404 answers into index.html.
    });

    new s3deploy.BucketDeployment(this, 'DeployClient', {
      sources: [s3deploy.Source.asset(clientDist)],
      destinationBucket: siteBucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      prune: true,
      logGroup: new logs.LogGroup(this, 'DeployClientLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // ---- 6. Allowed browser origins, read by the MCP Lambda at cold start -----------------------
    // A parameter instead of an environment variable: the distribution depends on the function's
    // URL, so the function cannot also depend on the distribution's domain name.
    const clientUrl = `https://${this.distribution.distributionDomainName}`;
    new ssm.StringParameter(this, 'AllowedOrigins', {
      parameterName: PARAM_ALLOWED_ORIGINS,
      stringValue: clientUrl,
      description: 'Browser origins allowed to call the CityDesk MCP endpoint, comma-separated.',
    });

    // ---- 7. Outputs ----------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ClientUrl', { value: clientUrl, description: 'CityDesk web client' });
    new cdk.CfnOutput(this, 'McpUrl', {
      value: `${clientUrl}/mcp`,
      description: 'MCP endpoint through CloudFront (same origin as the client)',
    });
    new cdk.CfnOutput(this, 'McpFunctionUrl', {
      // A Function URL ends with a slash.
      value: `${mcpUrl.url}mcp`,
      description: 'MCP endpoint directly on the Lambda Function URL',
    });
    new cdk.CfnOutput(this, 'TableName', { value: this.table.tableName, description: 'DynamoDB table' });
    new cdk.CfnOutput(this, 'PlaceIndexName', {
      value: this.placeIndex.indexName,
      description: 'Amazon Location place index',
    });
  }

  /**
   * A Node.js Lambda bundled with esbuild as one ES module. The role is created here instead of
   * taking CDK's default, which attaches AWSLambdaBasicExecutionRole (log actions on every log
   * group in the account). This one can only write to its own log group.
   */
  private nodeFunction(
    id: string,
    options: {
      description: string;
      entry: string;
      timeout: cdk.Duration;
      environment: Record<string, string>;
      /** Files copied next to the bundled handler. Paths that do not exist at synth time are skipped. */
      copyFiles?: string[];
    },
  ): nodejs.NodejsFunction {
    const copyFiles = (options.copyFiles ?? []).filter((file) => existsSync(file));
    const logGroup = new logs.LogGroup(this, `${id}Logs`, {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const role = new iam.Role(this, `${id}Role`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Execution role of the CityDesk ${id} function`,
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteOwnLogs',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [logGroup.logGroupArn],
      }),
    );

    return new nodejs.NodejsFunction(this, `${id}Function`, {
      description: options.description,
      entry: options.entry,
      handler: 'handler',
      // Newest Node.js runtime in aws-cdk-lib 2.273.0 and the newest one that is generally
      // available on Lambda. nodejs26.x is only a public preview as of October 2026.
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: options.timeout,
      environment: options.environment,
      role,
      logGroup,
      depsLockFilePath: join(REPO_ROOT, 'pnpm-lock.yaml'),
      projectRoot: REPO_ROOT,
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node24',
        mainFields: ['module', 'main'],
        // Ship the SDK version from the lockfile instead of whatever the runtime image carries.
        bundleAwsSDK: true,
        // CommonJS dependencies inside an ES module bundle still call require() for Node built-ins.
        // Defined on globalThis so it cannot collide with a `require` the bundled code declares.
        banner:
          "import { createRequire as __citydeskCreateRequire } from 'node:module'; globalThis.require ??= __citydeskCreateRequire(import.meta.url);",
        // CDK runs esbuild as `pnpm exec esbuild` from the repo root (where pnpm-lock.yaml is).
        // esbuild is a dev dependency of this package, not of the root, so pnpm only finds it when
        // infra/node_modules/.bin is on PATH. That is true under `pnpm exec cdk` and false when the
        // CDK CLI is started any other way, so the directory is added here for the bundling step.
        environment: { PATH: `${INFRA_BIN}${delimiter}${process.env.PATH ?? ''}` },
        commandHooks: {
          beforeInstall: () => [],
          beforeBundling: () => [],
          afterBundling: (_inputDir: string, outputDir: string) =>
            copyFiles.map((file) => `cp ${JSON.stringify(file)} ${JSON.stringify(outputDir)}`),
        },
      },
    });
  }

  /**
   * Read access to /citydesk/* in Parameter Store, including SecureString values encrypted with
   * the AWS managed key (alias/aws/ssm). Decrypt is only allowed when Parameter Store asks on the
   * function's behalf and the ciphertext belongs to a /citydesk/ parameter.
   */
  private parameterReadStatements(): iam.PolicyStatement[] {
    const parameters = this.formatArn({
      service: 'ssm',
      resource: 'parameter',
      // SSM_PREFIX starts with a slash and the ARN format is "parameter/<name without the slash>".
      resourceName: `${SSM_PREFIX.slice(1)}/*`,
    });
    return [
      new iam.PolicyStatement({
        sid: 'ReadCityDeskParameters',
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [parameters],
      }),
      new iam.PolicyStatement({
        sid: 'DecryptCityDeskParameters',
        actions: ['kms:Decrypt'],
        resources: [this.formatArn({ service: 'kms', resource: 'key', resourceName: '*' })],
        conditions: {
          StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` },
          StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': parameters },
        },
      }),
    ];
  }
}

function requireFile(path: string, what: string, hint: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new ConfigError(`${what} not found at ${absolute}. ${hint}`);
  }
  return absolute;
}

function requireDirectory(path: string, what: string, hint: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new ConfigError(`${what} not found at ${absolute}. ${hint}`);
  }
  return absolute;
}
