import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SandboxRequestRecord, SandboxStore } from 'open311-mcp';
import type { HomeAddress, TrackedRequest, UserStore } from './types.ts';

interface Snapshot {
  users: Record<string, { requests: Record<string, TrackedRequest>; home?: HomeAddress }>;
  sandbox: Record<string, SandboxRequestRecord>;
}

/**
 * In-process store for local development and tests. Give it a file path and it survives restarts,
 * which is what lets "check on it the next day" work without AWS.
 */
export class MemoryStore implements UserStore {
  private data: Snapshot = { users: {}, sandbox: {} };

  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      try {
        const loaded = JSON.parse(readFileSync(file, 'utf8')) as Partial<Snapshot>;
        this.data = { users: loaded.users ?? {}, sandbox: loaded.sandbox ?? {} };
      } catch {
        // A corrupt file starts fresh rather than taking the server down.
      }
    }
  }

  private user(userId: string) {
    return (this.data.users[userId] ??= { requests: {} });
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  async track(userId: string, request: TrackedRequest): Promise<TrackedRequest> {
    const requests = this.user(userId).requests;
    const existing = requests[request.request_id];
    const merged: TrackedRequest = existing
      ? {
          ...existing,
          ...request,
          relation: existing.relation === 'filed' ? 'filed' : request.relation,
          since: existing.since,
        }
      : request;
    requests[request.request_id] = merged;
    this.persist();
    return merged;
  }

  async list(userId: string): Promise<TrackedRequest[]> {
    return Object.values(this.user(userId).requests).sort((a, b) => b.since.localeCompare(a.since));
  }

  async get(userId: string, requestId: string): Promise<TrackedRequest | undefined> {
    return this.user(userId).requests[requestId];
  }

  async snapshot(
    userId: string,
    requestId: string,
    seen: { status: 'open' | 'closed'; status_notes?: string; checked: string },
  ): Promise<void> {
    const tracked = this.user(userId).requests[requestId];
    if (!tracked) return;
    tracked.last_status = seen.status;
    tracked.last_status_notes = seen.status_notes;
    tracked.last_checked = seen.checked;
    this.persist();
  }

  async getHomeAddress(userId: string): Promise<HomeAddress | undefined> {
    return this.user(userId).home;
  }

  async setHomeAddress(userId: string, home: HomeAddress): Promise<void> {
    this.user(userId).home = home;
    this.persist();
  }

  /** The Open311 sandbox keeps its requests in the same store. */
  sandboxStore(): SandboxStore {
    return {
      put: async (record) => {
        this.data.sandbox[record.service_request_id] = record;
        this.persist();
      },
      get: async (id) => this.data.sandbox[id],
      list: async () => Object.values(this.data.sandbox),
    };
  }
}
