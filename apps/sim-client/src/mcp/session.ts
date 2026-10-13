/**
 * One live MCP connection over Streamable HTTP, built on `@modelcontextprotocol/client` (v2).
 *
 * `connect` performs the real handshake (`initialize`, `notifications/initialized`) and then
 * `tools/list` (and `resources/list`, for card metadata). Every request carries
 * `Authorization: Bearer <token>` and `X-CityDesk-Device: <uuid>`; the server uses the device ID
 * to keep each demo household's memory apart.
 *
 * Nothing here touches the DOM, so the browser and `scripts/conversation.ts` share it.
 */

import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type FetchLike,
  type Implementation,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type ReadResourceResult,
  type Resource,
  type ServerCapabilities,
  type Tool,
  type Transport,
  type TransportSendOptions,
} from '@modelcontextprotocol/client';
import { TrafficLog, type TrafficOrigin } from './traffic.ts';

export const DEVICE_HEADER = 'X-CityDesk-Device';

/** MCP Apps extension identifier and MIME type (`EXTENSION_ID` and `RESOURCE_MIME_TYPE` in ext-apps). */
export const UI_EXTENSION_ID = 'io.modelcontextprotocol/ui';
export const UI_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

export const CLIENT_INFO: Implementation = { name: 'citydesk-sim-client', version: '0.1.0' };

const TOOL_CALL_TIMEOUT_MS = 30_000;

/** Passes every message through to the real transport and reports it to the traffic log. */
export class TappedTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined;

  constructor(
    private readonly inner: Transport,
    private readonly log: TrafficLog,
  ) {}

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  set sessionId(_value: string | undefined) {
    // The real transport owns the session ID.
  }

  get hasPerRequestStream(): boolean | undefined {
    return this.inner.hasPerRequestStream;
  }

  setProtocolVersion = (version: string): void => {
    this.inner.setProtocolVersion?.(version);
  };

  setSupportedProtocolVersions = (versions: string[]): void => {
    this.inner.setSupportedProtocolVersions?.(versions);
  };

  async start(): Promise<void> {
    this.inner.onmessage = (message, extra) => {
      this.log.incoming(message);
      this.onmessage?.(message, extra);
    };
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.log.outgoing(message);
    try {
      await this.inner.send(message, options);
    } catch (error) {
      this.log.failed(message, error);
      throw error;
    }
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

export interface SessionOptions {
  url: string;
  /** Sent as `Authorization: Bearer <token>` on every request. */
  token?: string | undefined;
  /** Sent as `X-CityDesk-Device` on every request. */
  deviceId: string;
  clientInfo?: Implementation;
  log?: TrafficLog;
  /** Replaces the global `fetch`. Tests use it to observe the HTTP requests. */
  fetch?: FetchLike;
  onToolsChanged?: (tools: Tool[]) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
}

export interface CallOptions {
  origin?: TrafficOrigin;
  signal?: AbortSignal | undefined;
}

export class McpSession {
  tools: Tool[] = [];
  /** `resources/list` entries by URI. Cards may carry their CSP here instead of on the content. */
  resources = new Map<string, Resource>();

  private constructor(
    readonly url: string,
    readonly deviceId: string,
    readonly log: TrafficLog,
    readonly client: Client,
    private readonly transport: StreamableHTTPClientTransport,
  ) {}

  static async connect(options: SessionOptions): Promise<McpSession> {
    const log = options.log ?? new TrafficLog();
    const transport = new StreamableHTTPClientTransport(new URL(options.url), {
      // `token()` is asked before every request, so every request carries the bearer token.
      ...(options.token ? { authProvider: { token: async () => options.token } } : {}),
      requestInit: { headers: { [DEVICE_HEADER]: options.deviceId } },
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });

    let session: McpSession | undefined;
    const client = new Client(options.clientInfo ?? CLIENT_INFO, {
      capabilities: {
        // Tells the server this host renders MCP Apps (`getUiCapability` on the server side).
        extensions: { [UI_EXTENSION_ID]: { mimeTypes: [UI_RESOURCE_MIME_TYPE] } },
      },
      listChanged: {
        tools: {
          onChanged: (error, tools) => {
            if (error || !tools || !session) return;
            session.tools = tools;
            options.onToolsChanged?.(tools);
          },
        },
      },
    });
    client.onclose = () => options.onClose?.();
    client.onerror = (error) => options.onError?.(error);

    // Default negotiation mode ('legacy'): the plain `initialize` handshake.
    try {
      await client.connect(new TappedTransport(transport, log));
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    session = new McpSession(options.url, options.deviceId, log, client, transport);
    try {
      await session.refreshTools();
      await session.refreshResources();
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
    return session;
  }

  get serverInfo(): Implementation | undefined {
    return this.client.getServerVersion();
  }

  get serverCapabilities(): ServerCapabilities | undefined {
    return this.client.getServerCapabilities();
  }

  get protocolVersion(): string | undefined {
    return this.client.getNegotiatedProtocolVersion();
  }

  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  findTool(name: string): Tool | undefined {
    return this.tools.find((tool) => tool.name === name);
  }

  async refreshTools(): Promise<Tool[]> {
    const { tools } = await this.client.listTools(undefined, { cacheMode: 'refresh' });
    this.tools = tools;
    return tools;
  }

  async refreshResources(): Promise<void> {
    if (!this.serverCapabilities?.resources) return;
    const { resources } = await this.client.listResources(undefined, { cacheMode: 'refresh' });
    this.resources = new Map(resources.map((resource) => [resource.uri, resource]));
  }

  async callTool(name: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<CallToolResult> {
    this.log.expect('tools/call', name, options.origin ?? 'host');
    return this.client.callTool(
      { name, arguments: args },
      { timeout: TOOL_CALL_TIMEOUT_MS, ...(options.signal ? { signal: options.signal } : {}) },
    );
  }

  async readResource(uri: string, options: CallOptions = {}): Promise<ReadResourceResult> {
    this.log.expect('resources/read', uri, options.origin ?? 'host');
    return this.client.readResource(
      { uri },
      { cacheMode: 'bypass', ...(options.signal ? { signal: options.signal } : {}) },
    );
  }

  async close(): Promise<void> {
    if (this.transport.sessionId) {
      // Servers may answer 405 to say sessions cannot be ended by the client; that is fine.
      await this.transport.terminateSession().catch(() => undefined);
    }
    await this.client.close();
  }
}
