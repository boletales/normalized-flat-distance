import { computeNfd, computeNfdKm, interpolateCoefficient } from "../nfd/calculator";
import { buildNfdLut } from "../optimization/lut";
import { CYCLIST_PRESETS } from "../presets";

describe("interpolateCoefficient", () => {
  // Simple 3-point LUT for testing: -5% → 0.5, 0% → 1.0, 5% → 2.0
  const lut = new Map([
    [-5, 0.5],
    [0, 1.0],
    [5, 2.0],
  ]);

  test("exact match returns stored value", () => {
    expect(interpolateCoefficient(0, lut)).toBe(1.0);
    expect(interpolateCoefficient(-5, lut)).toBe(0.5);
    expect(interpolateCoefficient(5, lut)).toBe(2.0);
  });

  test("interpolates between bins", () => {
    // Midpoint between 0 and 5 should be 1.5
    expect(interpolateCoefficient(2.5, lut)).toBeCloseTo(1.5, 10);
  });

  test("extrapolates by pinning to nearest edge", () => {
    expect(interpolateCoefficient(-10, lut)).toBe(0.5);
    expect(interpolateCoefficient(10, lut)).toBe(2.0);
  });

  test("uses arithmetic-grid fast path for default LUT bins", () => {
    const fullLut = buildNfdLut(CYCLIST_PRESETS.intermediate);
    const c12 = interpolateCoefficient(1.2, fullLut);
    const c13 = interpolateCoefficient(1.3, fullLut);
    const c125 = interpolateCoefficient(1.25, fullLut);

    expect(c125).toBeGreaterThanOrEqual(Math.min(c12, c13));
    expect(c125).toBeLessThanOrEqual(Math.max(c12, c13));
  });

  test("keeps fallback behavior for non-arithmetic key spacing", () => {
    const sparse = new Map<number, number>([
      [-6, 0.4],
      [-2, 0.8],
      [5, 2.2],
    ]);
    const c = interpolateCoefficient(1.5, sparse);
    expect(c).toBeCloseTo(1.5, 10);
  });
});

describe("computeNfd", () => {
  const params = CYCLIST_PRESETS.intermediate;
  const lut = buildNfdLut(params);

  test("flat course: NFD equals actual distance", () => {
    const sections = [{ distance: 10000, grade: 0 }];
    // coefficient at 0% is exactly 1
    expect(computeNfd(sections, lut)).toBeCloseTo(10000, 1);
  });

  test("uphill course: NFD > actual distance", () => {
    const sections = [{ distance: 5000, grade: 5 }];
    expect(computeNfd(sections, lut)).toBeGreaterThan(5000);
  });

  test("downhill course: NFD < actual distance", () => {
    const sections = [{ distance: 5000, grade: -5 }];
    expect(computeNfd(sections, lut)).toBeLessThan(5000);
  });

  test("additive: combined course equals sum of parts", () => {
    const sec1 = [{ distance: 3000, grade: 3 }];
    const sec2 = [{ distance: 4000, grade: -2 }];
    const combined = [...sec1, ...sec2];
    const nfd1 = computeNfd(sec1, lut);
    const nfd2 = computeNfd(sec2, lut);
    const nfdCombined = computeNfd(combined, lut);
    expect(nfdCombined).toBeCloseTo(nfd1 + nfd2, 10);
  });

  test("empty course: NFD is 0", () => {
    expect(computeNfd([], lut)).toBe(0);
  });
});

describe("computeNfdKm", () => {
  const params = CYCLIST_PRESETS.intermediate;
  const lut = buildNfdLut(params);

  test("converts metres to kilometres", () => {
    const sections = [{ distance: 10000, grade: 0 }];
    expect(computeNfdKm(sections, lut)).toBeCloseTo(10, 1);
  });
});

describe("NFD across cyclist levels", () => {
  test("uphill section is harder for beginners than advanced riders", () => {
    const sections = [{ distance: 5000, grade: 8 }];
    const lutBeginner = buildNfdLut(CYCLIST_PRESETS.beginner);
    const lutAdvanced = buildNfdLut(CYCLIST_PRESETS.advanced);
    const nfdBeg = computeNfd(sections, lutBeginner);
    const nfdAdv = computeNfd(sections, lutAdvanced);
    expect(nfdBeg).toBeGreaterThan(nfdAdv);
  });
});
