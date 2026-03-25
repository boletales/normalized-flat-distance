import { computeAssumedSpeeds, DEFAULT_GRADE_BINS } from "../optimization/assumed-speed";
import { buildNfdLut, loadFactor } from "../optimization/lut";
import { CYCLIST_PRESETS } from "../presets";
import { G } from "../types";

function aerodynamicCoeff(params: (typeof CYCLIST_PRESETS)["intermediate"]): number {
  return (0.5 * params.rho * params.CdA) / params.eta;
}

function linearCoeff(grade: number, params: (typeof CYCLIST_PRESETS)["intermediate"]): number {
  const gradeRatio = grade / 100;
  const hyp = Math.sqrt(1 + gradeRatio * gradeRatio);
  const sinTheta = gradeRatio / hyp;
  const cosTheta = 1 / hyp;
  return (params.mass * G * (sinTheta + params.Crr * cosTheta)) / params.eta;
}

function optimizeCost(v: number, a: number, b: number): number {
  const v2 = v * v;
  return (11 * a * v2 + 3 * b) * Math.pow(a * v2 + b, 3) * Math.pow(v, 4);
}

describe("computeAssumedSpeeds", () => {
  const params = CYCLIST_PRESETS.intermediate;

  test("returns a speed for each default grade bin", () => {
    const speeds = computeAssumedSpeeds(params, DEFAULT_GRADE_BINS);
    for (const grade of DEFAULT_GRADE_BINS) {
      expect(speeds.has(grade)).toBe(true);
    }
  });

  test("all speeds are >= vMin", () => {
    const speeds = computeAssumedSpeeds(params, DEFAULT_GRADE_BINS);
    for (const v of speeds.values()) {
      expect(v).toBeGreaterThanOrEqual(params.vMin);
    }
  });

  test("speed decreases with increasing grade", () => {
    const speeds = computeAssumedSpeeds(params, DEFAULT_GRADE_BINS);
    const v0 = speeds.get(0) as number;
    const v5 = speeds.get(5) as number;
    const vMinus5 = speeds.get(-5) as number;
    expect(v5).toBeLessThan(v0);
    expect(vMinus5).toBeGreaterThan(v0);
  });

  test("unclamped grades satisfy the optimal-cost equation", () => {
    const speeds = computeAssumedSpeeds(params, DEFAULT_GRADE_BINS);
    const a = aerodynamicCoeff(params);
    const b0 = linearCoeff(0, params);
    const v0 = speeds.get(0) as number;
    const c = optimizeCost(v0, a, b0);

    for (const grade of DEFAULT_GRADE_BINS) {
      const v = speeds.get(grade) as number;
      if (v > params.vMin + 1e-6) {
        const b = linearCoeff(grade, params);
        const lhs = optimizeCost(v, a, b);
        const rel = Math.abs(lhs - c) / c;
        expect(rel).toBeLessThan(1e-3);
      }
    }
  });
});

describe("buildNfdLut", () => {
  const params = CYCLIST_PRESETS.intermediate;

  test("coefficient at 0% is exactly 1", () => {
    const lut = buildNfdLut(params);
    expect(lut.get(0)).toBeCloseTo(1, 10);
  });

  test("coefficient increases with grade (uphill harder)", () => {
    const lut = buildNfdLut(params);
    const c0 = lut.get(0) as number;
    const c5 = lut.get(5) as number;
    const cMinus5 = lut.get(-5) as number;
    expect(c5).toBeGreaterThan(c0);
    expect(cMinus5).toBeLessThan(c0);
  });

  test("all coefficients are non-negative", () => {
    const lut = buildNfdLut(params);
    for (const c of lut.values()) {
      // Steep coasting downhills contribute 0; all other sections contribute > 0
      expect(c).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("loadFactor", () => {
  const params = CYCLIST_PRESETS.intermediate;

  test("load factor is positive for positive speed", () => {
    const s = loadFactor(7, 0, params);
    expect(s).toBeGreaterThan(0);
  });

  test("load factor is higher uphill than on flat at same speed", () => {
    const sFlat = loadFactor(7, 0, params);
    const sUphill = loadFactor(7, 5, params);
    expect(sUphill).toBeGreaterThan(sFlat);
  });
});
