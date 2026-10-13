import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import type { PutParameterCommandInput } from '@aws-sdk/client-ssm';
import { describe, expect, it } from 'vitest';

import { ensureParams, generateBearerToken } from '../lib/ensure-params.ts';
import type { ParameterStore } from '../lib/ensure-params.ts';

/** An in-memory stand-in for Parameter Store that records every write. */
function fakeStore(initial: Record<string, { type: string; value: string }> = {}) {
  const params = new Map(Object.entries(initial));
  const puts: PutParameterCommandInput[] = [];
  const send = async (command: GetParameterCommand | PutParameterCommand) => {
    if (command instanceof GetParameterCommand) {
      const found = params.get(command.input.Name ?? '');
      if (!found) throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
      return { Parameter: { Name: command.input.Name, Type: found.type, Value: found.value }, $metadata: {} };
    }
    const input = command.input;
    if (params.has(input.Name ?? '') && !input.Overwrite) {
      throw Object.assign(new Error('exists'), { name: 'ParameterAlreadyExists' });
    }
    puts.push(input);
    params.set(input.Name ?? '', { type: input.Type ?? 'String', value: input.Value ?? '' });
    return { Version: 1, $metadata: {} };
  };
  return { store: { send } as unknown as ParameterStore, params, puts };
}

describe('ensureParams', () => {
  it('creates a random 32-byte bearer token as a SecureString when it is missing', async () => {
    const { store, puts } = fakeStore();
    const results = await ensureParams({ store, env: {} });

    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({
      Name: '/citydesk/mcp-bearer-token',
      Type: 'SecureString',
      Tier: 'Standard',
      Overwrite: false,
    });
    expect(Buffer.from(puts[0]?.Value ?? '', 'base64url')).toHaveLength(32);
    expect(results.map(({ name, action }) => [name, action])).toEqual([
      ['/citydesk/mcp-bearer-token', 'created'],
      ['/citydesk/boston-open311-api-key', 'skipped'],
      ['/citydesk/seeclickfix-api-key', 'skipped'],
    ]);
  });

  it('generates a different token every time', () => {
    expect(generateBearerToken()).not.toBe(generateBearerToken());
  });

  it('never replaces an existing bearer token', async () => {
    const { store, puts, params } = fakeStore({
      '/citydesk/mcp-bearer-token': { type: 'SecureString', value: 'existing-token' },
    });
    const results = await ensureParams({ store, env: {} });

    expect(puts).toHaveLength(0);
    expect(params.get('/citydesk/mcp-bearer-token')?.value).toBe('existing-token');
    expect(results[0]).toMatchObject({ action: 'kept' });
  });

  it('writes API keys from the environment and rewrites them only when they change', async () => {
    const { store, puts } = fakeStore();
    const env = { BOSTON_OPEN311_API_KEY: 'boston-key-1', SEECLICKFIX_API_KEY: '  ' };

    const first = await ensureParams({ store, env });
    expect(first.map(({ action }) => action)).toEqual(['created', 'created', 'skipped']);
    expect(puts[1]).toMatchObject({
      Name: '/citydesk/boston-open311-api-key',
      Type: 'SecureString',
      Value: 'boston-key-1',
      Overwrite: false,
    });

    const second = await ensureParams({ store, env });
    expect(second.map(({ action }) => action)).toEqual(['kept', 'unchanged', 'skipped']);
    expect(puts).toHaveLength(2);

    const third = await ensureParams({ store, env: { BOSTON_OPEN311_API_KEY: 'boston-key-2' } });
    expect(third.map(({ action }) => action)).toEqual(['kept', 'updated', 'skipped']);
    expect(puts[2]).toMatchObject({ Value: 'boston-key-2', Overwrite: true });
  });

  it('never puts a secret value into what gets printed', async () => {
    const { store } = fakeStore({
      '/citydesk/seeclickfix-api-key': { type: 'SecureString', value: 'old-scf-secret' },
    });
    const results = await ensureParams({
      store,
      env: { BOSTON_OPEN311_API_KEY: 'boston-secret', SEECLICKFIX_API_KEY: 'new-scf-secret' },
      newToken: () => 'token-secret',
    });

    const printable = JSON.stringify(results);
    for (const secret of ['token-secret', 'boston-secret', 'old-scf-secret', 'new-scf-secret']) {
      expect(printable).not.toContain(secret);
    }
    expect(results.map(({ action }) => action)).toEqual(['created', 'created', 'updated']);
  });
});
