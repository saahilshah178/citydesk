/**
 * States both cards share: loading, a plain message, a clarifying question with answer chips, and
 * a tool error.
 */
import type { Clarification, ErrorCode, ErrorResult } from '../../../src/contract.ts';
import { h, icon, isRecord, type Child, type IconName } from './dom.ts';
import type { CardContext } from './host.ts';

const MAX_OPTIONS = 5;

export interface HeadOptions {
  eyebrow: string;
  /** Short context after the eyebrow, e.g. the city name. */
  context?: string | null;
  /** Optional second line (list states use it for the count). */
  headline?: string | null;
  tags?: Child[];
}

export function head(options: HeadOptions): HTMLElement {
  const eyebrow = h('div', { class: 'eyebrow' }, h('span', { class: 'eyebrow-mark' }), h('span', null, options.eyebrow));
  if (options.context) {
    eyebrow.append(h('span', { class: 'eyebrow-sep' }, '/'), h('span', null, options.context));
  }
  const text = h('div', { class: 'head-text' }, eyebrow);
  if (options.headline) text.append(h('h1', { class: 'headline' }, options.headline));
  const tags = (options.tags ?? []).filter((tag) => tag !== null && tag !== undefined && tag !== false);
  return h('header', { class: 'head' }, text, tags.length > 0 ? h('div', { class: 'head-tags' }, ...tags) : null);
}

export function tag(text: string, variant?: 'sandbox'): HTMLElement {
  return h('span', { class: variant ? `tag tag--${variant}` : 'tag' }, text);
}

export function renderLoading(stage: HTMLElement): void {
  stage.replaceChildren(
    head({ eyebrow: 'CityDesk' }),
    h(
      'div',
      { class: 'center', role: 'status' },
      h('div', { class: 'loading-dots' }, h('span'), h('span'), h('span')),
      h('p', { class: 'center-body' }, 'One moment.'),
    ),
  );
}

export interface MessageOptions {
  eyebrow: string;
  context?: string | null;
  title: string;
  body?: string | null;
  icon?: IconName;
  fine?: Child[];
}

export function messageBlock(options: MessageOptions): HTMLElement {
  const fine = (options.fine ?? []).filter((item) => item !== null && item !== undefined && item !== false);
  return h(
    'div',
    { class: 'center' },
    options.icon ? icon(options.icon, 'center-icon') : null,
    h('h1', { class: 'center-title' }, options.title),
    options.body && options.body !== options.title ? h('p', { class: 'center-body' }, options.body) : null,
    fine.length > 0 ? h('div', { class: 'center-fine' }, ...fine) : null,
  );
}

export function renderMessage(stage: HTMLElement, options: MessageOptions): void {
  stage.replaceChildren(head({ eyebrow: options.eyebrow, context: options.context }), messageBlock(options));
}

/**
 * A question the assistant needs answered. Each option is a large chip; tapping one sends its text
 * to the host as a user message (ui/message), which is the same as the resident saying it.
 */
export function renderClarification(
  ctx: CardContext,
  options: { eyebrow: string; context?: string | null; clarification: Clarification | undefined; fallback: string },
): void {
  const clarification = isRecord(options.clarification) ? options.clarification : undefined;
  const question =
    (typeof clarification?.question === 'string' && clarification.question.trim()) ||
    options.fallback.trim() ||
    'Could you tell me a little more?';
  const choices = (Array.isArray(clarification?.options) ? clarification.options : [])
    .filter((choice): choice is string => typeof choice === 'string' && choice.trim() !== '')
    .slice(0, MAX_OPTIONS);

  const idleHint = choices.length > 0 ? 'Tap an answer, or just say it.' : 'Just say your answer.';
  const hint = h('p', { class: 'hint', role: 'status' }, idleHint);
  const chips: HTMLButtonElement[] = [];
  let busy = false;

  for (const choice of choices) {
    const chip = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false' }, choice);
    chip.addEventListener('click', () => {
      if (busy) return;
      busy = true;
      chip.setAttribute('aria-pressed', 'true');
      chip.prepend(icon('check'));
      for (const other of chips) other.disabled = true;
      hint.textContent = 'Sending your answer.';
      void ctx.say(choice).then((sent) => {
        if (sent) {
          hint.textContent = `Sent: ${choice}`;
          return;
        }
        // The host would not take a message from the card: let the resident try again or speak.
        busy = false;
        chip.setAttribute('aria-pressed', 'false');
        chip.querySelector('svg')?.remove();
        for (const other of chips) other.disabled = false;
        hint.textContent = 'That did not go through. Please say your answer instead.';
      });
    });
    chips.push(chip);
  }

  ctx.stage.replaceChildren(
    head({ eyebrow: options.eyebrow, context: options.context }),
    h(
      'div',
      { class: 'center' },
      h('h1', { class: 'question' }, question),
      chips.length > 0 ? h('div', { class: 'chips' }, ...chips) : null,
      hint,
    ),
  );
}

const ERROR_TITLES: Record<ErrorCode, string> = {
  invalid_input: 'That request needs one more detail',
  not_found: 'That request could not be found',
  location_not_found: 'That location could not be found',
  outside_service_area: 'That is outside the service area',
  service_not_available: 'That service is not available here',
  write_blocked: 'Filing is turned off right now',
  rate_limited: 'Too many requests right now',
  upstream_unavailable: 'The city system is not responding',
  not_configured: 'CityDesk is not set up for that yet',
  internal: 'Something went wrong',
};

export function isErrorResult(value: unknown): value is ErrorResult {
  return isRecord(value) && value.outcome === 'error' && isRecord(value.error);
}

export function renderError(ctx: CardContext, result: ErrorResult): void {
  const code = typeof result.error.code === 'string' ? result.error.code : 'internal';
  const title = (ERROR_TITLES as Record<string, string | undefined>)[code] ?? ERROR_TITLES.internal;
  const summary = typeof result.spoken_summary === 'string' ? result.spoken_summary.trim() : '';
  const message = typeof result.error.message === 'string' ? result.error.message.trim() : '';
  const fine: Child[] = [];
  if (result.error.retryable === true) fine.push(h('span', null, 'You can try again in a moment.'));
  if (message && message !== summary) fine.push(h('span', null, message));
  fine.push(h('span', { class: 'code' }, code));

  renderMessage(ctx.stage, {
    eyebrow: 'Could not finish that',
    icon: 'alert',
    title,
    body: summary || message,
    fine,
  });
}

/** A failed tool call that did not carry the contract's ErrorResult. */
export function renderPlainError(ctx: CardContext, text: string): void {
  renderMessage(ctx.stage, {
    eyebrow: 'Could not finish that',
    icon: 'alert',
    title: ERROR_TITLES.internal,
    body: text || 'Please try again in a moment.',
  });
}
