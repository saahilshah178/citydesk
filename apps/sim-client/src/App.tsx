import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiConverse } from './api.ts';
import { preloadUiResources, uiResourceUriOf } from './apps/host.ts';
import { runAssistantTurn } from './assistant/loop.ts';
import { isModelVisible } from './assistant/tools.ts';
import type { Message } from './assistant/types.ts';
import { loadClientConfig, resetDeviceId, type ClientConfig } from './config.ts';
import { McpSession } from './mcp/session.ts';
import { TrafficLog, type TrafficOrigin } from './mcp/traffic.ts';
import { CardStage, type CardCall } from './ui/CardStage.tsx';
import { Controls } from './ui/Controls.tsx';
import { DevDrawer, type Connection, type ManualCallOutcome } from './ui/DevDrawer.tsx';
import { EchoFrame } from './ui/EchoFrame.tsx';
import { HomeScreen } from './ui/HomeScreen.tsx';
import { PushToTalk, speechRecognitionSupported } from './voice/recognition.ts';
import { Speaker } from './voice/speech.ts';

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

const PHASE_LABEL: Record<Phase, string> = {
  idle: '',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

const DRAWER_KEY = 'citydesk.drawer';
const NO_CAPTIONS = { user: '', assistant: '' };

function initialDrawerOpen(): boolean {
  if (new URLSearchParams(window.location.search).has('dev')) return true;
  try {
    return localStorage.getItem(DRAWER_KEY) === 'open';
  } catch {
    return false;
  }
}

function describeConnectError(error: unknown, url: string): string {
  if (error instanceof Error && error.name === 'UnauthorizedError') {
    return 'The MCP server rejected the bearer token (401).';
  }
  // fetch() reports DNS, refused connections and CORS refusals alike as a bare TypeError.
  if (error instanceof TypeError) {
    return `Could not reach ${url}. The server may be down, or it may not allow this page's origin (CORS).`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Backend errors arrive as full sentences that already say what is wrong, so they are shown as they are. */
function describeAssistantError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return 'The assistant is unavailable: the backend could not be reached.';
  return `The assistant could not answer. ${error instanceof Error ? error.message : String(error)}`;
}

function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.id === 'talk-button') return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'SUMMARY'].includes(target.tagName);
}

