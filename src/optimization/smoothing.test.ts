/**
 * Tests for elevation smoothing and gradient calculation.
 */

import {
  interpolateElevation,
  savitzkyGolaySmooth,
  smoothGradients,
  type ElevationPoint,
} from "./smoothing";

describe("interpolateElevation", () => {
  it("should interpolate at 10m intervals", () => {
    const points: ElevationPoint[] = [
      { distance: 0, elevation: 100 },
      { distance: 100, elevation: 110 },
    ];

    const result = interpolateElevation(points, 10);

    expect(result).toHaveLength(11); // 0, 10, 20, ..., 100
    expect(result[0]).toEqual({ distance: 0, elevation: 100 });
    expect(result[5]).toEqual({ distance: 50, elevation: 105 });
    expect(result[10]).toEqual({ distance: 100, elevation: 110 });
  });

  it("should handle non-zero starting distance", () => {
    const points: ElevationPoint[] = [
      { distance: 50, elevation: 200 },
      { distance: 150, elevation: 220 },
    ];

    const result = interpolateElevation(points, 10);

    expect(result[0]).toEqual({ distance: 50, elevation: 200 });
    expect(result[result.length - 1]).toEqual({ distance: 150, elevation: 220 });
  });

  it("should handle custom interval", () => {
    const points: ElevationPoint[] = [
      { distance: 0, elevation: 100 },
      { distance: 100, elevation: 120 },
    ];

    const result = interpolateElevation(points, 25);

    expect(result).toHaveLength(5); // 0, 25, 50, 75, 100
    expect(result[1]).toEqual({ distance: 25, elevation: 105 });
  });

  it("should return empty array for insufficient points", () => {
    const points: ElevationPoint[] = [{ distance: 0, elevation: 100 }];
    const result = interpolateElevation(points);
    expect(result).toHaveLength(0);
  });

  it("should sort points by distance", () => {
    const points: ElevationPoint[] = [
      { distance: 100, elevation: 120 },
      { distance: 0, elevation: 100 },
      { distance: 50, elevation: 110 },
    ];

    const result = interpolateElevation(points, 25);

    // Should be sorted
    for (let i = 1; i < result.length; i++) {
      const prev = result[i - 1];
      const curr = result[i];
      if (prev && curr) {
        expect(curr.distance).toBeGreaterThan(prev.distance);
      }
    }
  });

  it("should not include trailing remainder shorter than interval", () => {
    const points: ElevationPoint[] = [
      { distance: 0, elevation: 100 },
      { distance: 1608, elevation: 140 },
    ];

    const result = interpolateElevation(points, 20);

    expect(result.length).toBeGreaterThan(0);
    const last = result[result.length - 1];
    expect(last?.distance).toBe(1600);
    expect(result.some((p) => p.distance > 1600)).toBe(false);
  });
});

