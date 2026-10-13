/**
 * Style variables handed to cards through `hostContext.styles.variables`, so a card can match the
 * Echo Show frame. The key set is the one in ext-apps `examples/basic-host/src/host-styles.ts`
 * (v2.0.3); the values are this client's own dark palette (see `src/styles.css`), with a single
 * accent colour.
 */

import type { McpUiStyles } from '@modelcontextprotocol/ext-apps/app-bridge';

const ACCENT = '#5ec8e0';
const SANS = "'Amazon Ember', 'Helvetica Neue', Helvetica, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO = "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace";

export const HOST_STYLE_VARIABLES: McpUiStyles = {
  '--color-background-primary': '#0d1217',
  '--color-background-secondary': '#141b22',
  '--color-background-tertiary': '#1c252e',
  '--color-background-inverse': '#eef2f5',
  '--color-background-ghost': 'rgba(13, 18, 23, 0)',
  '--color-background-info': '#12303a',
  '--color-background-danger': '#3a1a1c',
  '--color-background-success': '#15301f',
  '--color-background-warning': '#372b12',
  '--color-background-disabled': 'rgba(28, 37, 46, 0.5)',

  '--color-text-primary': '#eef2f5',
  '--color-text-secondary': '#a3afba',
  '--color-text-tertiary': '#6f7c88',
  '--color-text-inverse': '#0d1217',
  '--color-text-ghost': 'rgba(163, 175, 186, 0.5)',
  '--color-text-info': ACCENT,
  '--color-text-danger': '#f0888a',
  '--color-text-success': '#7fcf9a',
  '--color-text-warning': '#e3b566',
  '--color-text-disabled': 'rgba(238, 242, 245, 0.4)',

  '--color-border-primary': '#26313b',
  '--color-border-secondary': '#34414d',
  '--color-border-tertiary': '#1c252e',
  '--color-border-inverse': 'rgba(255, 255, 255, 0.3)',
  '--color-border-ghost': 'rgba(38, 49, 59, 0)',
  '--color-border-info': '#2b6b7a',
  '--color-border-danger': '#7a3134',
  '--color-border-success': '#2f6b45',
  '--color-border-warning': '#7a5f26',
  '--color-border-disabled': 'rgba(38, 49, 59, 0.5)',

  '--color-ring-primary': ACCENT,
  '--color-ring-secondary': '#a3afba',
  '--color-ring-inverse': '#0d1217',
  '--color-ring-info': ACCENT,
  '--color-ring-danger': '#f0888a',
  '--color-ring-success': '#7fcf9a',
  '--color-ring-warning': '#e3b566',

  '--font-sans': SANS,
  '--font-mono': MONO,

  '--font-weight-normal': '400',
  '--font-weight-medium': '500',
  '--font-weight-semibold': '600',
  '--font-weight-bold': '700',

  // An Echo Show is read from across a room, so the scale starts larger than a desktop page.
  '--font-text-xs-size': '0.875rem',
  '--font-text-sm-size': '1rem',
  '--font-text-md-size': '1.125rem',
  '--font-text-lg-size': '1.25rem',

  '--font-heading-xs-size': '0.875rem',
  '--font-heading-sm-size': '1rem',
  '--font-heading-md-size': '1.25rem',
  '--font-heading-lg-size': '1.5rem',
  '--font-heading-xl-size': '1.875rem',
  '--font-heading-2xl-size': '2.25rem',
  '--font-heading-3xl-size': '3rem',

  '--font-text-xs-line-height': '1.4',
  '--font-text-sm-line-height': '1.4',
  '--font-text-md-line-height': '1.5',
  '--font-text-lg-line-height': '1.5',

  '--font-heading-xs-line-height': '1.4',
  '--font-heading-sm-line-height': '1.4',
  '--font-heading-md-line-height': '1.35',
  '--font-heading-lg-line-height': '1.3',
  '--font-heading-xl-line-height': '1.25',
  '--font-heading-2xl-line-height': '1.2',
  '--font-heading-3xl-line-height': '1.1',

  '--border-radius-xs': '2px',
  '--border-radius-sm': '4px',
  '--border-radius-md': '8px',
  '--border-radius-lg': '12px',
  '--border-radius-xl': '20px',
  '--border-radius-full': '9999px',

  '--border-width-regular': '1px',

  '--shadow-hairline': '0 0 0 1px rgba(255, 255, 255, 0.06)',
  '--shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.4)',
  '--shadow-md': '0 4px 12px rgba(0, 0, 0, 0.45)',
  '--shadow-lg': '0 12px 32px rgba(0, 0, 0, 0.5)',
};
