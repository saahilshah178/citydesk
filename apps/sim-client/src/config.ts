/** What the browser needs to know before it can connect: where the MCP server is and who we are. */

import { ApiError, fetchRuntimeConfig, type RuntimeConfig } from './api.ts';
import { resolveSandbox, type SandboxConfig } from './apps/sandbox-config.ts';

export const DEFAULT_MCP_URL = 'http://localhost:8787/mcp';
const DEVICE_KEY = 'citydesk.deviceId';

export interface ClientConfig {
  mcpUrl: string;
  /** Present only together with the `mcpUrl` the backend configured it for. */
  mcpToken: string | undefined;
  deviceId: string;
  sandbox: SandboxConfig;
  /** `null` when the backend could not be reached; the assistant and speech are then unavailable. */
  runtime: RuntimeConfig | null;
  /** Why `runtime` is null. */
  backendError: string | undefined;
}

function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // `randomUUID` needs a secure context; plain http on a LAN address does not qualify.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A UUID kept in localStorage: the "household" this browser is, as far as the server can tell. */
export function getDeviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_KEY);
    if (stored && /^[0-9a-f-]{36}$/i.test(stored)) return stored;
    const created = randomUuid();
    localStorage.setItem(DEVICE_KEY, created);
    return created;
  } catch {
    // Storage is blocked (private mode): the device lasts as long as the page.
    return randomUuid();
  }
}

export function resetDeviceId(): string {
  try {
    localStorage.removeItem(DEVICE_KEY);
  } catch {
    // Nothing stored, nothing to remove.
  }
  return getDeviceId();
}

export async function loadClientConfig(): Promise<ClientConfig> {
  let runtime: RuntimeConfig | null = null;
  let backendError: string | undefined;
  try {
    runtime = await fetchRuntimeConfig(AbortSignal.timeout(6_000));
  } catch (error) {
    backendError = error instanceof ApiError ? error.message : 'The backend is not reachable.';
  }

  const buildTimeUrl = import.meta.env['VITE_MCP_URL'] as string | undefined;
  return {
    // The backend's answer wins because its token belongs to that URL. Without a backend, the
    // client still connects (for manual tool calls) to the build-time URL, without a token.
    // A relative URL ("/mcp") means the MCP server is served from this page's own origin, which is
    // how the deployed client reaches it through CloudFront.
    mcpUrl: new URL(runtime?.mcpUrl || buildTimeUrl || DEFAULT_MCP_URL, window.location.href).href,
    mcpToken: runtime?.mcpToken ?? undefined,
    deviceId: getDeviceId(),
    sandbox: resolveSandbox(import.meta.env['VITE_SANDBOX_URL'] as string | undefined, window.location.href),
    runtime,
    backendError,
  };
}
