import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FIXTURES = resolve(import.meta.dirname, 'fixtures');

export function fixture(path: string): string {
  return readFileSync(resolve(FIXTURES, path), 'utf8');
}

export function fixtureJson<T = unknown>(path: string): T {
  return JSON.parse(fixture(path)) as T;
}

export interface RecordedCall {
  method: string;
  url: URL;
  body?: string;
  headers: Headers;
}

export type Route = (call: RecordedCall) => Response | undefined | Promise<Response | undefined>;

/**
 * A fetch that only answers from the given routes and records every call. Anything unrouted throws,
 * which is what guarantees the suite never touches the network.
 */
export function fakeFetch(...routes: Route[]): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const call: RecordedCall = {
      method: request.method,
      url: new URL(request.url),
      body: request.method === 'GET' ? undefined : await request.text(),
      headers: request.headers,
    };
    calls.push(call);
    for (const route of routes) {
      const res = await route(call);
      if (res) return res;
    }
    throw new Error(`fakeFetch: no route for ${call.method} ${call.url.href} (tests must not hit the network)`);
  };
  return { fetch: impl, calls };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** A clock and sleep pair where sleeping advances time instantly. */
export function fakeTime(start = Date.parse('2026-10-13T12:00:00Z')) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}
