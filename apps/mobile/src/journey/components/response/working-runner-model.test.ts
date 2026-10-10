import { describe, expect, it } from 'vitest';
import {
  RUNNER_FOODS,
  RUNNER_MAX_COLUMNS,
  RUNNER_MAX_ROWS,
  RUNNER_PIXEL,
  RUNNER_STAGE,
  interpolateKeyframes,
  runnerCycle,
  runnerFoodAt,
  workingRunnerMotion,
  type RunnerKeyframes,
} from '@mobile/journey/components/response/working-runner-model';

const WIDTHS = [320, 375, 390, 430, 768];
const FOOD_WIDTH = RUNNER_MAX_COLUMNS * RUNNER_PIXEL;
const FOOD_HEIGHT = RUNNER_MAX_ROWS * RUNNER_PIXEL;
const bodyLeft = RUNNER_STAGE.dogLeft + RUNNER_STAGE.bodyInset;
const bodyRight = RUNNER_STAGE.dogLeft + RUNNER_STAGE.dogSize - RUNNER_STAGE.bodyInset;

const increasing = (frames: RunnerKeyframes): boolean =>
  frames.input.every((value, index) => index === 0 || value > (frames.input[index - 1] ?? 0));

describe('runner foods', () => {
  it('lines up a cup, a bowl of ramen and other foods', () => {
    const ids = RUNNER_FOODS.map((food) => food.id);
    expect(ids).toContain('cup');
    expect(ids).toContain('ramen');
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(5);
  });

  it('draws every food as a full grid of known colors no larger than the jump allows', () => {
    for (const food of RUNNER_FOODS) {
      const width = food.rows[0]?.length ?? 0;
      expect(food.rows.length).toBeGreaterThan(0);
      expect(food.rows.length).toBeLessThanOrEqual(RUNNER_MAX_ROWS);
      expect(width).toBeLessThanOrEqual(RUNNER_MAX_COLUMNS);
      for (const row of food.rows) {
        expect(row).toHaveLength(width);
        for (const cell of row) {
          if (cell !== '.') expect(food.palette[cell]).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });

  it('serves every food in turn and never the same one twice in a row', () => {
    const served = Array.from({ length: RUNNER_FOODS.length * 2 }, (_, index) =>
      runnerFoodAt(index),
    );
    expect(new Set(served.slice(0, RUNNER_FOODS.length))).toEqual(new Set(RUNNER_FOODS));
    for (let index = 1; index < served.length; index++) {
      expect(served[index]).not.toBe(served[index - 1]);
    }
  });
});

describe('runner cycle', () => {
  it('clears the tallest food with room to spare whenever it passes under the dog', () => {
    for (const width of WIDTHS) {
      const cycle = runnerCycle(width);
      for (let ms = 0; ms <= cycle.durationMs; ms += 4) {
        const at = ms / cycle.durationMs;
        const x = interpolateKeyframes(cycle.obstacleX, at);
        if (x < bodyRight && x + FOOD_WIDTH > bodyLeft) {
          expect(interpolateKeyframes(cycle.dogLift, at)).toBeGreaterThanOrEqual(
            FOOD_HEIGHT + RUNNER_STAGE.clearance,
          );
        }
      }
    }
  });

  it('starts and ends each cycle standing on the ground so the loop has no seam', () => {
    for (const width of WIDTHS) {
      const cycle = runnerCycle(width);
      for (const frames of [cycle.dogLift, cycle.dogTranslateY]) {
        expect(interpolateKeyframes(frames, 0)).toBe(0);
        expect(interpolateKeyframes(frames, 1)).toBe(0);
      }
      for (const frames of [cycle.dogScaleX, cycle.dogScaleY]) {
        expect(interpolateKeyframes(frames, 0)).toBe(1);
        expect(interpolateKeyframes(frames, 1)).toBe(1);
      }
    }
  });

  it('brings each food in from beyond the right edge and lets it leave before the next', () => {
    for (const width of WIDTHS) {
      const cycle = runnerCycle(width);
      expect(interpolateKeyframes(cycle.obstacleX, 0)).toBeGreaterThanOrEqual(width);
      expect(interpolateKeyframes(cycle.obstacleX, 1)).toBeLessThanOrEqual(-FOOD_WIDTH);
    }
  });

  it('keeps the highest jump inside the stage', () => {
    const cycle = runnerCycle(390);
    const highest = Math.max(...cycle.dogLift.output);
    expect(highest + RUNNER_STAGE.dogBottom + RUNNER_STAGE.dogSize).toBeLessThanOrEqual(
      RUNNER_STAGE.height,
    );
  });

  it('crouches before take-off and squashes on landing like the entry jump', () => {
    const cycle = runnerCycle(390);
    expect(Math.min(...cycle.dogScaleY.output)).toBeCloseTo(0.84);
    expect(cycle.dogScaleY.output).toContain(0.86);
    expect(Math.max(...cycle.dogScaleX.output)).toBeCloseTo(1.1);
  });

  it('keeps the feet on the ground line while squashing', () => {
    const cycle = runnerCycle(390);
    cycle.dogScaleY.input.forEach((input, index) => {
      const lift = interpolateKeyframes(cycle.dogLift, input);
      const scaleY = cycle.dogScaleY.output[index] ?? 1;
      expect(interpolateKeyframes(cycle.dogTranslateY, input)).toBeCloseTo(
        -lift + (RUNNER_STAGE.dogSize * (1 - scaleY)) / 2,
      );
    });
  });

  it('gives every animated value one strictly increasing timeline', () => {
    const cycle = runnerCycle(390);
    const frames = [
      cycle.obstacleX,
      cycle.dogLift,
      cycle.dogTranslateY,
      cycle.dogScaleX,
      cycle.dogScaleY,
    ];
    for (const frame of frames) {
      expect(frame.output).toHaveLength(frame.input.length);
      expect(frame.input[0]).toBe(0);
      expect(frame.input.at(-1)).toBe(1);
      expect(increasing(frame)).toBe(true);
    }
  });
});

describe('runner motion', () => {
  it('runs only when reduced motion is known to be off', () => {
    expect(workingRunnerMotion(false)).toBe('run');
    expect(workingRunnerMotion(true)).toBe('still');
    expect(workingRunnerMotion(null)).toBe('still');
  });
});
