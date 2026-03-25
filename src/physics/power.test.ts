import { equilibriumPower, speedForPower } from "../physics/power";
import { CYCLIST_PRESETS } from "../presets";

describe("equilibriumPower", () => {
  const params = CYCLIST_PRESETS.intermediate;

  test("positive power on flat road", () => {
    const p = equilibriumPower(7, 0, params); // ~25 km/h on flat
    expect(p).toBeGreaterThan(0);
  });

  test("increases with speed on flat road", () => {
    const p1 = equilibriumPower(5, 0, params);
    const p2 = equilibriumPower(10, 0, params);
    expect(p2).toBeGreaterThan(p1);
  });

  test("increases with gradient", () => {
    const pFlat = equilibriumPower(5, 0, params);
    const pUphill = equilibriumPower(5, 5, params);
    const pDownhill = equilibriumPower(5, -5, params);
    expect(pUphill).toBeGreaterThan(pFlat);
    expect(pFlat).toBeGreaterThan(pDownhill);
  });

  test("realistic power on flat at 30 km/h", () => {
    // ~30 km/h on flat should require roughly 100–250 W for an intermediate rider
    const p = equilibriumPower(30 / 3.6, 0, params);
    expect(p).toBeGreaterThan(80);
    expect(p).toBeLessThan(300);
  });

  test("negative power on steep downhill (gravity assists more than friction/aero)", () => {
    // Very steep downhill at low speed: gravity dominates
    const p = equilibriumPower(3, -20, params);
    expect(p).toBeLessThan(0);
  });
});

describe("speedForPower", () => {
  const params = CYCLIST_PRESETS.intermediate;

  test("returns speed >= vMin", () => {
    const v = speedForPower(200, 0, params);
    expect(v).toBeGreaterThanOrEqual(params.vMin);
  });

  test("higher power → higher speed on flat", () => {
    const v1 = speedForPower(100, 0, params);
    const v2 = speedForPower(200, 0, params);
    expect(v2).toBeGreaterThan(v1);
  });

  test("same power → lower speed on uphill", () => {
    const vFlat = speedForPower(200, 0, params);
    const vUphill = speedForPower(200, 5, params);
    expect(vUphill).toBeLessThan(vFlat);
  });

  test("pins to vMin when power is very low on uphill", () => {
    const v = speedForPower(1, 10, params);
    expect(v).toBe(params.vMin);
  });

  test("returns finite speed for very high power on downhill", () => {
    const v = speedForPower(params.flatPower * 10, -10, params);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(params.vMin);
  });

  test("round-trip: speedForPower then equilibriumPower ≈ target", () => {
    const target = 200;
    const v = speedForPower(target, 3, params);
    // If not clamped, equilibriumPower should recover the target
    if (v > params.vMin) {
      expect(equilibriumPower(v, 3, params)).toBeCloseTo(target, 3);
    }
  });
});