export function App() {
  const log = useMemo(() => new TrafficLog(), []);
  const speaker = useMemo(() => new Speaker(), []);
  const speechSupported = useMemo(() => speechRecognitionSupported(), []);

  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [connection, setConnection] = useState<Connection>({ state: 'connecting', url: '' });
  const [tools, setTools] = useState<Tool[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [captions, setCaptions] = useState(NO_CAPTIONS);
  const [notice, setNotice] = useState('');
  const [openedLink, setOpenedLink] = useState<string | null>(null);
  const [card, setCard] = useState<CardCall | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(initialDrawerOpen);
  const now = useNow(15_000);

  const sessionRef = useRef<McpSession | null>(null);
  const configRef = useRef<ClientConfig | null>(null);
  const historyRef = useRef<Message[]>([]);
  const turnRef = useRef<AbortController | null>(null);
  const cardSeq = useRef(0);
  const connectSeq = useRef(0);

  const session = connection.state === 'ready' ? connection.session : null;

  // ---- MCP connection ---------------------------------------------------------------------

  const connect = useCallback(
    async (url: string, current: ClientConfig) => {
      const attempt = (connectSeq.current += 1);
      setConnection({ state: 'connecting', url });
      setTools([]);
      setCard(null);
      historyRef.current = [];

      const previous = sessionRef.current;
      sessionRef.current = null;
      await previous?.close().catch(() => undefined);

      try {
        const next = await McpSession.connect({
          url,
          // The token belongs to the configured server. It is never sent to another URL.
          token: url === current.mcpUrl ? current.mcpToken : undefined,
          deviceId: current.deviceId,
          log,
          onToolsChanged: (list) => {
            if (sessionRef.current === next) setTools(list);
          },
          onClose: () => {
            if (sessionRef.current === next) setConnection({ state: 'closed', url });
          },
        });
        if (attempt !== connectSeq.current) {
          await next.close().catch(() => undefined);
          return;
        }
        sessionRef.current = next;
        setTools(next.tools);
        setConnection({ state: 'ready', url, session: next });
        preloadUiResources(next);
      } catch (error) {
        if (attempt === connectSeq.current) {
          setConnection({ state: 'error', url, error: describeConnectError(error, url) });
        }
      }
    },
    [log],
  );

  useEffect(() => {
    let cancelled = false;
    void loadClientConfig().then((loaded) => {
      if (cancelled) return;
      configRef.current = loaded;
      setConfig(loaded);
      void connect(loaded.mcpUrl, loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [connect]);

  useEffect(() => {
    try {
      localStorage.setItem(DRAWER_KEY, drawerOpen ? 'open' : 'closed');
    } catch {
      // Storage is blocked: the drawer state just does not persist.
    }
  }, [drawerOpen]);

  // ---- tools and cards --------------------------------------------------------------------

  /** Every tool call made by the host goes through here, so each one can put its card on screen. */
  const invokeTool = useCallback(
    (name: string, args: Record<string, unknown>, origin: TrafficOrigin, signal?: AbortSignal): Promise<CallToolResult> => {
      const active = sessionRef.current;
      if (!active) return Promise.reject(new Error('Not connected to the MCP server.'));
      const tool = active.findTool(name);
      const result = active.callTool(name, args, { origin, signal });
      // App-only tools belong to a card that is already open; they do not open one themselves.
      const resourceUri = tool && isModelVisible(tool) ? uiResourceUriOf(tool) : undefined;
      if (tool && resourceUri) {
        setCard({ id: (cardSeq.current += 1), tool, input: args, result, resourceUri });
      }
      return result;
    },
    [],
  );

  const callManually = useCallback(
    async (name: string, args: Record<string, unknown>): Promise<ManualCallOutcome> => {
      const started = performance.now();
      const elapsed = (): number => Math.round(performance.now() - started);
      setCaptions(NO_CAPTIONS);
      setNotice(`Called ${name} by hand from the developer drawer.`);
      try {
        const result = await invokeTool(name, args, 'manual');
        return { ok: result.isError !== true, durationMs: elapsed(), body: result };
      } catch (error) {
        return { ok: false, durationMs: elapsed(), body: { error: error instanceof Error ? error.message : String(error) } };
      }
    },
    [invokeTool],
  );

  // ---- the assistant ----------------------------------------------------------------------

  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      turnRef.current?.abort();
      speaker.stop();
      const turn = new AbortController();
      turnRef.current = turn;
      const stillCurrent = (): boolean => turnRef.current === turn && !turn.signal.aborted;

      setCaptions({ user: text, assistant: '' });
      setNotice('');
      setOpenedLink(null);
      setPhase('thinking');

      try {
        const active = sessionRef.current;
        if (!active) throw new Error('Not connected to the MCP server.');
        const format = configRef.current?.runtime?.toolResultFormat;
        const result = await runAssistantTurn({
          converse: apiConverse,
          callTool: (name, args, options) => invokeTool(name, args, 'assistant', options?.signal),
          tools: active.tools,
          history: historyRef.current,
          userText: text,
          signal: turn.signal,
          ...(format ? { structuredFormat: format } : {}),
        });
        if (!stillCurrent()) return;
        historyRef.current = result.messages;
        setCaptions({ user: text, assistant: result.reply });

        try {
          await speaker.speak(result.reply, () => {
            if (stillCurrent()) setPhase('speaking');
          });
        } catch (error) {
          // The reply is already on screen as a caption; only the voice is missing.
          if (stillCurrent()) {
            setNotice(`Spoken replies are unavailable. ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (stillCurrent()) setPhase('idle');
      } catch (error) {
        if (!stillCurrent()) return;
        setPhase('idle');
        setNotice(describeAssistantError(error));
      }
    },
    [invokeTool, speaker],
  );

  const goHome = useCallback(() => {
    turnRef.current?.abort();
    turnRef.current = null;
    speaker.stop();
    historyRef.current = [];
    setCard(null);
    setCaptions(NO_CAPTIONS);
    setNotice('');
    setOpenedLink(null);
    setPhase('idle');
  }, [speaker]);

  // ---- voice ------------------------------------------------------------------------------

  const submitRef = useRef(submit);
  submitRef.current = submit;

  const talk = useMemo(
    () =>
      new PushToTalk({
        onTranscript: (text) => setCaptions({ user: text, assistant: '' }),
        onDone: (text) => {
          if (text) void submitRef.current(text);
          else setPhase((current) => (current === 'listening' ? 'idle' : current));
        },
        onError: (message) => setNotice(message),
      }),
    [],
  );

  const startTalking = useCallback(() => {
    // Starting to talk interrupts the assistant, whether it is speaking or still working.
    speaker.stop();
    turnRef.current?.abort();
    turnRef.current = null;
    if (!talk.start()) return;
    setPhase('listening');
    setNotice('');
    setOpenedLink(null);
    setCaptions(NO_CAPTIONS);
  }, [speaker, talk]);

  const stopTalking = useCallback(() => talk.stop(), [talk]);

  useEffect(() => {
    if (!speechSupported) return undefined;
    const down = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat || isTypingTarget(event.target)) return;
      event.preventDefault();
      startTalking();
    };
    const up = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || isTypingTarget(event.target)) return;
      event.preventDefault();
      stopTalking();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [speechSupported, startTalking, stopTalking]);

  // ---- requests from cards ----------------------------------------------------------------

  const openLink = useCallback((url: string): boolean => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    window.open(parsed.href, '_blank', 'noopener,noreferrer');
    // With "noopener" the browser does not say whether a tab opened, so the link is shown as well.
    setOpenedLink(parsed.href);
    return true;
  }, []);

  const closeCard = useCallback((cardId: number) => {
    setCard((current) => (current?.id === cardId ? null : current));
  }, []);

  // ---- rendering --------------------------------------------------------------------------

  const cityName = config?.runtime?.cityName ?? 'Boston';
  const timeZone = config?.runtime?.timeZone ?? 'America/New_York';
  const hasCaptions = Boolean(captions.user || captions.assistant || notice || openedLink);
  const view = card ? 'card' : hasCaptions || phase === 'thinking' || phase === 'speaking' ? 'talk' : 'home';
  const clock = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(now);

  return (
    <div className="page" data-drawer={drawerOpen || undefined}>
      <div className="workspace">
        <header className="masthead">
          <div>
            <h1>CityDesk</h1>
            <p>City services by voice, on an Echo Show style display.</p>
          </div>
          <button
            type="button"
            className="drawer-toggle"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            {drawerOpen ? 'Hide developer drawer' : 'Developer drawer'}
          </button>
        </header>

        <EchoFrame>
          <div className="topbar">
            <button type="button" className="topbar__home" onClick={goHome} disabled={view === 'home'}>
              <span className="topbar__mark">CityDesk</span>
              <span className="topbar__city">{cityName}</span>
            </button>
            <div className="topbar__right">
              {connection.state !== 'ready' && (
                <span className="topbar__status" data-state={connection.state}>
                  {connection.state === 'connecting' ? 'Connecting to city services' : 'City services are offline'}
                </span>
              )}
              {view !== 'home' && <span className="topbar__clock">{clock}</span>}
            </div>
          </div>

          <div className="content" data-view={view}>
            {view === 'home' && (
              <HomeScreen
                now={now}
                timeZone={timeZone}
                cityName={cityName}
                onPhrase={(phrase) => void submit(phrase)}
                disabled={!session}
              />
            )}
            {session && config && (
              <CardStage
                session={session}
                sandbox={config.sandbox}
                card={card}
                onMessage={(text) => void submit(text)}
                onOpenLink={openLink}
                onClose={closeCard}
              />
            )}
          </div>

          <div className="captions" data-view={view} aria-live="polite">
            {captions.user && <p className="captions__user">{captions.user}</p>}
            {captions.assistant && <p className="captions__assistant">{captions.assistant}</p>}
            {notice && <p className="captions__notice">{notice}</p>}
            {openedLink && (
              <p className="captions__notice">
                Opened{' '}
                <a href={openedLink} target="_blank" rel="noopener noreferrer">
                  {new URL(openedLink).hostname}
                </a>{' '}
                in a new tab.
              </p>
            )}
          </div>

          <div className="lightbar" data-phase={phase} role="status">
            <span className="lightbar__label">{PHASE_LABEL[phase]}</span>
            <span className="lightbar__track" aria-hidden="true">
              <span className="lightbar__glow" />
            </span>
          </div>
        </EchoFrame>

        <Controls
          listening={phase === 'listening'}
          speechSupported={speechSupported}
          disabled={!session}
          onTalkStart={startTalking}
          onTalkEnd={stopTalking}
          onSubmit={(text) => void submit(text)}
        />
      </div>

      {drawerOpen && (
        <DevDrawer
          config={config}
          connection={connection}
          tools={tools}
          log={log}
          onConnect={(url) => {
            if (configRef.current) void connect(url, configRef.current);
          }}
          onNewDevice={() => {
            const current = configRef.current;
            if (!current) return;
            const next = { ...current, deviceId: resetDeviceId() };
            configRef.current = next;
            setConfig(next);
            goHome();
            void connect(connection.url || next.mcpUrl, next);
          }}
          onCallTool={callManually}
        />
      )}
    </div>
  );
}
