# CityDesk on AWS

Everything CityDesk runs on is defined in one CDK stack, `CityDesk`, in [`infra/`](../infra). This
page lists each AWS service, why it is there, what each Lambda function is allowed to do, what it
costs, and how to deploy and remove it.

> **Verification status.** The stack synthesizes and its template is covered by unit tests
> (`pnpm --filter @citydesk/infra test`). It was written on a machine with no AWS credentials, so
> nothing on this page has been checked against a live deployment yet. IAM action names, ARN formats
> and prices were read from AWS documentation and the AWS Price List on 2026-10-13; the sources are
> linked next to each claim. Points that only a real deploy can confirm are listed under
> [Not yet verified](#not-yet-verified).

## Architecture in one picture

```
browser ──HTTPS──> CloudFront distribution (PriceClass_100)
                     ├─ default  ──> S3 bucket (private, origin access control)  static client
                     ├─ /api/*   ──> Lambda Function URL ──> client API function ──> Bedrock, Polly
                     └─ /mcp     ──> Lambda Function URL ──> MCP server function ──> DynamoDB,
                                                                                    Amazon Location,
MCP clients (Alexa+, inspectors) ──HTTPS──> the same MCP Function URL, directly     Open311 (internet)

both functions ──> SSM Parameter Store /citydesk/*  (bearer token, API keys, allowed origins)
```

There is no VPC, NAT gateway, API Gateway, Secrets Manager secret, WAF, load balancer, custom domain,
certificate or customer managed KMS key, and no reserved concurrency. Nothing in the stack bills by
the hour except the DynamoDB table's provisioned capacity, which sits inside DynamoDB's monthly free
tier (25 RCU / 25 WCU).

## Services

"Region" is the Region the stack is deployed to: `AWS_REGION`, default `us-east-1`. The "Called
from" column is for the application file that makes the call. It is filled in once the app code
lands.

| Service | Region | Why it is used | IAM actions granted, and to which function | Defined in | Called from |
| --- | --- | --- | --- | --- | --- |
| **AWS Lambda**: MCP server function | deploy Region | Runs the MCP server (Streamable HTTP) behind a public Function URL. Node.js 24, arm64, 512 MB, 20 s. | Resource policy on the function: `lambda:InvokeFunctionUrl` (auth type `NONE`) and `lambda:InvokeFunction` (only via the Function URL) for principal `*`. | `infra/lib/citydesk-stack.ts` (`nodeFunction('Mcp', …)`, `addFunctionUrl`) | TODO(app): handler `apps/citydesk/src/lambda.ts` |
| **AWS Lambda**: client API function | deploy Region | Backend of the web client: one assistant turn through Bedrock, speech through Polly. Node.js 24, arm64, 512 MB, 30 s. Public Function URL. | Same two resource-policy statements as above, on this function. | `infra/lib/citydesk-stack.ts` (`nodeFunction('ClientApi', …)`, `addFunctionUrl`) | TODO(app): handler `apps/sim-client/server/lambda.ts` |
| **Amazon DynamoDB** | deploy Region | Table `citydesk-user-requests` (`pk`, `sk`, TTL on `ttl`): each user's filed and followed requests. Provisioned 5 RCU / 5 WCU. | **MCP function:** `dynamodb:BatchGetItem`, `BatchWriteItem`, `ConditionCheckItem`, `DeleteItem`, `GetItem`, `PutItem`, `Query`, `Scan`, `UpdateItem` on the table ARN. | `infra/lib/citydesk-stack.ts` (`UserRequests`) | TODO(app) |
| **Amazon Location Service**: Places (place index) | deploy Region | Place index `citydesk-places` (Esri, intended use `Storage`): geocodes spoken addresses and landmarks with `SearchPlaceIndexForText`. | **MCP function:** `geo:SearchPlaceIndexForText` on `arn:aws:geo:<region>:<account>:place-index/citydesk-places`. | `infra/lib/citydesk-stack.ts` (`Places`) | TODO(app) |
| **Amazon Location Service**: Maps | deploy Region | Static map image for the issue card, through the newer Maps API (`GetStaticMap`). It needs no resource in the stack. | **MCP function:** `geo-maps:GetStaticMap` on `arn:aws:geo-maps:<region>::provider/default`. | `infra/lib/citydesk-stack.ts` (statement `StaticMaps`) | TODO(app) |
| **Amazon Bedrock** | deploy Region for the call. An inference profile may run the request in other Regions. | The assistant model, through the Converse API with tool use. Model chosen by `BEDROCK_MODEL_ID` at synth time. | **Client API function:** `bedrock:InvokeModel`, scoped to the configured model. See [Bedrock permissions](#bedrock-permissions). | `infra/lib/bedrock.ts`, applied in `infra/lib/citydesk-stack.ts` | TODO(app) |
| **Amazon Polly** | deploy Region | Speaks the assistant's replies (`POLLY_VOICE_ID`, default `Joanna`; `POLLY_ENGINE`, default `neural`). | **Client API function:** `polly:SynthesizeSpeech` on `*` (the action only supports resource-level scoping for custom lexicons, which are not used). | `infra/lib/citydesk-stack.ts` (statement `SynthesizeSpeech`) | TODO(app) |
| **Amazon S3** | deploy Region | Private bucket holding the built web client (`apps/sim-client/dist`). Block Public Access on, TLS enforced, emptied and deleted with the stack. | Neither application function. The bucket policy lets `cloudfront.amazonaws.com` call `s3:GetObject` for this distribution only. CDK's deploy-time helper functions get the access they need (see [CDK helpers](#cdk-helper-resources)). | `infra/lib/citydesk-stack.ts` (`ClientBucket`, `DeployClient`) | Not called by the app. `TODO(app)`: confirm |
| **Amazon CloudFront** | Global | One distribution, cheapest price class. Serves the client and forwards `/api/*` and `/mcp` to the Function URLs so the browser stays same-origin. | None. | `infra/lib/citydesk-stack.ts` (`Distribution`) | Not called by the app. `TODO(app)`: the client's fetch paths |
| **AWS Systems Manager Parameter Store** | deploy Region | `/citydesk/mcp-bearer-token`, `/citydesk/boston-open311-api-key`, `/citydesk/seeclickfix-api-key` (SecureString) and `/citydesk/allowed-origins` (String). | **Both functions:** `ssm:GetParameter`, `ssm:GetParameters` on `arn:aws:ssm:<region>:<account>:parameter/citydesk/*`. | String parameter: `infra/lib/citydesk-stack.ts` (`AllowedOrigins`). SecureStrings: `infra/scripts/ensure-params.ts`, `infra/lib/ensure-params.ts`. Names: `infra/lib/params.ts` | TODO(app) |
| **AWS KMS** (AWS managed key `alias/aws/ssm`) | deploy Region | Encrypts the SecureString parameters. No key is created. | **Both functions:** `kms:Decrypt` on `arn:aws:kms:<region>:<account>:key/*`, only when `kms:ViaService` is `ssm.<region>.amazonaws.com` and the encryption context `PARAMETER_ARN` is under `/citydesk/`. | `infra/lib/citydesk-stack.ts` (`parameterReadStatements`) | Indirect, through `GetParameter` with decryption. TODO(app) |
| **Amazon CloudWatch Logs** | deploy Region | One log group per function, kept two weeks, deleted with the stack. | **Each function, on its own log group only:** `logs:CreateLogStream`, `logs:PutLogEvents`. The roles do not use the `AWSLambdaBasicExecutionRole` managed policy. | `infra/lib/citydesk-stack.ts` (`nodeFunction`) | Implicit (stdout of each function) |
| **AWS IAM** | Global | One execution role per function, holding only the statements in this table. | n/a | `infra/lib/citydesk-stack.ts` (`nodeFunction`) | n/a |
| **AWS CloudFormation** and the CDK bootstrap stack | deploy Region | Deploys the stack. `cdk bootstrap` creates the `CDKToolkit` stack: an S3 bucket for assets, an empty ECR repository, deploy roles and one SSM parameter. | None for the application functions. | `infra/bin/citydesk.ts`, `infra/cdk.json`, `infra/scripts/bootstrap.ts` | n/a |
| **AWS STS** | deploy Region | `GetCallerIdentity` in the deploy scripts, to check credentials and find the account ID. Deployer only. | None. | `infra/scripts/preflight.ts`, `infra/scripts/bootstrap.ts` | n/a |

### Full policy of each function

MCP server function (`McpRole`):

| Sid | Actions | Resource | Condition |
| --- | --- | --- | --- |
| `WriteOwnLogs` | `logs:CreateLogStream`, `logs:PutLogEvents` | its own log group | |
| `UserRequestsTableReadWrite` | `dynamodb:BatchGetItem`, `BatchWriteItem`, `ConditionCheckItem`, `DeleteItem`, `GetItem`, `PutItem`, `Query`, `Scan`, `UpdateItem` | the table | |
| `GeocodeWithPlaceIndex` | `geo:SearchPlaceIndexForText` | the place index | |
| `StaticMaps` | `geo-maps:GetStaticMap` | `arn:aws:geo-maps:<region>::provider/default` | |
| `ReadCityDeskParameters` | `ssm:GetParameter`, `ssm:GetParameters` | `parameter/citydesk/*` | |
| `DecryptCityDeskParameters` | `kms:Decrypt` | `key/*` in this account and Region | via SSM only, and only for `/citydesk/` parameters |

Client API function (`ClientApiRole`):

| Sid | Actions | Resource | Condition |
| --- | --- | --- | --- |
| `WriteOwnLogs` | `logs:CreateLogStream`, `logs:PutLogEvents` | its own log group | |
| `InvokeAssistant…` (one or two statements) | `bedrock:InvokeModel` | see below | see below |
| `SynthesizeSpeech` | `polly:SynthesizeSpeech` | `*` | |
| `ReadCityDeskParameters` | `ssm:GetParameter`, `ssm:GetParameters` | `parameter/citydesk/*` | |
| `DecryptCityDeskParameters` | `kms:Decrypt` | `key/*` in this account and Region | via SSM only, and only for `/citydesk/` parameters |

The table read/write list has no stream, index or table-management actions. `Scan` is included
because "read/write on the table" was the brief; drop it in `citydesk-stack.ts` if the app only ever
queries by `pk`.

### Bedrock permissions

`infra/lib/bedrock.ts` turns `BEDROCK_MODEL_ID` into the narrowest set of resources that still
works. The Converse API is authorized by `bedrock:InvokeModel`
([service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_bedrock.html)).
If the app ever switches to `ConverseStream`, it also needs `bedrock:InvokeModelWithResponseStream`,
which is not granted.

| `BEDROCK_MODEL_ID` looks like | Resources allowed |
| --- | --- |
| a foundation model ID, `provider.model` | `arn:aws:bedrock:<region>::foundation-model/<id>` |
| a cross-Region inference profile ID, `us.` / `eu.` / `apac.` / … prefix | the profile `arn:aws:bedrock:<region>:<account>:inference-profile/<id>`, plus the underlying model `arn:aws:bedrock:*::foundation-model/<id without the prefix>` only when the call arrives through that profile (`bedrock:InferenceProfileArn`) |
| a global inference profile ID, `global.` prefix | the same, plus the Region-less `arn:aws:bedrock:::foundation-model/<id without the prefix>` that global routing is authorized against |
| an ID that cannot be classified (an unknown prefix, or a model name with a dot in it) | both readings above, still limited to that one ID |
| a full ARN | that ARN. For an inference profile ARN, the underlying models as above |

An inference profile needs the profile ARN in the calling account plus the foundation model in every
Region the profile routes to
([Prerequisites for inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html),
[Global cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/global-cross-region-inference.html)).
The destination Regions cannot be known at synth time without an API call, which is why the model
Region is a wildcard and the profile condition does the narrowing.

### CDK helper resources

Two CDK constructs add their own deploy-time Lambda functions. They run only during `cdk deploy`
and `cdk destroy`, never on a request:

- `BucketDeployment` (`Custom::CDKBucketDeployment`, Python, with an AWS CLI layer): copies the built
  client from the CDK asset bucket into the site bucket and invalidates `/*` on the distribution.
  Its role can read the asset bucket, read/write/delete objects in the site bucket, and call
  `cloudfront:CreateInvalidation` and `cloudfront:GetInvalidation`.
- `autoDeleteObjects` (`Custom::S3AutoDeleteObjects`, Node.js): empties the site bucket on
  `cdk destroy` so the bucket can be deleted.

Both use CDK's default role with the `AWSLambdaBasicExecutionRole` managed policy. That is CDK's
choice, not something this stack configures.

## Design notes

**Why the Function URLs are public (auth type `NONE`).** The MCP handler checks a bearer token and
validates the `Origin` header itself. Putting CloudFront origin access control with IAM auth in front
is not an option: with OAC, "if you use `PUT` or `POST` methods with your Lambda function URL, your
users must compute the SHA256 of the body and include the payload hash value of the request body in
the `x-amz-content-sha256` header"
([CloudFront: restrict access to a Lambda function URL origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html)).
MCP is JSON-RPC over POST, and standard MCP clients do not send that header. The consequence: both
Function URLs can be called directly by anyone who has the URL, and the application is the only
thing that says no. The stack hands `DEMO_DAILY_REQUEST_CAP` to the client API function; enforcing
it is the app's job (TODO(app): where).

**Function URL permissions.** Since October 2025 a Function URL needs both `lambda:InvokeFunctionUrl`
and `lambda:InvokeFunction` in the function's resource policy, even with auth type `NONE`, and
CloudFormation does not add them for you
([Control access to Lambda function URLs](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html)).
`addFunctionUrl` in aws-cdk-lib 2.273.0 emits both, and the tests assert both.

**Headers through CloudFront.** `/api/*` and `/mcp` use the managed cache policy `CachingDisabled`
and the managed origin request policy `AllViewerExceptHostHeader`, which forwards every viewer
header, cookie and query string except `Host`
([managed origin request policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html)).
That covers `Authorization`, `Origin`, `MCP-Protocol-Version`, `Mcp-Session-Id`, `Accept` and
`X-CityDesk-Device`. `Host` is left out because a Function URL only answers to its own host name.
Both behaviours are HTTPS only: plain HTTP is refused instead of redirected, so a bearer token is
never sent in clear text first.

**No custom error responses.** They apply to the whole distribution and would replace the MCP
server's own `403` and `404` answers with `index.html`.

**Allowed origins live in SSM, not in an environment variable.** The distribution needs the
Function URL to exist, so the function cannot also depend on the distribution's domain name. The
stack writes `https://<distribution domain>` to `/citydesk/allowed-origins`, and the MCP function
reads it at cold start.

**Secrets.** CloudFormation cannot create SecureString parameters, so
`infra/scripts/ensure-params.ts` creates them before the deploy with the AWS SDK:

- `/citydesk/mcp-bearer-token`: 32 random bytes, base64url. Created once and never replaced, so MCP
  clients that already hold it keep working across deploys. To rotate it, delete the parameter and
  run `make deploy` again.
- `/citydesk/boston-open311-api-key`, `/citydesk/seeclickfix-api-key`: written only when
  `BOSTON_OPEN311_API_KEY` / `SEECLICKFIX_API_KEY` are set, and rewritten only when the value changes.

The script never prints a value. To read the token for an MCP client:

```bash
aws ssm get-parameter --name /citydesk/mcp-bearer-token --with-decryption \
  --query Parameter.Value --output text
```

**Place index: results are stored.** Geocoded coordinates end up in filed requests, so the index is
created with `IntendedUse: Storage` ("the result can be cached or stored in a database"; the default,
`SingleUse`, "specifies that the results won't be stored":
[CloudFormation reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-location-placeindex-datasourceconfiguration.html)).
The price consequence is in the cost table: a stored Esri geocode costs eight times a single-use one.

**Runtime.** `nodejs24.x` is the newest Node.js runtime in aws-cdk-lib 2.273.0 and the newest that is
generally available on Lambda. `nodejs26.x` is listed as a public preview, "not covered by the Lambda
SLA", with general availability targeted for November 2026
([Lambda runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html)).

**Bundling.** Each function is one ES module (`index.mjs`) built by esbuild, with the AWS SDK bundled
from the lockfile. A one-line banner defines `require` for CommonJS dependencies inside the bundle.

## Deploy and destroy

Settings come from the environment or from `.env` at the repo root (variables that are already
exported win).

| Variable | Needed for | Default |
| --- | --- | --- |
| `BEDROCK_MODEL_ID` | synth, deploy | none: synth fails with a readable message |
| AWS credentials (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, or `AWS_PROFILE`, or SSO) | deploy, destroy | none |
| `AWS_REGION` | all | `us-east-1` |
| `POLLY_VOICE_ID`, `POLLY_ENGINE`, `DEMO_DAILY_REQUEST_CAP` | deploy | `Joanna`, `neural`, `2000` |
| `CITYDESK_TABLE`, `LOCATION_PLACE_INDEX` | deploy | `citydesk-user-requests`, `citydesk-places` |
| `BOSTON_OPEN311_API_KEY`, `SEECLICKFIX_API_KEY` | deploy, optional | not stored when unset |

```bash
make deploy     # install, check settings and credentials, build, create SSM secrets,
                # bootstrap CDK if this account/Region is not bootstrapped, cdk deploy
make destroy    # cdk destroy --force, then delete the three SecureString parameters
```

`make deploy` writes the stack outputs to `results/deploy-outputs.json`:

| Output | Meaning |
| --- | --- |
| `ClientUrl` | the web client, `https://<id>.cloudfront.net` |
| `McpUrl` | the MCP endpoint through CloudFront, `https://<id>.cloudfront.net/mcp` |
| `McpFunctionUrl` | the MCP endpoint directly on the Function URL, ending in `/mcp` |
| `TableName` | the DynamoDB table |
| `PlaceIndexName` | the Amazon Location place index |

Other targets: `make install`, `make build`, `make test`, `make synth` (no AWS calls). Without
make, the same steps are `pnpm install`, `pnpm -r --if-present build`, then inside `infra/`:
`node --import tsx scripts/ensure-params.ts`, `node --import tsx scripts/bootstrap.ts`,
`pnpm exec cdk deploy --require-approval never --outputs-file ../results/deploy-outputs.json`.

Paths can be overridden for experiments with CDK context, resolved against `infra/`:
`cdk synth -c mcpEntry=<file> -c clientApiEntry=<file> -c clientDist=<dir>`, or through make:
`make synth CDK_ARGS="-c clientDist=<dir>"`.

**What `make destroy` leaves behind.** The CDK bootstrap stack `CDKToolkit` (its asset bucket
`cdk-hnb659fds-assets-<account>-<region>` holds a few tens of MB of deployment assets), and the log
group Lambda creates for the `autoDeleteObjects` helper. To remove the bootstrap stack as well, empty
that bucket (it is versioned) and delete the `CDKToolkit` stack in CloudFormation.

## Bedrock model access for a new account

Bedrock no longer has a per-model "request access" switch in commercial Regions: "Access to many
Amazon Bedrock foundation models is enabled by default with the correct AWS Marketplace permissions"
([Request access to models](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)).
What a new account still has to do:

1. **Pick the model and its ID.** Open the model catalog in the Bedrock console in the deploy Region,
   choose a model that supports the Converse API with tool use, and note either its model ID or its
   inference profile ID. Some models are served only through an inference profile (`us.…`,
   `global.…`); the model's page in the catalog says which. Put the ID in `BEDROCK_MODEL_ID`.
2. **Have a valid payment method** on the account. Marketplace-sold models need one.
3. **Anthropic models only: submit the use case form once.** Select any Anthropic model in the model
   catalog (or call `PutUseCaseForModelAccess`). It asks for a description of the use and a website
   URL; a GitHub profile or project URL is accepted. Access is usually granted at once, but the
   agreement can sit in a pending state, during which calls return `AccessDeniedException`.
4. **Make the first call with an identity that has AWS Marketplace permissions.** The first
   invocation of a Marketplace-sold model starts a subscription in the background, and that needs
   `aws-marketplace:Subscribe`, `aws-marketplace:Unsubscribe` and `aws-marketplace:ViewSubscriptions`
   on the caller. The client API Lambda role has none of these on purpose. So before the demo, invoke
   the model once as the deployer: the console playground, or `pnpm smoke` with admin credentials.
   The docs allow up to 15 minutes for the subscription to settle. After that, no caller needs
   Marketplace permissions. Amazon's own models (Nova, Titan) are not sold through Marketplace and
   skip this step.
5. **Check it.** `aws bedrock get-foundation-model-availability --model-id <foundation model ID>`
   (AWS CLI 2.27.42 or newer) should show `agreementAvailability.status` as `AVAILABLE`.
6. **Deploy.** `make deploy` scopes the Lambda role to exactly this model. Changing the model later
   means changing `BEDROCK_MODEL_ID` and deploying again; editing the function's environment variable
   in the console would leave the IAM policy pointing at the old model.

Not checked for this project: the default request and token quotas of a new account for the chosen
model (Service Quotas console, "Amazon Bedrock"), and whether an account on the Free account plan can
use Bedrock at all (see the next section).

## Cost

### How the free tier works now

The pricing pages say "Starting July 15, 2025, new AWS customers will receive up to $200 in AWS Free
Tier credits". From the
[Free Tier documentation](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier.html),
the [FAQ](https://aws.amazon.com/free/free-tier-faqs/) and the [Free Tier page](https://aws.amazon.com/free/):

- A new account gets USD 100 in credits and can earn up to USD 100 more. On the **Free account plan**
  nothing is charged for up to six months or until the credits run out, whichever comes first, and
  only select services are available. On the **Paid account plan** usage beyond the credits is
  billed.
- "All customers, new and existing, can access over 30 services with always free offers", with
  monthly usage limits. The Free Tier page does not name the 30 in its readable text, so the
  table below says "always free" only where a pricing page or the price list says so itself.
- The older "first 12 months" offers still appear on some pricing pages (Polly's, for example).
  Whether an account created before July 15, 2025 keeps them could not be confirmed, so the table
  marks them "check your account".

Could not confirm: whether Amazon Bedrock, Amazon Location Service and Amazon Polly are usable on
the Free account plan. The FAQ only says the plan excludes services that "would immediately consume
the entire Free Tier credit amount"; the Free Tier page labels S3 and DynamoDB "Available on both
plans" and says nothing about the other three. If the deploy account is on that plan, check before
relying on it.

### Per service

Prices are for `us-east-1`, read on 2026-10-13 from the public
[AWS Price List bulk files](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api.html)
(`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<ServiceCode>/current/us-east-1/index.json`).
Free tier terms come from the linked pricing pages. Two caveats: the Amazon Location pricing page
would not render its price table in a headless browser, and the Bedrock pricing page was not opened,
so the numbers for those two rows come from the price list files alone.

Demo volume assumed for the estimate, per month:

- 20 conversations a day with 5 assistant turns each: 3,000 turns.
- Per turn: 2 Bedrock calls (one that asks for a tool, one that answers) of about 3,000 input and 150
  output tokens each, and one spoken reply of about 250 characters.
- About 15,000 Lambda invocations in total (turns, speech, MCP calls), averaging under 3 seconds at
  512 MB: about 8,000 GB-seconds.
- One geocode and one static map per conversation: 600 of each.
- About 30,000 CloudFront requests and well under 1 GB transferred.

| Service | Free tier class | Price beyond the free tier | Estimate at demo volume | Source |
| --- | --- | --- | --- | --- |
| Lambda | **Always free** (the price list carries it as a global free tier; the Free Tier docs use Lambda as their always-free example): 1,000,000 requests and 400,000 GB-seconds a month | USD 0.20 per million requests; USD 0.0000133334 per GB-second on arm64 | USD 0. Unfree it would be about USD 0.11 | [Lambda pricing](https://aws.amazon.com/lambda/pricing/) |
| DynamoDB | **Monthly free tier, no end date stated**: 25 RCU, 25 WCU and 25 GB a month, per Region and payer account, provisioned capacity, Standard table class. "Available on both plans" | USD 0.00013 per RCU-hour, USD 0.00065 per WCU-hour, USD 0.25 per GB-month | USD 0. If other tables in the account already use the 25/25 allowance: about USD 2.85 for 5 RCU + 5 WCU | [DynamoDB provisioned pricing](https://aws.amazon.com/dynamodb/pricing/provisioned/) |
| Amazon Location: geocoding with stored results | **Pay per use.** The Location free tier (first 3 months) lists 20,000 "Core" requests a month; nothing found says it includes stored results | USD 4.00 per 1,000 geocodes with results stored. A single-use geocode is USD 0.50 per 1,000 | 600 × USD 0.004 = **USD 2.40** | [Location pricing](https://aws.amazon.com/location/pricing/), [Places pricing](https://docs.aws.amazon.com/location/latest/developerguide/places-pricing.html) |
| Amazon Location: static maps | Free for the first 3 months of use: 5,000 static map requests a month. Then pay per use | USD 0.50 per 1,000 requests | USD 0 in the first 3 months, then 600 × USD 0.0005 = USD 0.30 | [Location pricing](https://aws.amazon.com/location/pricing/), [Maps pricing](https://docs.aws.amazon.com/location/latest/developerguide/maps-pricing.html) |
| Bedrock | **Pay per use**, no free tier | Per token, set by the model. Example: Amazon Nova Lite is USD 0.00006 per 1,000 input tokens and USD 0.00024 per 1,000 output tokens | With Nova Lite: 18M input + 0.9M output tokens = **about USD 1.30**. A larger model costs proportionally more: multiply by its per-token price | [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/) |
| Polly | Standard voices: 5 million characters a month, no time limit stated. Neural: 1 million a month "for the first 12 months" (check your account) | Neural USD 16 per million characters; standard USD 4; generative USD 30; long-form USD 100 | 750,000 neural characters: **USD 12.00**, or USD 0 inside the neural free tier. `POLLY_ENGINE=standard` would be USD 0 to 3.00 | [Polly pricing](https://aws.amazon.com/polly/pricing/) |
| CloudFront (pay as you go) | **Always free** (the page's own words): 1 TB out, 10,000,000 HTTP/HTTPS requests a month. Origin fetches from AWS origins are free. The first 1,000 invalidation paths a month are free | USD 0.085 per GB (US, first 10 TB); USD 0.0100 per 10,000 HTTPS requests | USD 0 | [CloudFront pay-as-you-go pricing](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/) |
| S3 | **Pay per use**: the S3 pricing page shows no storage allowance in its readable text, only the new-account credits | USD 0.023 per GB-month; USD 0.005 per 1,000 PUT; USD 0.0004 per 1,000 GET | Under USD 0.01: a few MB of client files plus about 25 MB of CDK assets | [S3 pricing](https://aws.amazon.com/s3/pricing/) |
| Parameter Store | **No charge**: "No additional charge" for standard parameters and standard-throughput API calls | Advanced parameters USD 0.05 each per month (not used) | USD 0 | [Systems Manager pricing](https://aws.amazon.com/systems-manager/pricing/) |
| KMS | AWS managed key: no monthly fee, but its requests are billed. **Free tier**: 20,000 requests a month across all Regions | USD 0.03 per 10,000 requests. A customer managed key would be USD 1 a month (not used) | USD 0: a few decrypts per cold start | [KMS pricing](https://aws.amazon.com/kms/pricing/) |
| CloudWatch Logs | **Monthly free tier**: 5 GB of log ingestion, storage and Logs Insights scans | USD 0.50 per GB ingested; USD 0.03 per GB-month stored | USD 0 | [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/) |
| IAM, CloudFormation, STS | Not priced in this estimate: their pricing was not looked up | | | |

**Total at demo volume: roughly USD 4 to 16 a month**: about USD 2.70 for Amazon Location, about
USD 1.30 for Bedrock with a small model, and USD 0 to 12 for Polly depending on the engine and free
tier. A larger Bedrock model is the one number that can move this a lot.

**Idle cost: USD 0**, as long as the table's 5/5 capacity fits in the account's DynamoDB free tier
(otherwise about USD 2.85 a month). Nothing else in the stack charges while unused, apart from cents of S3 storage.

**Worst case.** `DEMO_DAILY_REQUEST_CAP` defaults to 2,000 requests a day. How the app counts a
request against it is not known here (TODO(app)). If every one were a full spoken assistant turn, a month at the cap would
be 20 times the volume above: on the order of USD 240 for neural Polly, USD 26 for Nova Lite, and
Location in proportion to the number of conversations. Lambda would still be inside the free tier.
If that is too much exposure for a public demo URL, lower the cap, use `POLLY_ENGINE=standard`, and
set an AWS Budgets alert on the account.

**CloudFront flat-rate plans.** The CloudFront pricing page now leads with flat-rate plans, including
a USD 0 "Free" plan (1M requests, 100 GB). The distribution in this stack is plain pay as you go; no
plan is selected in the template.

## Not yet verified

These need one real deploy to confirm. Each is backed by the linked AWS documentation but has not
been exercised:

- The `geo-maps:GetStaticMap` action and its `provider/default` ARN
  ([service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_geo-maps.html)).
- `kms:Decrypt` with the `kms:ViaService` and `kms:EncryptionContext:PARAMETER_ARN` conditions for the
  AWS managed key `alias/aws/ssm`
  ([Parameter Store and KMS](https://docs.aws.amazon.com/kms/latest/developerguide/services-parameter-store.html)).
  If `GetParameter` with decryption fails with a KMS access error, this statement is the place to
  look.
- The Bedrock statements for the model actually chosen, in particular the `bedrock:InferenceProfileArn`
  condition for inference profiles.
- That `AllViewerExceptHostHeader` delivers the `Authorization` header to the function. The CloudFront
  guide names the all-viewer-headers policy as one way to forward it
  ([forward the Authorization header](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/add-origin-custom-headers.html#add-origin-custom-headers-forward-authorization)).
- That the two `AWS::Lambda::Permission` resources CDK emits are enough for a new account's public
  Function URL.
- `nodejs24.x` on arm64 in the deploy Region, and that the app's real handlers bundle cleanly as ES
  modules (the tests bundle small stand-ins).
- `make deploy`, `make destroy`, `scripts/ensure-params.ts`, `scripts/bootstrap.ts` and
  `scripts/delete-params.ts` against real AWS. The parameter logic is unit-tested with a fake store;
  the bootstrap check and the two `make` targets have only been run as far as the credential check.
