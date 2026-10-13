/** Browser-side calls to the sim client's own backend (`server/app.ts`). */

import type { StructuredFormat } from './assistant/loop.ts';
import type { ConverseFn, ConverseResponse } from './assistant/types.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = 'http_error';
  let message = `The backend answered ${response.status}.`;
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.code === 'string') code = body.error.code;
    if (typeof body.error?.message === 'string') message = body.error.message;
  } catch {
    // Not JSON: most likely the Vite proxy reporting that the backend is not running.
    if (response.status >= 500) {
      code = 'backend_unreachable';
      message = 'The backend is not reachable. Start it with "pnpm --filter @citydesk/sim-client dev:api".';
    }
  }
  return new ApiError(response.status, code, message);
}

export interface RuntimeConfig {
  mcpUrl: string;
  mcpToken: string | null;
  modelId: string | null;
  voiceId: string;
  region: string;
  cityName: string;
  timeZone: string;
  toolResultFormat: StructuredFormat;
}

export async function fetchRuntimeConfig(signal?: AbortSignal): Promise<RuntimeConfig> {
  const response = await fetch('/api/config', { headers: { accept: 'application/json' }, signal: signal ?? null });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as RuntimeConfig;
}

/** One Converse call through the backend. The backend adds the system prompt and the model ID. */
export const apiConverse: ConverseFn = async (request, options) => {
  const response = await fetch('/api/converse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal: options?.signal ?? null,
  });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as ConverseResponse;
};

/** Synthesizes speech with Amazon Polly through the backend. Resolves to an MP3 blob. */
export async function apiSpeak(text: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch('/api/speak', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: signal ?? null,
  });
  if (!response.ok) throw await toApiError(response);
  return response.blob();
}
