// ═══════════════════════════════════════════════════
// Theme tokens as JS values — for places that cannot read CSS variables:
// Leaflet path options (SVG presentation attributes), <canvas> drawing,
// chart fills computed in JS. Keep in sync with src/index.css.
// divIcon HTML should use var(--map-…) directly instead.
// ═══════════════════════════════════════════════════

import { useTheme, type ResolvedTheme } from './theme';

export interface ThemeTokens {
  canvas: string;
  surface: string;
  surface2: string;
  line: string;
  lineStrong: string;
  fg: string;
  fgMuted: string;
  fgSubtle: string;
  primary: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  sev: { critical: string; high: string; medium: string; low: string };
  map: {
    bg: string;
    camOnline: string;
    camOffline: string;
    camMaint: string;
    camIdle: string;
    markerHalo: string;
    selected: string;
    labelBg: string;
    labelFg: string;
    labelBorder: string;
  };
  heat: [string, string, string, string, string];
  series: [string, string, string, string, string, string];
}

export const TOKENS: Record<ResolvedTheme, ThemeTokens> = {
  light: {
    canvas: '#F4F6F9',
    surface: '#FFFFFF',
    surface2: '#F1F4F8',
    line: '#D9E0E8',
    lineStrong: '#C2CCD7',
    fg: '#0F1722',
    fgMuted: '#4B5767',
    fgSubtle: '#667385',
    primary: '#1F5FD1',
    success: '#1A7F37',
    warning: '#9A6700',
    danger: '#CF222E',
    info: '#0E6E8C',
    sev: { critical: '#CF222E', high: '#BC4C00', medium: '#9A6700', low: '#57606A' },
    map: {
      bg: '#E9ECEF',
      camOnline: '#1A7F37',
      camOffline: '#CF222E',
      camMaint: '#9A6700',
      camIdle: '#8A96A3',
      markerHalo: '#FFFFFF',
      selected: '#1F5FD1',
      labelBg: 'rgba(255,255,255,.94)',
      labelFg: '#0F1722',
      labelBorder: '#C2CCD7',
    },
    heat: ['#FFF3C4', '#FDD37A', '#F59E42', '#E0592A', '#B42318'],
    series: ['#1F6FEB', '#0F8A7E', '#C4610F', '#8250DF', '#BF3989', '#6E7D00'],
  },
  dark: {
    canvas: '#0B0F14',
    surface: '#111821',
    surface2: '#17202B',
    line: '#243140',
    lineStrong: '#334456',
    fg: '#E6EDF3',
    fgMuted: '#9AA8B6',
    fgSubtle: '#7A8899',
    primary: '#58A6FF',
    success: '#3FB950',
    warning: '#D29922',
    danger: '#F85149',
    info: '#39C5CF',
    sev: { critical: '#F85149', high: '#F0883E', medium: '#D29922', low: '#8FA3B8' },
    map: {
      bg: '#1B1F24',
      camOnline: '#3FB950',
      camOffline: '#F85149',
      camMaint: '#D29922',
      camIdle: '#5B6B7C',
      markerHalo: '#0B0F14',
      selected: '#58A6FF',
      labelBg: 'rgba(17,24,33,.92)',
      labelFg: '#E6EDF3',
      labelBorder: '#334456',
    },
    heat: ['#3A3320', '#7A5A12', '#C2701B', '#E5532D', '#FF3B3B'],
    series: ['#58A6FF', '#3FC1B0', '#F0A04B', '#B392F0', '#F778BA', '#C9D05C'],
  },
};

/** Video / detection overlay colours — constant in both themes (video is always dark). */
export const VIDEO_OVERLAY = {
  frameBg: '#05070A',
  box: '#22D3EE',
  boxGlow: 'rgba(34,211,238,.6)',
  labelBg: 'rgba(11,15,20,.8)',
  labelFg: '#FFFFFF',
  watchlistBox: '#F85149',
  liveDot: '#F85149',
} as const;

/** HSRP number plate colours — a physical object, constant in both themes. */
export const PLATE_COLORS = {
  private: { bg: '#FFFFFF', fg: '#111111' },
  commercial: { bg: '#F5C400', fg: '#111111' },
  ev: { bg: '#0B7A3B', fg: '#FFFFFF' },
  border: '#1F2328',
  inset: 'rgba(0,0,0,.15)',
  strip: '#1D4ED8',
  stripFg: '#FFFFFF',
} as const;

/** Token values for the current theme; re-renders on theme change. */
export function useThemeTokens(): ThemeTokens {
  return TOKENS[useTheme().resolved];
}
