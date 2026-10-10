import { JUMP_SQUASH } from '@mobile/ui/presentation/jump-arc';

export const RUNNER_PIXEL = 4;
export const RUNNER_MAX_COLUMNS = 10;
export const RUNNER_MAX_ROWS = 10;

/** Stage geometry in points; `bodyInset` trims the transparent sides of the dog sprite. */
export const RUNNER_STAGE = {
  height: 176,
  groundBottom: 34,
  dogLeft: 30,
  dogSize: 64,
  dogBottom: 30,
  bodyInset: 12,
  clearance: 4,
  speed: 200,
  apex: 76,
} as const;

export type RunnerFood = {
  readonly id: 'cup' | 'ramen' | 'onigiri' | 'coffee' | 'dango' | 'burger';
  /** Pixel rows; `.` is empty and every other letter is a palette key. */
  readonly rows: readonly string[];
  readonly palette: Readonly<Record<string, string>>;
};

const CUP: RunnerFood = {
  id: 'cup',
  rows: [
    '......r.',
    '.....r..',
    'wwwwwrww',
    'wjjjjjjw',
    'wjjjjjjw',
    '.wjjjjw.',
    '.wjjjjw.',
    '.wwwwww.',
  ],
  palette: { w: '#c9d1d3', j: '#e9a23b', r: '#d9534f' },
};

export const RUNNER_FOODS: readonly RunnerFood[] = [
  CUP,
  {
    id: 'ramen',
    rows: [
      '..s...s...',
      '...s...s..',
      '.gnyynpng.',
      'rrrrrrrrrr',
      '.rwrrwrrw.',
      '..rrrrrr..',
      '...dddd...',
    ],
    palette: {
      s: '#6b6a66',
      g: '#7fa35a',
      n: '#e8c66a',
      y: '#f2b134',
      p: '#f2a7b8',
      r: '#c0392b',
      w: '#e7e2d6',
      d: '#8e2a1f',
    },
  },
  {
    id: 'onigiri',
    rows: [
      '....ww....',
      '...wwww...',
      '..wwwwww..',
      '.wwwwwwww.',
      '.wwkkkkww.',
      'wwwkkkkwww',
      'wwwkkkkwww',
    ],
    palette: { w: '#f2efe6', k: '#2f4a3a' },
  },
  {
    id: 'coffee',
    rows: [
      '.s..s....',
      '..s..s...',
      '.s..s....',
      'ccccccc..',
      'cbbbbbccc',
      'cbbbbbc.c',
      'cbbbbbccc',
      'cbbbbbc..',
      '.ccccc...',
    ],
    palette: { s: '#6b6a66', c: '#e7e2d6', b: '#6b4228' },
  },
  {
    id: 'dango',
    rows: [
      '...s...',
      '..ppp..',
      '.ppppp.',
      '..ppp..',
      '..www..',
      '.wwwww.',
      '..www..',
      '..ggg..',
      '.ggggg.',
      '..ggg..',
    ],
    palette: { s: '#c8a165', p: '#f2a7b8', w: '#f2efe6', g: '#9cc47a' },
  },
  {
    id: 'burger',
    rows: [
      '..bbbbbb..',
      '.bbsbbbsb.',
      '.bbbbbbbb.',
      'gggggggggg',
      '.mmmmmmmm.',
      '.cccccccc.',
      '.bbbbbbbb.',
    ],
    palette: { b: '#d9963f', s: '#f2e3c0', g: '#7fa35a', m: '#6b3a24', c: '#f2c14e' },
  },
];

export const runnerFoodAt = (index: number): RunnerFood => {
  const count = RUNNER_FOODS.length;
  return RUNNER_FOODS[((index % count) + count) % count] ?? CUP;
};

export type RunnerKeyframes = {
  readonly input: readonly number[];
  readonly output: readonly number[];
};

export type RunnerCycle = {
  readonly durationMs: number;
  /** Left edge of the food on the stage. */
  readonly obstacleX: RunnerKeyframes;
  /** Height of the paws above the ground line. */
  readonly dogLift: RunnerKeyframes;
  /** Lift plus the shift that keeps the paws planted while the sprite squashes. */
  readonly dogTranslateY: RunnerKeyframes;
  readonly dogScaleX: RunnerKeyframes;
  readonly dogScaleY: RunnerKeyframes;
};

const CROUCH_MS = 140;
const LAND_MS = 80;
const SETTLE_MS = 240;
const REST_MS = 300;
const AIR_STEPS = 12;
// Extra lead on each side of the overlap; linear steps between samples dip below the parabola.
const SAFETY_MS = 40;
const STRETCH_UNTIL = 0.25;

