/**
 * Tiny DOM helpers. Tool data only ever reaches the page through text nodes and setAttribute, never
 * through innerHTML, so nothing a city (or a resident's description) sends can inject markup.
 */

export type Child = Node | string | number | false | null | undefined;
export type Attrs = Record<string, string | number | boolean | null | undefined | ((event: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (typeof value === 'function') el.addEventListener(key.replace(/^on/, ''), value);
      else if (key === 'class') el.className = String(value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Static 24x24 stroke icons. These strings are constants in this file, never tool data. */
const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 8v5"/><path d="M12 16.5v.01"/><circle cx="12" cy="12" r="9"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  list: '<path d="M8 7h11M8 12h11M8 17h11"/><path d="M4.5 7v.01M4.5 12v.01M4.5 17v.01"/>',
  trash:
    '<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l.9 12.5h9.2L17.5 7"/><path d="M10 11v5M14 11v5"/>',
  recycle:
    '<path d="M7.5 9.5L10.2 5a2 2 0 0 1 3.5 0l1.5 2.6"/><path d="M12.6 7.4l2.9.5.6-2.9"/>' +
    '<path d="M18.3 12.5l1.6 2.8a2 2 0 0 1-1.7 3H15"/><path d="M17 16.2l-2.1 2.1 2.1 2.1"/>' +
    '<path d="M9.5 18.3H5.8a2 2 0 0 1-1.7-3l1.6-2.8"/><path d="M3.4 12.6l2.6-1.2 1.3 2.6"/>',
  photo:
    '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><circle cx="9" cy="10.5" r="1.5"/><path d="M4 17l5-4.5 3.5 3 3-2.5L20 17"/>',
  shrink: '<path d="M6 6l12 12M18 6L6 18"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, className = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className ? `icon ${className}` : 'icon');
  svg.innerHTML = ICONS[name];
  return svg;
}

/** Any static SVG markup, parsed in the SVG namespace. Callers pass constants only. */
export function svg(viewBox: string, className: string, markup: string, preserve?: string): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('class', className);
  if (preserve) el.setAttribute('preserveAspectRatio', preserve);
  el.innerHTML = markup;
  return el;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
