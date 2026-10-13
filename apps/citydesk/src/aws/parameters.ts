/**
 * Runtime configuration from AWS Systems Manager Parameter Store. Secrets live there (or in
 * environment variables), never in the repository. Values are cached for a few minutes so a warm
 * Lambda does not call SSM on every request.
 */
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';

export interface ParameterReaderOptions {
  /** Path prefix without a trailing slash, e.g. "/citydesk". */
  prefix: string;
  client?: Pick<SSMClient, 'send'>;
  region?: string;
  ttlMs?: number;
  now?: () => number;
}

export class ParameterReader {
  private readonly prefix: string;
  private readonly client: Pick<SSMClient, 'send'>;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cache: { at: number; values: Map<string, string> } | undefined;
  private inflight: Promise<Map<string, string>> | undefined;

  constructor(
    opts: ParameterReaderOptions,
    private readonly names: readonly string[],
  ) {
    this.prefix = opts.prefix.replace(/\/+$/, '');
    this.client = opts.client ?? new SSMClient(opts.region ? { region: opts.region } : {});
    this.ttlMs = opts.ttlMs ?? 300_000;
    this.now = opts.now ?? Date.now;
  }

  /** The value of one parameter, or undefined when it does not exist. */
  async get(name: string): Promise<string | undefined> {
    return (await this.all()).get(name);
  }

  /** A comma-separated parameter as a list. Missing parameter: empty list. */
  async list(name: string): Promise<string[]> {
    return ((await this.get(name)) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  private async all(): Promise<Map<string, string>> {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.values;
    this.inflight ??= this.load().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async load(): Promise<Map<string, string>> {
    const values = new Map<string, string>();
    // GetParameters takes at most 10 names per call.
    for (let i = 0; i < this.names.length; i += 10) {
      const out = await this.client.send(
        new GetParametersCommand({
          Names: this.names.slice(i, i + 10).map((n) => `${this.prefix}/${n}`),
          WithDecryption: true,
        }),
      );
      for (const p of out.Parameters ?? []) {
        if (p.Name && p.Value !== undefined) values.set(p.Name.slice(this.prefix.length + 1), p.Value);
      }
    }
    this.cache = { at: this.now(), values };
    return values;
  }
}
