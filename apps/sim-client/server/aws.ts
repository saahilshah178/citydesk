/**
 * The two pieces of AWS wiring the backend needs only when it runs in Lambda:
 *
 *   - `ssmConfigSource`: secrets from Systems Manager Parameter Store, as a ConfigSource.
 *   - `SharedDayCounter`: the daily request cap as an atomic counter in DynamoDB, so the cap holds
 *     across every warm instance instead of once per instance.
 */
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { ConfigSource } from './config.ts';
import { MemoryCounterStore, type CounterStore } from './limits.ts';

/** Config names that live in Parameter Store, and the parameter each one is read from. */
const SSM_NAMES: Record<string, string> = {
  MCP_CLIENT_TOKEN: 'mcp-bearer-token',
};

export interface SsmSourceOptions {
  /** Parameter path prefix, e.g. "/citydesk". */
  prefix: string;
  client?: Pick<SSMClient, 'send'>;
  ttlMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * Reads the mapped names from Parameter Store (decrypting SecureStrings) and answers `undefined`
 * for everything else, so it can sit in front of the environment in `layeredSource`. A failed read
 * is logged and treated as "not set" rather than taking the whole backend down.
 */
export function ssmConfigSource(options: SsmSourceOptions): ConfigSource {
  const prefix = options.prefix.replace(/\/+$/, '');
  const client = options.client ?? new SSMClient({});
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message) => console.error(`[sim-client api] ${message}`));
  let cached: { at: number; values: Promise<Map<string, string>> } | undefined;

  const load = async (): Promise<Map<string, string>> => {
    const values = new Map<string, string>();
    try {
      const out = await client.send(
        new GetParametersCommand({
          Names: [...new Set(Object.values(SSM_NAMES))].map((name) => `${prefix}/${name}`),
          WithDecryption: true,
        }),
      );
      for (const parameter of out.Parameters ?? []) {
        if (parameter.Name && parameter.Value !== undefined) values.set(parameter.Name.slice(prefix.length + 1), parameter.Value);
      }
    } catch (error) {
      log(`could not read ${prefix}/* from Parameter Store: ${error instanceof Error ? error.name : String(error)}`);
    }
    return values;
  };

  return async (name) => {
    const parameter = SSM_NAMES[name];
    if (!parameter) return undefined;
    if (!cached || now() - cached.at >= ttlMs) cached = { at: now(), values: load() };
    // A token list may hold several tokens; the browser presents the first.
    return (await cached.values).get(parameter)?.split(',')[0]?.trim() || undefined;
  };
}

export interface SharedDayCounterOptions {
  tableName: string;
  client?: Pick<DynamoDBClient, 'send'>;
  now?: () => number;
}

/**
 * Counts the daily cap in DynamoDB (`pk = COUNTER`, `sk = client-api#<key>`) and everything else in
 * memory. Per-IP minute counters stay local on purpose: they are many, short-lived, and only need to
 * be roughly right, while the daily cap is the one number that bounds what the demo can spend.
 */
export class SharedDayCounter implements CounterStore {
  private readonly local = new MemoryCounterStore();
  private readonly client: Pick<DynamoDBClient, 'send'>;
  private readonly now: () => number;

  constructor(private readonly options: SharedDayCounterOptions) {
    this.client = options.client ?? new DynamoDBClient({});
    this.now = options.now ?? Date.now;
  }

  async increment(key: string, ttlSeconds: number, by: number = 1): Promise<number> {
    if (!key.startsWith('day:')) return this.local.increment(key, ttlSeconds, by);
    const out = await this.client.send(
      new UpdateItemCommand({
        TableName: this.options.tableName,
        Key: { pk: { S: 'COUNTER' }, sk: { S: `client-api#${key}` } },
        UpdateExpression: 'ADD #n :by SET #ttl = if_not_exists(#ttl, :ttl)',
        ExpressionAttributeNames: { '#n': 'n', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':by': { N: String(Math.max(1, Math.ceil(by))) },
          ':ttl': { N: String(Math.floor(this.now() / 1000) + ttlSeconds) },
        },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    const count = Number(out.Attributes?.n?.N);
    // No count back means the cap cannot be checked: throwing makes the limiter refuse the request.
    if (!Number.isFinite(count)) throw new Error('DynamoDB returned no counter value');
    return count;
  }
}
