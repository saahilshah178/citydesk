import type { Tool } from '@modelcontextprotocol/client';
import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import { uiResourceUriOf } from '../apps/host.ts';
import { isModelVisible } from '../assistant/tools.ts';
import type { ClientConfig } from '../config.ts';
import type { McpSession } from '../mcp/session.ts';
import { compact, type TrafficEntry, type TrafficLog } from '../mcp/traffic.ts';

export type Connection =
  | { state: 'connecting'; url: string }
  | { state: 'ready'; url: string; session: McpSession }
  | { state: 'error'; url: string; error: string }
  | { state: 'closed'; url: string };

export interface ManualCallOutcome {
  ok: boolean;
  durationMs: number;
  /** Compacted result, or the error message. */
  body: unknown;
}

interface DevDrawerProps {
  config: ClientConfig | null;
  connection: Connection;
  tools: readonly Tool[];
  log: TrafficLog;
  onConnect: (url: string) => void;
  onNewDevice: () => void;
  onCallTool: (name: string, args: Record<string, unknown>) => Promise<ManualCallOutcome>;
}

/** A starting point for a tool's arguments: schema defaults, and a blank for each required field. */
export function argumentTemplate(tool: Tool | undefined): string {
  const schema = tool?.inputSchema as { properties?: Record<string, unknown>; required?: unknown } | undefined;
  const required = new Set(Array.isArray(schema?.required) ? (schema.required as unknown[]) : []);
  const args: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(schema?.properties ?? {})) {
    const property = (raw ?? {}) as { default?: unknown; type?: unknown; enum?: unknown };
    if ('default' in property) args[name] = property.default;
    else if (!required.has(name)) continue;
    else if (Array.isArray(property.enum) && property.enum.length > 0) args[name] = property.enum[0];
    else if (property.type === 'number' || property.type === 'integer') args[name] = 0;
    else if (property.type === 'boolean') args[name] = false;
    else if (property.type === 'array') args[name] = [];
    else if (property.type === 'object') args[name] = {};
    else args[name] = '';
  }
  return JSON.stringify(args, null, 2);
}

function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

const STATUS_LABEL: Record<TrafficEntry['status'], string> = {
  pending: 'waiting',
  ok: 'ok',
  error: 'error',
  tool_error: 'tool error',
  sent: 'sent',
  received: 'received',
};

