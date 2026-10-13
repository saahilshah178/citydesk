/**
 * Per-user memory in Amazon DynamoDB. One table, two string keys (`pk`, `sk`):
 *
 *   pk = USER#<userId>   sk = REQ#<request_id>     a request the user filed or follows
 *   pk = USER#<userId>   sk = PROFILE#home         the home address they last asked about
 *   pk = SANDBOX         sk = REQ#<id>             a request held by the built-in Open311 sandbox
 *   pk = COUNTER         sk = <name>               an hourly filing counter (see UserStore.increment)
 *
 * Items carry a `ttl` (epoch seconds) so demo data expires on its own.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { SandboxRequestRecord, SandboxStore } from 'open311-mcp';
import type { HomeAddress, TrackedRequest, UserStore } from './types.ts';

const USER_TTL_DAYS = 180;
const SANDBOX_TTL_DAYS = 90;
const SANDBOX_PK = 'SANDBOX';

export interface DynamoStoreOptions {
  tableName: string;
  /** Anything with DynamoDBDocumentClient's `send`. Defaults to a client for `region`. */
  client?: Pick<DynamoDBDocumentClient, 'send'>;
  region?: string;
  now?: () => number;
}

export class DynamoStore implements UserStore {
  private readonly table: string;
  private readonly doc: Pick<DynamoDBDocumentClient, 'send'>;
  private readonly now: () => number;

  constructor(opts: DynamoStoreOptions) {
    this.table = opts.tableName;
    this.now = opts.now ?? Date.now;
    this.doc =
      opts.client ??
      DynamoDBDocumentClient.from(new DynamoDBClient(opts.region ? { region: opts.region } : {}), {
        marshallOptions: { removeUndefinedValues: true },
      });
  }

  private ttl(days: number): number {
    return Math.floor(this.now() / 1000) + days * 86_400;
  }

  async track(userId: string, request: TrackedRequest): Promise<TrackedRequest> {
    const existing = await this.get(userId, request.request_id);
    const merged: TrackedRequest = existing
      ? {
          ...existing,
          ...request,
          // A request the user filed stays "filed" even if they later ask to follow it.
          relation: existing.relation === 'filed' ? 'filed' : request.relation,
          since: existing.since,
        }
      : request;
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk: `USER#${userId}`, sk: `REQ#${merged.request_id}`, ttl: this.ttl(USER_TTL_DAYS), ...merged },
      }),
    );
    return merged;
  }

  async list(userId: string): Promise<TrackedRequest[]> {
    const items: TrackedRequest[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':prefix': 'REQ#' },
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of page.Items ?? []) items.push(stripKeys<TrackedRequest>(item));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return items.sort((a, b) => b.since.localeCompare(a.since));
  }

  async get(userId: string, requestId: string): Promise<TrackedRequest | undefined> {
    const out = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: `USER#${userId}`, sk: `REQ#${requestId}` } }),
    );
    return out.Item ? stripKeys<TrackedRequest>(out.Item) : undefined;
  }

  async snapshot(
    userId: string,
    requestId: string,
    seen: { status: 'open' | 'closed'; status_notes?: string; checked: string },
  ): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: `USER#${userId}`, sk: `REQ#${requestId}` },
          // Only update a request the user actually tracks; never create one as a side effect.
          ConditionExpression: 'attribute_exists(pk)',
          UpdateExpression:
            seen.status_notes === undefined
              ? 'SET last_status = :s, last_checked = :c REMOVE last_status_notes'
              : 'SET last_status = :s, last_checked = :c, last_status_notes = :n',
          ExpressionAttributeValues: {
            ':s': seen.status,
            ':c': seen.checked,
            ...(seen.status_notes === undefined ? {} : { ':n': seen.status_notes }),
          },
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return;
      throw err;
    }
  }

  async getHomeAddress(userId: string): Promise<HomeAddress | undefined> {
    const out = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: `USER#${userId}`, sk: 'PROFILE#home' } }),
    );
    return out.Item ? stripKeys<HomeAddress>(out.Item) : undefined;
  }

  async setHomeAddress(userId: string, home: HomeAddress): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk: `USER#${userId}`, sk: 'PROFILE#home', ttl: this.ttl(USER_TTL_DAYS), ...home },
      }),
    );
  }

  async increment(counter: string, ttlSeconds: number): Promise<number> {
    const out = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: 'COUNTER', sk: counter },
        // Atomic across Lambda instances. The TTL is set once, so the counter lives for one window.
        UpdateExpression: 'ADD #n :one SET #ttl = if_not_exists(#ttl, :ttl)',
        ExpressionAttributeNames: { '#n': 'n', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':ttl': Math.floor(this.now() / 1000) + ttlSeconds },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    return Number(out.Attributes?.n ?? 1);
  }

  /** The Open311 sandbox keeps its requests in the same table, so they survive across Lambda instances. */
  sandboxStore(): SandboxStore {
    return {
      put: async (record) => {
        await this.doc.send(
          new PutCommand({
            TableName: this.table,
            Item: { pk: SANDBOX_PK, sk: `REQ#${record.service_request_id}`, ttl: this.ttl(SANDBOX_TTL_DAYS), ...record },
          }),
        );
      },
      get: async (id) => {
        const out = await this.doc.send(
          new GetCommand({ TableName: this.table, Key: { pk: SANDBOX_PK, sk: `REQ#${id}` } }),
        );
        return out.Item ? stripKeys<SandboxRequestRecord>(out.Item) : undefined;
      },
      list: async () => {
        const records: SandboxRequestRecord[] = [];
        let startKey: Record<string, unknown> | undefined;
        do {
          const page = await this.doc.send(
            new QueryCommand({
              TableName: this.table,
              KeyConditionExpression: 'pk = :pk',
              ExpressionAttributeValues: { ':pk': SANDBOX_PK },
              ExclusiveStartKey: startKey,
            }),
          );
          for (const item of page.Items ?? []) records.push(stripKeys<SandboxRequestRecord>(item));
          startKey = page.LastEvaluatedKey;
        } while (startKey);
        return records;
      },
    };
  }
}

function stripKeys<T>(item: Record<string, unknown>): T {
  const { pk: _pk, sk: _sk, ttl: _ttl, ...rest } = item;
  return rest as T;
}
