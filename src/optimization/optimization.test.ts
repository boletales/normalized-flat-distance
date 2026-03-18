import { computeAssumedSpeeds } from "../optimization/assumed-speed";
import { buildNfdLut, loadFactor } from "../optimization/lut";
import { STANDARD_COURSE_DISTRIBUTION } from "../optimization/standard-course";
import { CYCLIST_PRESETS } from "../presets";
import { equilibriumPower } from "../physics/power";

describe("STANDARD_COURSE_DISTRIBUTION", () => {
  test("frequencies sum to approximately 1", () => {
    const total = STANDARD_COURSE_DISTRIBUTION.reduce(
      (s, x) => s + x.frequency,
      0,
    );
    expect(total).toBeCloseTo(1, 8);
  });

  test("contains 0% grade", () => {
    const hasZero = STANDARD_COURSE_DISTRIBUTION.some((x) => x.grade === 0);
    expect(hasZero).toBe(true);
  });

  test("all frequencies are positive", () => {
    for (const { frequency } of STANDARD_COURSE_DISTRIBUTION) {
      expect(frequency).toBeGreaterThan(0);
    }
  });
});

describe("computeAssumedSpeeds", () => {
  const params = CYCLIST_PRESETS.intermediate;

  test("returns a speed for each grade in the distribution", () => {
    const speeds = computeAssumedSpeeds(params, STANDARD_COURSE_DISTRIBUTION);
    for (const { grade } of STANDARD_COURSE_DISTRIBUTION) {
      expect(speeds.has(grade)).toBe(true);
    }
  });

  test("all speeds are within [vMin, vMax]", () => {
    const speeds = computeAssumedSpeeds(params, STANDARD_COURSE_DISTRIBUTION);
    for (const v of speeds.values()) {
      expect(v).toBeGreaterThanOrEqual(params.vMin);
      expect(v).toBeLessThanOrEqual(params.vMax);
    }
  });

  test("speed decreases with increasing grade", () => {
    const speeds = computeAssumedSpeeds(params, STANDARD_COURSE_DISTRIBUTION);
    const v0 = speeds.get(0) as number;
    const v5 = speeds.get(5) as number;
    const vMinus5 = speeds.get(-5) as number;
    expect(v5).toBeLessThan(v0);
    expect(vMinus5).toBeGreaterThan(v0);
  });

  test("NP constraint is approximately satisfied", () => {
    // Σ f(n)·[P_eff(v(n),n)^4 - P_c^4] / v(n) ≈ 0
    // P_eff = max(0, P_eq): cyclist cannot produce negative power (coasts on downhills)
    const speeds = computeAssumedSpeeds(params, STANDARD_COURSE_DISTRIBUTION);
    const cruisePower = params.ftp * params.cruisePowerFraction;
    const cruisePower4 = Math.pow(cruisePower, 4);

    let residual = 0;
    let totalWeight = 0;
    for (const { grade, frequency } of STANDARD_COURSE_DISTRIBUTION) {
      const v = speeds.get(grade) as number;
      const pEff = Math.max(0, equilibriumPower(v, grade, params));
      residual += frequency * (Math.pow(pEff, 4) - cruisePower4) / v;
      totalWeight += frequency / v;
    }

    // The relative residual should be small (< 1% of the constraint magnitude)
    expect(Math.abs(residual / (cruisePower4 * totalWeight))).toBeLessThan(0.01);
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
