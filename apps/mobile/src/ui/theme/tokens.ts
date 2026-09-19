export const colors = {
  overlayScrim: 'rgba(0, 0, 0, 0.46)',
  background: '#0c0c0d',
  surface: '#171719',
  surfaceRaised: '#1c1c1e',
  surfaceMuted: '#141416',
  border: '#2a2a2e',
  borderSoft: 'rgba(255, 255, 255, 0.07)',
  text: '#ecebe6',
  muted: '#9a9993',
  faint: '#6b6a66',
  lime: '#b7c97a',
  cream: '#e7e2d6',
  ink: '#161616',
} as const;

export const spacing = {
  page: 14,
  canvas: 18,
  section: 12,
  compact: 8,
  touch: 48,
} as const;

export const radii = {
  canvas: 24,
  card: 24,
  field: 22,
  button: 16,
  small: 14,
  pill: 999,
} as const;

export const typography = {
  display: 38,
  title: 24,
  body: 14,
  label: 12,
  button: 14,
} as const;

export const scaleForDynamicType = (base: number, fontScale: number): number =>
  Math.round(base * Math.max(1, fontScale));
