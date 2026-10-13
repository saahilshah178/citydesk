import type { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { useEffect, useRef, useState } from 'react';
import { createAppBridge, loadSandboxProxy, readUiResource, startCard, stopCard } from '../apps/host.ts';
import type { SandboxConfig } from '../apps/sandbox-config.ts';
import type { McpSession } from '../mcp/session.ts';
import { CARD_MAX_HEIGHT, CARD_MIN_HEIGHT, CARD_WIDTH } from './layout.ts';

/** One tool call whose tool has a UI resource: the unit a card is created for. */
export interface CardCall {
  id: number;
  tool: Tool;
  input: Record<string, unknown>;
  result: Promise<CallToolResult>;
  resourceUri: string;
}

interface CardHandlers {
  onMessage: (text: string) => void;
  onOpenLink: (url: string) => boolean;
  onClose: (cardId: number) => void;
}

interface CardViewProps extends CardHandlers {
  session: McpSession;
  sandbox: SandboxConfig;
  card: CardCall;
  /** A newer card has replaced this one: tell the view, then report back so it can be unmounted. */
  leaving: boolean;
  onGone: () => void;
}

function CardView({ session, sandbox, card, leaving, onGone, onMessage, onOpenLink, onClose }: CardViewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [height, setHeight] = useState(CARD_MAX_HEIGHT);

  // The handlers change identity on every render of the app; the bridge must keep calling the latest.
  const handlers = useRef<CardHandlers>({ onMessage, onOpenLink, onClose });
  handlers.current = { onMessage, onOpenLink, onClose };

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return undefined;
    let disposed = false;

    void (async () => {
      const resource = await readUiResource(session, card.resourceUri);
      if (disposed) return;
      await loadSandboxProxy(iframe, sandbox, resource.permissions);
      if (disposed) return;

      const bridge = createAppBridge(
        session,
        card.tool,
        { width: CARD_WIDTH, maxHeight: CARD_MAX_HEIGHT },
        {
          onMessage: (text) => handlers.current.onMessage(text),
          onOpenLink: (url) => handlers.current.onOpenLink(url),
          onRequestClose: () => handlers.current.onClose(card.id),
          onSizeChange: (size) => {
            if (typeof size.height === 'number' && Number.isFinite(size.height)) {
              setHeight(Math.round(Math.min(CARD_MAX_HEIGHT, Math.max(CARD_MIN_HEIGHT, size.height))));
            }
          },
        },
      );
      bridgeRef.current = bridge;
      await startCard(iframe, bridge, { input: card.input, result: card.result, resource });
      if (!disposed) setStatus('ready');
    })().catch((cause: unknown) => {
      if (disposed) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus('error');
    });

    return () => {
      disposed = true;
      const bridge = bridgeRef.current;
      bridgeRef.current = null;
      if (bridge) void bridge.close().catch(() => undefined);
    };
    // A card never changes once created: a new tool call gets a new CardView through its key,
    // so this effect deliberately runs once per card.
  }, [card.id]);

  useEffect(() => {
    if (!leaving) return;
    const bridge = bridgeRef.current;
    bridgeRef.current = null;
    // Per the spec the host asks the view to wrap up before removing it.
    void (bridge ? stopCard(bridge) : Promise.resolve()).finally(onGone);
    // Runs once, when the card starts leaving.
  }, [leaving]);

  return (
    <div className="card" data-status={status} data-leaving={leaving || undefined} aria-busy={status === 'loading'}>
      <iframe
        ref={iframeRef}
        className="card__frame"
        title={card.tool.title ?? card.tool.name}
        style={{ width: CARD_WIDTH, height }}
      />
      {status === 'loading' && <p className="card__note">Loading the card</p>}
      {status === 'error' && <p className="card__note card__note--error">This card could not be shown. {error}</p>}
    </div>
  );
}

interface CardStageProps extends CardHandlers {
  session: McpSession;
  sandbox: SandboxConfig;
  card: CardCall | null;
}

/** Shows the current card, and keeps the previous one mounted just long enough to say goodbye to it. */
export function CardStage({ session, sandbox, card, ...handlers }: CardStageProps) {
  const [mounted, setMounted] = useState<Array<{ card: CardCall; leaving: boolean }>>([]);

  useEffect(() => {
    setMounted((previous) => {
      const next = previous.map((entry) => (entry.card.id === card?.id ? entry : { ...entry, leaving: true }));
      if (card && !next.some((entry) => entry.card.id === card.id)) next.push({ card, leaving: false });
      return next;
    });
  }, [card]);

  return (
    <div className="card-stage">
      {mounted.map((entry) => (
        <CardView
          key={entry.card.id}
          session={session}
          sandbox={sandbox}
          card={entry.card}
          leaving={entry.leaving}
          onGone={() => setMounted((previous) => previous.filter((item) => item.card.id !== entry.card.id))}
          {...handlers}
        />
      ))}
    </div>
  );
}
