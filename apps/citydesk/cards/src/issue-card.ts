/**
 * Issue card (ui://citydesk/issue-card.html).
 *
 * Renders the structuredContent of report_issue, find_nearby_reports, follow_request, my_requests
 * and request_status: an IssueResult, or an ErrorResult when the call failed.
 */
import type {
  IssueOutcome,
  IssueResult,
  IssueView,
  ResolvedLocation,
  TimelineStep,
} from '../../src/contract.ts';
import { h, icon, isRecord, svg } from './shared/dom.ts';
import {
  formatCoordinates,
  formatDateTime,
  formatDay,
  formatDistance,
  plural,
  shortId,
} from './shared/format.ts';
import { startCard, type CardContext, type ToolPayload } from './shared/host.ts';
import {
  head,
  isErrorResult,
  messageBlock,
  renderClarification,
  renderError,
  renderMessage,
  renderPlainError,
  tag,
} from './shared/views.ts';

/** A list shows at most this many requests; the first one is featured. */
const LIST_LIMIT = 5;
const TIMELINE_LIMIT = 4;

const OUTCOMES: ReadonlySet<string> = new Set<IssueOutcome>([
  'filed',
  'possible_duplicate',
  'needs_clarification',
  'followed',
  'status',
  'requests',
  'nearby',
]);

function isIssueResult(value: unknown): value is IssueResult {
  return isRecord(value) && typeof value.outcome === 'string' && OUTCOMES.has(value.outcome);
}

