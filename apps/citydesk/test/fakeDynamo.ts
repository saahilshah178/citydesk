/**
 * A small in-memory stand-in for DynamoDBDocumentClient covering exactly the commands DynamoStore
 * sends (Get, Put, Query on pk with an optional begins_with on sk, and a conditional Update).
 * It records every command so tests can assert on keys and expressions.
 */
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

type Item = Record<string, unknown>;

export class FakeDynamo {
  readonly items = new Map<string, Item>();
  readonly commands: Array<{ name: string; input: Record<string, unknown> }> = [];
  /** Page size for Query, to exercise pagination. */
  pageSize = 1000;
  /** Items returned by Query so far: a stand-in for read capacity consumed. */
  itemsRead = 0;

  private key(pk: unknown, sk: unknown): string {
    return `${String(pk)}\u0000${String(sk)}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send = async (command: any): Promise<any> => {
    this.commands.push({ name: command.constructor.name, input: command.input });
    if (command instanceof PutCommand) {
      const item = command.input.Item as Item;
      for (const [k, v] of Object.entries(item)) if (v === undefined) delete item[k];
      this.items.set(this.key(item.pk, item.sk), structuredClone(item));
      return {};
    }
    if (command instanceof GetCommand) {
      const k = command.input.Key as Item;
      const item = this.items.get(this.key(k.pk, k.sk));
      return { Item: item ? structuredClone(item) : undefined };
    }
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues as Record<string, string>;
      const prefix = values[':prefix'];
      const from = values[':from'];
      const all = [...this.items.values()]
        .filter((i) => i.pk === values[':pk'])
        .filter((i) => prefix === undefined || String(i.sk).startsWith(prefix))
        .filter((i) => from === undefined || String(i.sk) >= from)
        .sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
      if (command.input.ScanIndexForward === false) all.reverse();
      const start = command.input.ExclusiveStartKey as Item | undefined;
      const begin = start ? all.findIndex((i) => i.sk === start.sk) + 1 : 0;
      const size = Math.min(this.pageSize, (command.input.Limit as number | undefined) ?? Infinity);
      const page = all.slice(begin, begin + size);
      const more = begin + size < all.length;
      const last = page.at(-1);
      this.itemsRead += page.length;
      return { Items: structuredClone(page), LastEvaluatedKey: more && last ? { pk: last.pk, sk: last.sk } : undefined };
    }
    if (command instanceof UpdateCommand) {
      const k = command.input.Key as Item;
      const item = this.items.get(this.key(k.pk, k.sk));
      if (!item && command.input.ConditionExpression === 'attribute_exists(pk)') {
        throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
      }
      const target = item ?? { ...k };
      const values = (command.input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
      if (String(command.input.UpdateExpression).startsWith('ADD ')) {
        // The one counter expression DynamoStore.increment sends.
        target.n = Number(target.n ?? 0) + Number(values[':one']);
        target.ttl ??= values[':ttl'];
        this.items.set(this.key(k.pk, k.sk), target);
        return { Attributes: { n: target.n } };
      }
      const [setPart, removePart] = String(command.input.UpdateExpression).split(/\s+REMOVE\s+/);
      for (const assign of setPart!.replace(/^SET\s+/, '').split(',')) {
        const [name, ref] = assign.split('=').map((s) => s.trim());
        target[name!] = values[ref!];
      }
      for (const name of (removePart ?? '').split(',').map((s) => s.trim()).filter(Boolean)) delete target[name];
      this.items.set(this.key(k.pk, k.sk), target);
      return {};
    }
    throw new Error(`FakeDynamo: unsupported command ${command.constructor.name}`);
  };
}