type DogFrame = {
  readonly ms: number;
  readonly lift: number;
  readonly x: number;
  readonly y: number;
};

/**
 * One food crossing the stage at a steady speed while the dog clears it. The jump is timed from
 * the moment the widest food reaches the dog's body until it has passed, so every food clears.
 */
export const runnerCycle = (stageWidth: number): RunnerCycle => {
  const { speed, dogLeft, dogSize, bodyInset, apex, clearance } = RUNNER_STAGE;
  const foodWidth = RUNNER_MAX_COLUMNS * RUNNER_PIXEL;
  const foodHeight = RUNNER_MAX_ROWS * RUNNER_PIXEL;
  const bodyLeft = dogLeft + bodyInset;
  const bodyRight = dogLeft + dogSize - bodyInset;
  const startX = Math.max(stageWidth, bodyRight + foodWidth);
  const endX = -foodWidth;
  const msFor = (distance: number): number => (distance / speed) * 1000;

  const travelMs = msFor(startX - endX);
  const overlapStart = msFor(startX - bodyRight);
  const overlapMs = msFor(bodyRight - bodyLeft + foodWidth);
  const needed = (foodHeight + clearance) / apex;
  const edge = (1 - Math.sqrt(1 - needed)) / 2;
  const margin = (edge * overlapMs) / (1 - 2 * edge) + SAFETY_MS;
  const takeoff = overlapStart - margin;
  const airMs = overlapMs + margin * 2;
  const landing = takeoff + airMs;
  const settled = landing + LAND_MS + SETTLE_MS;
  const durationMs = Math.max(travelMs, settled) + REST_MS;

  const { crouch, stretch, land } = JUMP_SQUASH;
  const frames: DogFrame[] = [
    { ms: 0, lift: 0, x: 1, y: 1 },
    { ms: takeoff - CROUCH_MS, lift: 0, x: 1, y: 1 },
    { ms: takeoff, lift: 0, x: crouch.x, y: crouch.y },
    ...Array.from({ length: AIR_STEPS }, (_, index) => {
      const progress = (index + 1) / AIR_STEPS;
      const pull = Math.max(0, 1 - progress / STRETCH_UNTIL);
      return {
        ms: takeoff + airMs * progress,
        lift: index + 1 === AIR_STEPS ? 0 : apex * 4 * progress * (1 - progress),
        x: 1 + (stretch.x - 1) * pull,
        y: 1 + (stretch.y - 1) * pull,
      };
    }),
    { ms: landing + LAND_MS, lift: 0, x: land.x, y: land.y },
    { ms: landing + LAND_MS + SETTLE_MS * 0.6, lift: 0, x: 0.97, y: 1.03 },
    { ms: settled, lift: 0, x: 1, y: 1 },
    { ms: durationMs, lift: 0, x: 1, y: 1 },
  ];
  const input = frames.map((frame) => frame.ms / durationMs);
  const track = (pick: (frame: DogFrame) => number): RunnerKeyframes => ({
    input,
    output: frames.map(pick),
  });
  return {
    durationMs,
    obstacleX: { input: [0, travelMs / durationMs, 1], output: [startX, endX, endX] },
    dogLift: track((frame) => frame.lift),
    dogTranslateY: track((frame) => -frame.lift + (dogSize * (1 - frame.y)) / 2),
    dogScaleX: track((frame) => frame.x),
    dogScaleY: track((frame) => frame.y),
  };
};

/** Linear like Animated.interpolate with clamped ends. */
export const interpolateKeyframes = (frames: RunnerKeyframes, at: number): number => {
  const { input, output } = frames;
  const last = input.length - 1;
  if (at <= (input[0] ?? 0)) return output[0] ?? 0;
  if (at >= (input[last] ?? 1)) return output[last] ?? 0;
  const next = input.findIndex((value) => value >= at);
  const from = input[next - 1] ?? 0;
  const to = input[next] ?? 1;
  const start = output[next - 1] ?? 0;
  const end = output[next] ?? 0;
  return start + ((end - start) * (at - from)) / (to - from);
};

export type WorkingRunnerMotion = 'run' | 'still';

/** Stays still until the reduced-motion setting is known, and whenever it is on. */
export const workingRunnerMotion = (reduceMotion: boolean | null): WorkingRunnerMotion =>
  reduceMotion === false ? 'run' : 'still';