function isIssueView(value: unknown): value is IssueView {
  return isRecord(value) && typeof value.service_request_id === 'string' && typeof value.service_name === 'string';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function hasCoordinates(view: { lat?: unknown; long?: unknown }): view is { lat: number; long: number } {
  return formatCoordinates(view.lat, view.long) !== null;
}

const RELATION_LABEL: Record<string, string | undefined> = {
  filed: 'Filed by you',
  followed: 'Following',
};

/** Callbacks that need the element to be in the document (to measure it). */
type Mounts = Array<() => void>;

interface RenderEnv {
  ctx: CardContext;
  asOf: string;
  mounts: Mounts;
}

// ---------- map ----------

/** The drawn stand-in for a map: a few streets on a plain ground. Constant markup, no tool data. */
const MAP_ART =
  '<rect class="map-land" x="0" y="0" width="400" height="320"/>' +
  '<path class="map-block" d="M213 8l88-12 16 118-90 11z"/>' +
  '<g class="map-streets">' +
  '<path d="M-20 62L420 10"/><path d="M-20 290L420 238"/>' +
  '<path d="M64 -20L108 340"/><path d="M318 -20L362 340"/>' +
  '</g>' +
  '<g class="map-avenues"><path d="M-20 186L420 134"/><path d="M178 -20L222 340"/></g>';

const PIN_ART =
  '<ellipse class="pin-shadow" cx="20" cy="51" rx="7" ry="2.5"/>' +
  '<path class="pin-body" d="M20 50C20 50 4 31.5 4 19a16 16 0 1 1 32 0c0 12.5-16 31-16 31z"/>' +
  '<circle class="pin-dot" cx="20" cy="19" r="6"/>';

interface MapOptions {
  lat?: unknown;
  long?: unknown;
  label?: string;
  photoUrl?: string;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The request photo, as a thumbnail that enlarges on tap. It stays out of the layout until the
 * image has actually loaded and is removed if it fails (missing file, blocked by the host's CSP),
 * so a broken image can never show.
 */
function photoButton(url: string, figure: HTMLElement): HTMLElement | null {
  if (!isHttpsUrl(url)) return null;
  const image = h('img', { class: 'photo-img', alt: 'Photo attached to this request', referrerpolicy: 'no-referrer' });
  const button = h(
    'button',
    { class: 'photo', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Enlarge the request photo', hidden: true },
    image,
    h('span', { class: 'photo-close' }, icon('shrink')),
  );
  image.addEventListener('load', () => {
    if (image.naturalWidth > 1 && image.naturalHeight > 1) button.hidden = false;
    else button.remove();
  });
  image.addEventListener('error', () => button.remove());
  button.addEventListener('click', () => {
    const open = figure.classList.toggle('photo-open');
    button.setAttribute('aria-pressed', String(open));
    button.setAttribute('aria-label', open ? 'Shrink the request photo' : 'Enlarge the request photo');
  });
  image.src = url;
  return button;
}

function mapPanel(env: RenderEnv, options: MapOptions): HTMLElement {
  const coordinates = formatCoordinates(options.lat, options.long);
  const label = options.label ?? '';
  const figure = h('figure', {
    class: 'map',
    'aria-label': label ? `Map showing ${label}` : 'Map of the request location',
  });

  figure.append(
    svg('0 0 400 320', 'map-art', MAP_ART, 'xMidYMid slice'),
    svg('0 0 40 54', 'pin', PIN_ART),
    h(
      'figcaption',
      { class: 'map-caption' },
      h('span', { class: 'map-caption-label' }, label || 'Location not given'),
      coordinates ? h('span', { class: 'map-caption-coords' }, coordinates) : null,
    ),
  );

  const photo = options.photoUrl ? photoButton(options.photoUrl, figure) : null;
  if (photo) figure.append(photo);

  if (hasCoordinates(options)) {
    const { lat, long } = options;
    env.mounts.push(() => {
      const box = figure.getBoundingClientRect();
      void env.ctx.staticMap(lat, long, box.width, box.height).then((url) => {
        // No map (tool missing, failed, or returned no image): the drawn placeholder stays.
        if (!url || !figure.isConnected) return;
        const image = h('img', { class: 'map-img', alt: '' });
        image.addEventListener('load', () => {
          if (image.naturalWidth > 1) figure.classList.add('has-map');
          else image.remove();
        });
        image.addEventListener('error', () => image.remove());
        image.src = url;
        figure.prepend(image);
      });
    });
  }
  return figure;
}

// ---------- one request ----------

function statusPill(view: IssueView): HTMLElement {
  const closed = view.status === 'closed';
  return h(
    'span',
    { class: closed ? 'status status--closed' : 'status status--open' },
    closed ? icon('check', 'status-icon') : h('span', { class: 'status-dot' }),
    closed ? 'Closed' : 'Open',
  );
}

/** Keeps the steps around the current one when a city reports more than fit. */
function visibleSteps(steps: TimelineStep[]): TimelineStep[] {
  if (steps.length <= TIMELINE_LIMIT) return steps;
  let anchor = steps.findIndex((step) => step.state === 'current');
  if (anchor < 0) anchor = steps.reduce((last, step, index) => (step.state === 'done' ? index : last), 0);
  const start = Math.max(0, Math.min(anchor - (TIMELINE_LIMIT - 2), steps.length - TIMELINE_LIMIT));
  return steps.slice(start, start + TIMELINE_LIMIT);
}

function timeline(view: IssueView, env: RenderEnv): HTMLElement | null {
  const steps = (Array.isArray(view.timeline) ? view.timeline : []).filter(
    (step): step is TimelineStep => isRecord(step) && text(step.label) !== '',
  );
  if (steps.length === 0) return null;
  const zone = env.ctx.timeZone();
  return h(
    'ol',
    { class: 'timeline', 'aria-label': 'Status timeline' },
    ...visibleSteps(steps).map((step) => {
      const state = step.state === 'done' || step.state === 'current' ? step.state : 'pending';
      const when = formatDateTime(step.at, zone, env.asOf);
      return h(
        'li',
        { class: `step step--${state}`, 'aria-current': state === 'current' ? 'step' : null },
        h('span', { class: 'step-dot' }),
        h('span', { class: 'step-label' }, text(step.label)),
        when ? h('span', { class: 'step-time' }, when) : null,
      );
    }),
  );
}

function idBlock(view: IssueView, env: RenderEnv): HTMLElement {
  const id = shortId(view.service_request_id);
  const zone = env.ctx.timeZone();
  const expected = view.status === 'open' ? formatDay(view.expected_datetime, zone, env.asOf) : null;
  const updated = formatDateTime(view.updated_datetime, zone, env.asOf);

  // The one date worth a glance: when the city expects to finish, else when it last touched this.
  let side: HTMLElement | null = null;
  if (expected) side = h('div', { class: 'id-side' }, 'Expected by', h('strong', null, expected));
  else if (updated) side = h('div', { class: 'id-side' }, 'Updated', h('strong', null, updated));

  return h(
    'div',
    { class: 'idblock' },
    h(
      'div',
      { class: 'id-main' },
      h('span', { class: 'id-label' }, 'Request'),
      h('span', { class: 'id-short' }, id.short),
      id.full ? h('span', { class: 'id-full' }, id.full) : null,
    ),
    side,
  );
}

/** Map plus details for one request. `compact` is the featured slot of a list. */
function detail(view: IssueView, env: RenderEnv, compact: boolean): HTMLElement {
  const address = text(view.address);
  const notes = text(view.status_notes) || text(view.description);
  const distance = formatDistance(view.distance_m);
  const steps = timeline(view, env);
  const reported = formatDay(view.requested_datetime, env.ctx.timeZone(), env.asOf);

  const relation = RELATION_LABEL[view.relation ?? ''];

  // Most important first: the row is one line high and an item that does not fit is dropped whole.
  const statusRow = h(
    'div',
    { class: 'status-row' },
    statusPill(view),
    // In a list the header describes the list, so the featured request carries its own badges.
    compact && view.source === 'sandbox' ? tag('Sandbox', 'sandbox') : null,
    distance ? h('span', { class: 'meta' }, `${distance} away`) : null,
    compact && relation ? h('span', { class: 'meta' }, relation) : null,
    // The full timeline already carries the report time; say it here only when that is not shown.
    reported && (!steps || compact) ? h('span', { class: 'meta' }, `Reported ${reported}`) : null,
  );

  const info = h(
    'div',
    { class: 'info' },
    h('h2', { class: 'title' }, text(view.service_name) || 'Service request'),
    h('p', { class: 'address' }, address || 'No address given'),
    statusRow,
    notes ? h('p', { class: 'notes' }, notes) : null,
    steps,
    idBlock(view, env),
  );

  if (!compact) {
    // Give up optional detail, least important first, until the column fits without scrolling.
    env.mounts.push(() => {
      for (const step of ['fit-1', 'fit-2', 'fit-3', 'fit-4']) {
        if (info.scrollHeight <= info.clientHeight + 1) break;
        info.classList.add(step);
      }
    });
  }

  return h(
    'section',
    { class: compact ? 'detail detail--compact' : 'detail' },
    mapPanel(env, { lat: view.lat, long: view.long, label: address, photoUrl: text(view.media_url) }),
    info,
  );
}

function mount(env: RenderEnv, ...children: Array<HTMLElement | null>): void {
  env.ctx.stage.replaceChildren(...children.filter((child): child is HTMLElement => child !== null));
  for (const run of env.mounts) run();
}

function renderSingle(
  env: RenderEnv,
  outcome: IssueOutcome,
  eyebrow: string,
  view: IssueView,
  extraTags: HTMLElement[] = [],
): void {
  const tags = [...extraTags];
  // "Request filed" and "Now following" already say how the resident relates to the request.
  const relation = RELATION_LABEL[view.relation ?? ''];
  if (relation && view.relation !== outcome) tags.push(tag(relation));
  if (view.source === 'sandbox') tags.push(tag('Sandbox', 'sandbox'));
  mount(env, head({ eyebrow, context: text(view.city_name), tags }), detail(view, env, false));
}

// ---------- lists ----------

interface ListCopy {
  eyebrow: string;
  headline: string;
  note?: string;
  emptyTitle: string;
}

function listCopy(result: IssueResult, total: number): ListCopy {
  const place = text(result.resolved_location?.label);
  const reports = plural(total, 'report', 'reports');
  switch (result.outcome) {
    case 'possible_duplicate':
      return {
        eyebrow: 'Already reported',
        headline: `${total} similar open ${reports} nearby`,
        note: 'Nothing new filed',
        emptyTitle: 'No similar reports nearby',
      };
    case 'requests':
      return {
        eyebrow: 'Your requests',
        headline: `${total} ${plural(total, 'request', 'requests')} you filed or follow`,
        emptyTitle: 'No requests yet',
      };
    default:
      return {
        eyebrow: 'Open reports nearby',
        headline: place ? `${total} open ${reports} near ${place}` : `${total} open ${reports} nearby`,
        emptyTitle: 'No open reports nearby',
      };
  }
}

function row(view: IssueView, selected: boolean, outcome: IssueOutcome, env: RenderEnv, onSelect: () => void): HTMLElement {
  const distance = formatDistance(view.distance_m);
  const day = formatDay(view.requested_datetime, env.ctx.timeZone(), env.asOf);
  const lead = outcome === 'requests' ? (day ?? '') : (distance ?? day ?? '');
  const state = [view.source === 'sandbox' ? 'Sandbox' : '', view.status === 'closed' ? 'Closed' : 'Open']
    .filter((part) => part !== '')
    .join(' / ');
  return h(
    'li',
    null,
    h(
      'button',
      { class: 'row', type: 'button', 'aria-pressed': String(selected), onclick: onSelect },
      h(
        'span',
        { class: 'row-main' },
        h('span', { class: 'row-title' }, text(view.service_name) || 'Service request'),
        h('span', { class: 'row-sub' }, text(view.address) || 'No address given'),
      ),
      h(
        'span',
        { class: 'row-side' },
        lead ? h('span', { class: 'row-lead' }, lead) : null,
        h('span', { class: view.status === 'closed' ? 'row-state' : 'row-state row-state--open' }, state),
      ),
    ),
  );
}

function renderList(ctx: CardContext, result: IssueResult, views: IssueView[], selected: number): void {
  const env: RenderEnv = { ctx, asOf: result.as_of, mounts: [] };
  const shown = views.slice(0, LIST_LIMIT);
  const featured = shown[selected] ?? shown[0];
  if (!featured) return;
  const copy = listCopy(result, views.length);
  const tags: HTMLElement[] = [];
  if (views.length > shown.length) tags.push(tag(`Showing ${shown.length} of ${views.length}`));
  if (copy.note) tags.push(tag(copy.note));

  mount(
    env,
    head({ eyebrow: copy.eyebrow, context: text(featured.city_name), headline: copy.headline, tags }),
    h(
      'div',
      { class: 'split' },
      detail(featured, env, true),
      h(
        'ol',
        { class: 'rows', 'aria-label': copy.headline },
        ...shown.map((view, index) =>
          row(view, view === featured, result.outcome, env, () => {
            if (view !== featured) renderList(ctx, result, views, index);
          }),
        ),
      ),
    ),
  );
}

function renderEmpty(ctx: CardContext, result: IssueResult): void {
  const env: RenderEnv = { ctx, asOf: result.as_of, mounts: [] };
  const copy = listCopy(result, 0);
  const summary = text(result.spoken_summary);
  const location: ResolvedLocation | undefined = isRecord(result.resolved_location) ? result.resolved_location : undefined;
  const radius = result.search?.radius_m;
  const block = messageBlock({
    eyebrow: copy.eyebrow,
    icon: result.outcome === 'requests' ? 'list' : 'search',
    title: copy.emptyTitle,
    body: summary,
    fine: typeof radius === 'number' ? [h('span', null, `Searched within ${formatDistance(radius)}.`)] : [],
  });

  if (location && hasCoordinates(location)) {
    mount(
      env,
      head({ eyebrow: copy.eyebrow }),
      h(
        'section',
        { class: 'detail' },
        mapPanel(env, { lat: location.lat, long: location.long, label: text(location.label) }),
        block,
      ),
    );
    return;
  }
  mount(env, head({ eyebrow: copy.eyebrow }), block);
}

// ---------- entry ----------

const SINGLE_EYEBROW: Partial<Record<IssueOutcome, string>> = {
  filed: 'Request filed',
  followed: 'Now following',
  status: 'Request status',
};

function render(payload: ToolPayload, ctx: CardContext): void {
  const data = payload.data;
  if (isErrorResult(data)) return renderError(ctx, data);
  if (!isIssueResult(data)) {
    if (payload.isError) return renderPlainError(ctx, payload.text);
    return renderMessage(ctx.stage, { eyebrow: 'CityDesk', icon: 'list', title: payload.text || 'Nothing to show yet' });
  }

  if (data.outcome === 'needs_clarification') {
    return renderClarification(ctx, {
      eyebrow: 'One question',
      clarification: data.clarification,
      fallback: text(data.spoken_summary),
    });
  }

  const views = (Array.isArray(data.requests) ? data.requests : []).filter(isIssueView);
  const first = views[0];
  const singleEyebrow = SINGLE_EYEBROW[data.outcome];

  if (singleEyebrow) {
    if (!first) {
      return renderMessage(ctx.stage, {
        eyebrow: singleEyebrow,
        icon: 'list',
        title: text(data.spoken_summary) || 'No request to show',
      });
    }
    return renderSingle({ ctx, asOf: data.as_of, mounts: [] }, data.outcome, singleEyebrow, first);
  }

  if (!first) return renderEmpty(ctx, data);
  if (views.length === 1) {
    // One result reads better as a full card than as a one-row list.
    const copy = listCopy(data, 1);
    const note = copy.note ? [tag(copy.note)] : [];
    return renderSingle({ ctx, asOf: data.as_of, mounts: [] }, data.outcome, copy.eyebrow, first, note);
  }
  renderList(ctx, data, views, 0);
}

startCard({ name: 'citydesk-issue-card', version: '0.1.0', render });
