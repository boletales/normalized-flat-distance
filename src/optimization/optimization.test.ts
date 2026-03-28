import { computeAssumedSpeeds, DEFAULT_GRADE_BINS } from "../optimization/assumed-speed";
import { buildNfdLut, computeEstimatedNp, loadFactor } from "../optimization/lut";
import { equilibriumPower } from "../physics/power";
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

describe("computeEstimatedNp", () => {
  const params = CYCLIST_PRESETS.intermediate;

  test("returns 0 for empty sections", () => {
    const np = computeEstimatedNp([], new Map<number, number>([[0, 10]]), params);
    expect(np).toBe(0);
  });

  test("matches section power for flat-only constant conditions", () => {
    const sections = [{ distance: 1000, grade: 0 }];
    const speeds = new Map<number, number>([[0, 10]]);

    const np = computeEstimatedNp(sections, speeds, params);
    const expectedPower = Math.max(0, equilibriumPower(10, 0, params));

    expect(np).toBeCloseTo(expectedPower, 10);
  });

  test("uses time-weighted fourth-power mean across sections", () => {
    const sections = [
      { distance: 1000, grade: 0 },
      { distance: 600, grade: 5 },
    ];
    const speeds = new Map<number, number>([
      [0, 10],
      [5, 6],
    ]);

    const np = computeEstimatedNp(sections, speeds, params);

    const p1 = Math.max(0, equilibriumPower(10, 0, params));
    const p2 = Math.max(0, equilibriumPower(6, 5, params));
    const t1 = 1000 / 10;
    const t2 = 600 / 6;
    const expectedNp = Math.pow((Math.pow(p1, 4) * t1 + Math.pow(p2, 4) * t2) / (t1 + t2), 1 / 4);

    expect(np).toBeCloseTo(expectedNp, 10);
  });
});