describe("savitzkyGolaySmooth", () => {
  it("should smooth noisy data", () => {
    const noisy = [1, 3, 2, 5, 4, 7, 6, 8, 7, 9];
    const smoothed = savitzkyGolaySmooth(noisy, 5);

    expect(smoothed).toHaveLength(noisy.length);

    // Smoothed values should be less extreme than noisy values
    // Check variance reduction
    const noisyVariance =
      noisy.reduce((sum, v) => sum + Math.pow(v - 5.2, 2), 0) / noisy.length;
    const smoothedVariance =
      smoothed.reduce((sum, v) => sum + Math.pow(v - 5.2, 2), 0) / smoothed.length;

    expect(smoothedVariance).toBeLessThan(noisyVariance);
  });

  it("should preserve linear trends", () => {
    // Linear sequence should pass through mostly unchanged
    const linear = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const smoothed = savitzkyGolaySmooth(linear, 5);

    expect(smoothed).toHaveLength(linear.length);

    // All smoothed values should be close to original (within reasonable tolerance)
    for (let i = 0; i < smoothed.length; i++) {
      const smoothVal = smoothed[i];
      const linVal = linear[i];
      if (smoothVal !== undefined && linVal !== undefined) {
        expect(Math.abs(smoothVal - linVal)).toBeLessThan(1.0);
      }
    }
  });

  it("should handle edge cases with small windows", () => {
    const data = [1, 2, 3, 4, 5];
    const smoothed = savitzkyGolaySmooth(data, 3);

    expect(smoothed).toHaveLength(5);

    // All values should be finite
    for (const v of smoothed) {
      expect(isFinite(v)).toBe(true);
    }

    // Smoothed values should be within reasonable range of data
    for (const v of smoothed) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(6);
    }
  });

  it("should throw error on even window size", () => {
    expect(() => savitzkyGolaySmooth([1, 2, 3], 4)).toThrow();
  });

  it("should return copy when data length < window size", () => {
    const data = [1, 2];
    const smoothed = savitzkyGolaySmooth(data, 5);
    expect(smoothed).toEqual(data);
  });

  it("should support window size 11 with polynomial order 2", () => {
    const data = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];
    const smoothed = savitzkyGolaySmooth(data, 11, 2);

    expect(smoothed).toHaveLength(data.length);
    for (const v of smoothed) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("should support window size 11 with polynomial order 3", () => {
    const data = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];
    const smoothed = savitzkyGolaySmooth(data, 11, 3);

    expect(smoothed).toHaveLength(data.length);
    for (const v of smoothed) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("should throw error on unsupported polynomial order", () => {
    expect(() => savitzkyGolaySmooth([1, 2, 3, 4, 5], 5, 4 as 2 | 3)).toThrow();
  });
});

describe("smoothGradients", () => {
  it("should compute full pipeline", () => {
    const elevationPoints: ElevationPoint[] = [
      { distance: 0, elevation: 0 },
      { distance: 100, elevation: 10 },
      { distance: 200, elevation: 30 },
      { distance: 300, elevation: 35 },
    ];

    const result = smoothGradients(elevationPoints, 10, 5);

    // Should have interpolated elevations
    expect(result.elevations.length).toBeGreaterThan(0);
    const firstElev = result.elevations[0];
    if (firstElev) {
      expect(firstElev.distance).toBe(0);
    }

    // Gradients should match interpolated points (minus one)
    expect(result.gradients.length).toBe(result.elevations.length - 1);

    // All gradient values should be finite
    for (const g of result.gradients) {
      expect(isFinite(g.gradient)).toBe(true);
    }
  });

  it("should compute realistic gradients", () => {
    // Simple case: 10% grade for 100m
    const elevationPoints: ElevationPoint[] = [
      { distance: 0, elevation: 0 },
      { distance: 100, elevation: 10 },
    ];

    const result = smoothGradients(elevationPoints, 10, 3);

    // All gradients should be close to 10%
    for (const g of result.gradients) {
      expect(Math.abs(g.gradient - 10)).toBeLessThan(0.5);
    }
  });

  it("should handle downhill grades", () => {
    const elevationPoints: ElevationPoint[] = [
      { distance: 0, elevation: 100 },
      { distance: 100, elevation: 80 },
    ];

    const result = smoothGradients(elevationPoints, 10, 3);

    // All gradients should be negative (downhill)
    for (const g of result.gradients) {
      expect(g.gradient).toBeLessThan(0);
    }
  });

  it("should handle flat sections", () => {
    const elevationPoints: ElevationPoint[] = [
      { distance: 0, elevation: 100 },
      { distance: 100, elevation: 100 },
    ];

    const result = smoothGradients(elevationPoints, 10, 3);

    // All gradients should be close to 0%
    for (const g of result.gradients) {
      expect(Math.abs(g.gradient)).toBeLessThan(0.1);
    }
  });

  it("should return empty results for insufficient data", () => {
    const elevationPoints: ElevationPoint[] = [{ distance: 0, elevation: 100 }];

    const result = smoothGradients(elevationPoints);

    expect(result.elevations).toHaveLength(0);
    expect(result.gradients).toHaveLength(0);
  });
});
