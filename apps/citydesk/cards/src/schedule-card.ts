/**
 * Schedule card (ui://citydesk/schedule-card.html).
 *
 * Renders the structuredContent of collection_schedule: a ScheduleResult, or an ErrorResult when
 * the call failed. The next trash day and the next recycling day are the two big facts; under them
 * is a 14-day strip with every pickup marked.
 */
import type { CollectionSchedule, ScheduleResult } from '../../src/contract.ts';
import { buildStrip, scheduleToday, streamFact, type StreamFact, type StripDay } from './schedule-model.ts';
import { h, icon, isRecord, type IconName } from './shared/dom.ts';
import { formatDay, safeTimeZone } from './shared/format.ts';
import { startCard, type CardContext, type ToolPayload } from './shared/host.ts';
import {
  head,
  isErrorResult,
  renderClarification,
  renderError,
  renderMessage,
  renderPlainError,
  tag,
} from './shared/views.ts';

function isScheduleResult(value: unknown): value is ScheduleResult {
  return isRecord(value) && (value.outcome === 'schedule' || value.outcome === 'needs_clarification');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function factTile(kind: 'trash' | 'recycling', label: string, iconName: IconName, fact: StreamFact): HTMLElement {
  const classes = ['fact', `fact--${kind}`];
  if (!fact.listed) classes.push('fact--none');
  if (fact.today) classes.push('fact--today');
  return h(
    'article',
    { class: classes.join(' ') },
    h('div', { class: 'fact-kind' }, icon(iconName), h('span', null, label)),
    h('div', { class: 'fact-big' }, fact.big),
    h('div', { class: 'fact-sub' }, fact.sub),
    fact.rule ? h('div', { class: 'fact-rule' }, fact.rule) : null,
  );
}

function stripDay(day: StripDay): HTMLElement {
  const classes = ['day'];
  if (day.today) classes.push('day--today');
  if (day.trash || day.recycling) classes.push('day--pickup');
  const what = [day.trash ? 'trash' : '', day.recycling ? 'recycling' : ''].filter((part) => part !== '');
  return h(
    'li',
    {
      class: classes.join(' '),
      'aria-label': `${day.weekday} ${day.date}: ${what.length > 0 ? what.join(' and ') : 'no pickup'}`,
    },
    h('span', { class: 'day-name' }, day.today ? 'Today' : day.weekday),
    h('span', { class: 'day-date' }, day.date),
    h(
      'span',
      { class: 'day-marks' },
      day.trash ? h('span', { class: 'mark mark--trash' }) : null,
      day.recycling ? h('span', { class: 'mark mark--recycling' }) : null,
    ),
  );
}

function renderSchedule(ctx: CardContext, result: ScheduleResult, schedule: CollectionSchedule): void {
  const today = scheduleToday(schedule, result.as_of);
  const trash = streamFact(schedule.trash, today, 'trash');
  const recycling = streamFact(schedule.recycling, today, 'recycling');
  const strip = buildStrip(schedule, today);
  const zone = safeTimeZone(schedule.time_zone);
  const asOf = formatDay(result.as_of, zone, result.as_of);
  const place = [text(schedule.neighborhood), text(schedule.zip_code)].filter((part) => part !== '').join(' ');
  const source = text(schedule.dataset?.name);
  const updated = formatDay(schedule.dataset?.last_modified, zone, result.as_of);

  const footnote = source
    ? h('p', { class: 'source' }, updated ? `Source: ${source}, updated ${updated}` : `Source: ${source}`)
    : null;

  ctx.stage.replaceChildren(
    head({
      eyebrow: 'Collection schedule',
      context: place,
      tags: asOf ? [tag(`As of ${asOf}`)] : [],
    }),
    h('h1', { class: 'place' }, text(schedule.address) || 'Your address'),
    h(
      'div',
      { class: 'facts' },
      factTile('trash', 'Trash', 'trash', trash),
      factTile('recycling', 'Recycling', 'recycle', recycling),
    ),
    h(
      'section',
      { class: 'strip' },
      h(
        'div',
        { class: 'strip-head' },
        h('span', { class: 'strip-title' }, 'Next 14 days'),
        h(
          'span',
          { class: 'legend' },
          h('span', { class: 'legend-item' }, h('span', { class: 'mark mark--trash' }), 'Trash'),
          h('span', { class: 'legend-item' }, h('span', { class: 'mark mark--recycling' }), 'Recycling'),
        ),
      ),
      h('ol', { class: 'days' }, ...strip.map(stripDay)),
    ),
    ...(footnote ? [footnote] : []),
  );
}

function render(payload: ToolPayload, ctx: CardContext): void {
  const data = payload.data;
  if (isErrorResult(data)) return renderError(ctx, data);
  if (!isScheduleResult(data)) {
    if (payload.isError) return renderPlainError(ctx, payload.text);
    return renderMessage(ctx.stage, {
      eyebrow: 'Collection schedule',
      icon: 'trash',
      title: payload.text || 'Nothing to show yet',
    });
  }

  if (data.outcome === 'needs_clarification') {
    return renderClarification(ctx, {
      eyebrow: 'Collection schedule',
      context: 'One question',
      clarification: data.clarification,
      fallback: text(data.spoken_summary),
    });
  }

  if (!isRecord(data.schedule)) {
    return renderMessage(ctx.stage, {
      eyebrow: 'Collection schedule',
      icon: 'trash',
      title: text(data.spoken_summary) || 'No schedule to show',
    });
  }
  renderSchedule(ctx, data, data.schedule);
}

startCard({ name: 'citydesk-schedule-card', version: '0.1.0', render });
