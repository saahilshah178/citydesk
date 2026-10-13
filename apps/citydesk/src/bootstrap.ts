/**
 * Chooses the concrete pieces of the runtime from the environment: which store, which geocoder,
 * whether cards and maps are available. Shared by the local server and the Lambda handler.
 */
import { CityDeskRuntime, type RuntimeOptions } from './runtime.ts';
import type { CityDeskServerHooks } from './server.ts';
import { MemoryStore } from './store/memory.ts';

export interface BootstrapOptions {
  env: Record<string, string | undefined>;
  /** Where the in-memory store persists itself. Omit to keep it in memory only. */
  memoryFile?: string;
  log?: RuntimeOptions['log'];
}

export interface Bootstrapped {
  runtime: CityDeskRuntime;
  hooks: CityDeskServerHooks;
  /** Human-readable lines describing what was wired up. */
  summary: string[];
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function buildRuntime(options: BootstrapOptions): Promise<Bootstrapped> {
  const { env } = options;
  const summary: string[] = [];
  const memory = new MemoryStore(options.memoryFile);
  summary.push(`store: memory${options.memoryFile ? ` (persisted to ${options.memoryFile})` : ''}`);
  summary.push('geocoder: Boston address points (street addresses only)');

  const runtime = new CityDeskRuntime({
    env,
    log: options.log,
    store: memory,
    sandboxStore: memory.sandboxStore(),
    config: {
      dedupeRadiusMeters: positiveNumber(env.CITYDESK_DEDUPE_RADIUS_M, 50),
      dedupeWindowDays: positiveNumber(env.CITYDESK_DEDUPE_WINDOW_DAYS, 30),
    },
  });
  return { runtime, hooks: {}, summary };
}
