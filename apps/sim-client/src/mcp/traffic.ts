/**
 * A record of the JSON-RPC messages that cross the MCP transport, for the developer drawer.
 *
 * Entries are built from what is actually sent and received (see `TappedTransport`), not from
 * what the UI intended to do, so the drawer shows the real protocol traffic: `initialize`,
 * `notifications/initialized`, `tools/list`, every `tools/call` with its arguments, result and
 * round-trip time, and the `resources/read` behind each card.
 */

import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
} from '@modelcontextprotocol/client';

/** Who caused an outgoing request: the client itself, the assistant, the drawer, or a card. */
export type TrafficOrigin = 'host' | 'assistant' | 'manual' | 'app';

export type TrafficStatus = 'pending' | 'ok' | 'error' | 'tool_error' | 'sent' | 'received';

export interface TrafficEntry {
  seq: number;
  direction: 'out' | 'in';
  kind: 'request' | 'notification';
  method: string;
  /** The tool name for `tools/call`, the URI for `resources/read`. */
  target?: string;
  origin: TrafficOrigin;
  rpcId?: string | number;
  /** Epoch milliseconds when the message was sent or received. */
  at: number;
  /** Round-trip time of a request, once its response has arrived. */
  durationMs?: number;
  status: TrafficStatus;
  /** Compacted copies: long strings (card HTML, base64 images) are cut for display. */
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message: string };
}

const MAX_ENTRIES = 300;
const MAX_STRING = 1_200;
const MAX_ARRAY = 40;
const MAX_DEPTH = 8;

/** A display copy of a JSON value with oversized strings and arrays shortened. */
export function compact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, 160)}… [${value.length} characters]` : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[nested]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => compact(item, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`[${value.length - MAX_ARRAY} more items]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = compact(item, depth + 1);
  return out;
}

function targetOf(method: string, params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const { name, uri } = params as { name?: unknown; uri?: unknown };
  if (method === 'tools/call' && typeof name === 'string') return name;
  if (method.startsWith('resources/') && typeof uri === 'string') return uri;
  return undefined;
}

export class TrafficLog {
  private entries: readonly TrafficEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string | number, number>();
  private readonly expected: Array<{ method: string; target: string | undefined; origin: TrafficOrigin }> = [];
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Stable between changes, so it can back `useSyncExternalStore`. */
  getSnapshot = (): readonly TrafficEntry[] => this.entries;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clear(): void {
    this.entries = [];
    this.pending.clear();
    this.emit();
  }

  /** Tags the next outgoing request for `method` (and `target`) with who asked for it. */
  expect(method: string, target: string | undefined, origin: TrafficOrigin): void {
    this.expected.push({ method, target, origin });
    if (this.expected.length > 50) this.expected.shift();
  }

  outgoing(message: JSONRPCMessage): void {
    if (isJSONRPCRequest(message)) {
      const target = targetOf(message.method, message.params);
      const entry = this.add({
        direction: 'out',
        kind: 'request',
        method: message.method,
        origin: this.takeOrigin(message.method, target),
        rpcId: message.id,
        status: 'pending',
        params: compact(message.params),
        ...(target === undefined ? {} : { target }),
      });
      this.pending.set(message.id, entry.seq);
    } else if (isJSONRPCNotification(message)) {
      this.add({
        direction: 'out',
        kind: 'notification',
        method: message.method,
        origin: 'host',
        status: 'sent',
        params: compact(message.params),
      });
    }
  }

  incoming(message: JSONRPCMessage): void {
    if (isJSONRPCResultResponse(message)) {
      const result = message.result as { isError?: unknown };
      this.settle(message.id, {
        status: result?.isError === true ? 'tool_error' : 'ok',
        result: compact(message.result),
      });
    } else if (isJSONRPCErrorResponse(message)) {
      if (message.id === undefined || message.id === null) return;
      this.settle(message.id, {
        status: 'error',
        error: { code: message.error.code, message: message.error.message },
      });
    } else if (isJSONRPCRequest(message) || isJSONRPCNotification(message)) {
      this.add({
        direction: 'in',
        kind: isJSONRPCRequest(message) ? 'request' : 'notification',
        method: message.method,
        origin: 'host',
        status: 'received',
        params: compact(message.params),
      });
    }
  }

  /** The transport could not deliver a request (network error, HTTP error, CORS). */
  failed(message: JSONRPCMessage, error: unknown): void {
    if (!isJSONRPCRequest(message)) return;
    this.settle(message.id, {
      status: 'error',
      error: { message: error instanceof Error ? error.message : String(error) },
    });
  }

  private takeOrigin(method: string, target: string | undefined): TrafficOrigin {
    const index = this.expected.findIndex((item) => item.method === method && item.target === target);
    if (index === -1) return 'host';
    return this.expected.splice(index, 1)[0]?.origin ?? 'host';
  }

  private add(fields: Omit<TrafficEntry, 'seq' | 'at'>): TrafficEntry {
    const entry: TrafficEntry = { seq: (this.seq += 1), at: this.now(), ...fields };
    this.entries = [...this.entries.slice(-(MAX_ENTRIES - 1)), entry];
    this.emit();
    return entry;
  }

  private settle(id: string | number, patch: Pick<TrafficEntry, 'status'> & Partial<TrafficEntry>): void {
    const seq = this.pending.get(id);
    if (seq === undefined) return;
    this.pending.delete(id);
    const time = this.now();
    this.entries = this.entries.map((entry) =>
      entry.seq === seq ? { ...entry, ...patch, durationMs: time - entry.at } : entry,
    );
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