function TrafficRow({ entry }: { entry: TrafficEntry }) {
  const [open, setOpen] = useState(false);
  const failed = entry.status === 'error' || entry.status === 'tool_error';
  return (
    <li className="traffic__item" data-failed={failed || undefined}>
      <button type="button" className="traffic__row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="traffic__time">{formatTime(entry.at)}</span>
        <span className="traffic__dir" title={entry.direction === 'out' ? 'client to server' : 'server to client'}>
          {entry.direction === 'out' ? '→' : '←'}
        </span>
        <span className="traffic__method">
          <span className="traffic__name">
            {entry.method}
            {entry.target && <span className="traffic__target"> {entry.target}</span>}
          </span>
          {entry.origin !== 'host' && <span className="tag">{entry.origin}</span>}
        </span>
        <span className="traffic__status" data-status={entry.status}>
          {STATUS_LABEL[entry.status]}
        </span>
        <span className="traffic__ms">{entry.durationMs === undefined ? '' : `${entry.durationMs} ms`}</span>
      </button>
      {open && (
        <div className="traffic__detail">
          {entry.rpcId !== undefined && <p className="drawer__meta">JSON-RPC id {String(entry.rpcId)}</p>}
          <h4>{entry.kind === 'request' ? 'params' : 'notification params'}</h4>
          <pre>{JSON.stringify(entry.params ?? {}, null, 2)}</pre>
          {entry.result !== undefined && (
            <>
              <h4>result</h4>
              <pre>{JSON.stringify(entry.result, null, 2)}</pre>
            </>
          )}
          {entry.error && (
            <>
              <h4>error</h4>
              <pre>{JSON.stringify(entry.error, null, 2)}</pre>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export function DevDrawer({ config, connection, tools, log, onConnect, onNewDevice, onCallTool }: DevDrawerProps) {
  const entries = useSyncExternalStore(log.subscribe, log.getSnapshot);
  const [url, setUrl] = useState(connection.url);
  const [selected, setSelected] = useState('');
  const [argsText, setArgsText] = useState('{}');
  const [calling, setCalling] = useState(false);
  const [outcome, setOutcome] = useState<ManualCallOutcome | null>(null);

  useEffect(() => setUrl(connection.url), [connection.url]);

  // Keep a valid selection as the tool list changes (reconnect, tools/list_changed).
  useEffect(() => {
    if (tools.some((tool) => tool.name === selected)) return;
    const first = tools.find((tool) => uiResourceUriOf(tool) && isModelVisible(tool)) ?? tools[0];
    setSelected(first?.name ?? '');
    setArgsText(argumentTemplate(first));
    setOutcome(null);
  }, [tools, selected]);

  const parsedArgs = useMemo((): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(argsText);
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }, [argsText]);

  const selectTool = (name: string): void => {
    setSelected(name);
    setArgsText(argumentTemplate(tools.find((tool) => tool.name === name)));
    setOutcome(null);
  };

  const submitCall = (event: FormEvent): void => {
    event.preventDefault();
    if (!selected || !parsedArgs || calling) return;
    setCalling(true);
    setOutcome(null);
    onCallTool(selected, parsedArgs)
      .then(setOutcome)
      .finally(() => setCalling(false));
  };

  const session = connection.state === 'ready' ? connection.session : null;
  const server = session?.serverInfo;
  const runtime = config?.runtime;

  return (
    <aside className="drawer" aria-label="Developer drawer">
      <header className="drawer__header">
        <h2>Developer</h2>
        <p>Live traffic of this page&rsquo;s MCP client. Nothing here is simulated.</p>
      </header>

      <section className="drawer__section">
        <h3>Connection</h3>
        <form
          className="drawer__connect"
          onSubmit={(event) => {
            event.preventDefault();
            if (url.trim()) onConnect(url.trim());
          }}
        >
          <label className="visually-hidden" htmlFor="mcp-url">
            MCP server URL
          </label>
          <input id="mcp-url" value={url} onChange={(event) => setUrl(event.target.value)} spellCheck={false} />
          <button type="submit">Connect</button>
        </form>
        <dl className="facts">
          <dt>Status</dt>
          <dd data-state={connection.state}>
            {connection.state === 'ready' && 'Connected over Streamable HTTP'}
            {connection.state === 'connecting' && 'Connecting'}
            {connection.state === 'closed' && 'Disconnected'}
            {connection.state === 'error' && connection.error}
          </dd>
          {session && (
            <>
              <dt>Server</dt>
              <dd>{server ? `${server.name} ${server.version}` : 'not identified'}</dd>
              <dt>Protocol</dt>
              <dd>
                {session.protocolVersion ?? 'unknown'}
                {session.sessionId ? `, session ${session.sessionId.slice(0, 8)}` : ', no session ID (stateless)'}
              </dd>
            </>
          )}
          <dt>Token</dt>
          <dd>
            {config?.mcpToken && connection.url === config.mcpUrl
              ? 'Bearer token sent on every request'
              : 'No token for this URL'}
          </dd>
          <dt>Device</dt>
          <dd>
            <code>{config?.deviceId ?? ''}</code>{' '}
            <button type="button" className="link" onClick={onNewDevice}>
              New device
            </button>
          </dd>
          <dt>Cards</dt>
          <dd>
            {config
              ? config.sandbox.mode === 'opaque'
                ? 'Sandbox proxy on this host, opaque origin'
                : `Sandbox proxy on ${new URL(config.sandbox.url).origin}`
              : ''}
          </dd>
          <dt>Assistant</dt>
          <dd>
            {runtime
              ? runtime.modelId
                ? `${runtime.modelId} in ${runtime.region}, voice ${runtime.voiceId}`
                : 'BEDROCK_MODEL_ID is not set on the backend'
              : (config?.backendError ?? 'Loading')}
          </dd>
        </dl>
      </section>

      <section className="drawer__section">
        <h3>
          Tools <span className="count">{tools.length}</span>
        </h3>
        {tools.length === 0 ? (
          <p className="drawer__meta">No tools listed yet.</p>
        ) : (
          <ul className="tools">
            {tools.map((tool) => (
              <li key={tool.name}>
                <button
                  type="button"
                  className="tools__row"
                  aria-pressed={tool.name === selected}
                  onClick={() => selectTool(tool.name)}
                >
                  <span className="tools__name">{tool.name}</span>
                  {uiResourceUriOf(tool) && <span className="tag">card</span>}
                  {!isModelVisible(tool) && <span className="tag tag--quiet">app only, hidden from the model</span>}
                  <span className="tools__description">{tool.description ?? tool.title ?? ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <form className="call" onSubmit={submitCall}>
          <label htmlFor="call-args">
            Arguments for <code>{selected || 'no tool'}</code>
          </label>
          <textarea
            id="call-args"
            value={argsText}
            onChange={(event) => setArgsText(event.target.value)}
            spellCheck={false}
            rows={6}
            aria-invalid={parsedArgs === null}
          />
          <div className="call__actions">
            <button type="submit" disabled={!session || !selected || parsedArgs === null || calling}>
              {calling ? 'Calling' : 'Call tool'}
            </button>
            {parsedArgs === null && <span className="drawer__meta">Arguments must be a JSON object.</span>}
            {outcome && (
              <span className="drawer__meta" data-failed={!outcome.ok || undefined}>
                {outcome.ok ? 'Returned' : 'Failed'} in {outcome.durationMs} ms
              </span>
            )}
          </div>
          {outcome && <pre className="call__result">{JSON.stringify(compact(outcome.body), null, 2)}</pre>}
        </form>
      </section>

      <section className="drawer__section drawer__section--grow">
        <h3>
          MCP traffic <span className="count">{entries.length}</span>
          <button type="button" className="link" onClick={() => log.clear()}>
            Clear
          </button>
        </h3>
        {entries.length === 0 ? (
          <p className="drawer__meta">No messages yet.</p>
        ) : (
          <ol className="traffic">
            {[...entries].reverse().map((entry) => (
              <TrafficRow key={entry.seq} entry={entry} />
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}
