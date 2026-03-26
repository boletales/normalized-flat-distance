/**
 * Elevation data smoothing using interpolation and Savitzky-Golay filtering.
 *
 * This module provides:
 * 1. Linear interpolation of elevation at 10m intervals
 * 2. Savitzky-Golay smoothing of gradient data using cubic polynomial fitting
 */

/**
 * Represents a point with distance and elevation.
 */
export interface ElevationPoint {
  distance: number; // meters
  elevation: number; // meters
}

function invertMatrix(matrix: number[][]): number[][] {
  const n = matrix.length;
  const augmented: number[][] = matrix.map((row, i) => {
    const identity = Array.from({ length: n }, (_, j) => (i === j ? 1 : 0));
    return [...row, ...identity];
  });

  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(augmented[r]?.[col] ?? 0) > Math.abs(augmented[pivotRow]?.[col] ?? 0)) {
        pivotRow = r;
      }
    }

    const pivot = augmented[pivotRow]?.[col] ?? 0;
    if (Math.abs(pivot) < 1e-12) {
      throw new Error("Matrix is singular");
    }

    if (pivotRow !== col) {
      const tmp = augmented[col];
      augmented[col] = augmented[pivotRow] as number[];
      augmented[pivotRow] = tmp as number[];
    }

    const pivotValue = augmented[col]?.[col] ?? 1;
    for (let c = 0; c < 2 * n; c += 1) {
      const v = augmented[col]?.[c];
      if (v !== undefined) {
        augmented[col]![c] = v / pivotValue;
      }
    }

    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = augmented[r]?.[col] ?? 0;
      for (let c = 0; c < 2 * n; c += 1) {
        const target = augmented[r]?.[c] ?? 0;
        const src = augmented[col]?.[c] ?? 0;
        augmented[r]![c] = target - factor * src;
      }
    }
  }

  return augmented.map((row) => row.slice(n));
}

/**
 * Compute center-evaluation Savitzky-Golay smoothing coefficients.
 */
function computeSavitzkyGolayCoefficients(
  windowSize: number,
  polynomialOrder: 2 | 3,
): number[] {
  const halfWindow = Math.floor(windowSize / 2);
  const p = polynomialOrder;

  // A[k, j] = x_k^j for x_k in [-halfWindow, halfWindow], j in [0, p]
  const xValues = Array.from({ length: windowSize }, (_, i) => i - halfWindow);
  const ata: number[][] = Array.from({ length: p + 1 }, () => Array(p + 1).fill(0));

  for (let i = 0; i <= p; i += 1) {
    for (let j = 0; j <= p; j += 1) {
      let sum = 0;
      for (const x of xValues) {
        sum += x ** (i + j);
      }
      ata[i]![j] = sum;
    }
  }

  const ataInv = invertMatrix(ata);

  // c_k = sum_j (ATA^-1)[0, j] * x_k^j
  return xValues.map((x) => {
    let coeff = 0;
    for (let j = 0; j <= p; j += 1) {
      coeff += (ataInv[0]?.[j] ?? 0) * (x ** j);
    }
    return coeff;
  });
}

/**
 * Linear interpolation of elevation at a given distance.
 *
 * @param distance - The distance at which to interpolate
 * @param points - Sorted array of elevation points
 * @returns Interpolated elevation, or undefined if outside bounds
 */
function interpolateAtDistance(
  distance: number,
  points: ElevationPoint[],
): number | undefined {
  if (points.length < 2) return undefined;
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  if (!firstPoint || !lastPoint) return undefined;

  if (distance < firstPoint.distance || distance > lastPoint.distance) {
    return undefined;
  }

  // Find the surrounding points
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    if (!p0 || !p1) continue;

    if (distance >= p0.distance && distance <= p1.distance) {
      // Linear interpolation
      const t = (distance - p0.distance) / (p1.distance - p0.distance);
      return p0.elevation + t * (p1.elevation - p0.elevation);
    }
  }

  return undefined;
}

/**
 * Create interpolated elevation data at 10m intervals.
 *
 * @param points - Array of elevation points
 * @param interval - Interpolation interval in meters (default: 10)
 * @returns Array of interpolated elevation points at regular intervals
 */
export function interpolateElevation(
  points: ElevationPoint[],
  interval: number = 10,
): ElevationPoint[] {
  if (points.length < 2) return [];

  const sorted = [...points].sort((a, b) => a.distance - b.distance);
  const firstPoint = sorted[0];
  const lastPoint = sorted[sorted.length - 1];
  if (!firstPoint || !lastPoint) return [];

  const startDist = firstPoint.distance;
  const endDist = lastPoint.distance;

  const result: ElevationPoint[] = [];

  // Generate points at regular intervals
  for (let dist = startDist; dist <= endDist; dist += interval) {
    const elev = interpolateAtDistance(dist, sorted);
    if (elev !== undefined) {
      result.push({ distance: dist, elevation: elev });
    }
  }

  return result;
}

/**
 * Calculate gradient (%) from elevation difference over horizontal distance.
 *
 * @param elevationDiff - Elevation difference in meters
 * @param distance - Horizontal distance in meters
 * @returns Gradient in percent
 */
function calculateGradient(elevationDiff: number, distance: number): number {
  if (distance === 0) return 0;
  return (elevationDiff / distance) * 100;
}

/**
 * Apply Savitzky-Golay smoothing filter to gradient data.
 *
 * Uses least-squares polynomial fitting coefficients.
 *
 * @param gradients - Array of gradient values (%)
 * @param windowSize - Filter window size in points (must be odd, default: 5)
 * @param polynomialOrder - Polynomial order (2 or 3, default: 3)
 * @returns Smoothed gradient array
 */
export function savitzkyGolaySmooth(
  gradients: number[],
  windowSize: number = 5,
  polynomialOrder: 2 | 3 = 3,
): number[] {
  if (windowSize < 3 || windowSize % 2 === 0) {
    throw new Error("Window size must be an odd number >= 3");
  }

  if (polynomialOrder !== 2 && polynomialOrder !== 3) {
    throw new Error("Polynomial order must be 2 or 3");
  }

  if (gradients.length < windowSize) {
    return [...gradients];
  }

  const effectiveOrder = Math.min(polynomialOrder, windowSize - 1);
  if (effectiveOrder < 2) {
    throw new Error("Effective polynomial order must be >= 2");
  }

  const coefficients = computeSavitzkyGolayCoefficients(
    windowSize,
    effectiveOrder as 2 | 3,
  );
  const halfWindow = Math.floor(windowSize / 2);
  const result: number[] = [];

  // Apply filter to each point
  for (let i = 0; i < gradients.length; i++) {
    // Determine actual window (handle edges)
    const leftMargin = Math.min(i, halfWindow);
    const rightMargin = Math.min(gradients.length - 1 - i, halfWindow);

    let smoothedValue = 0;
    let coeffSum = 0;

    // Apply filter coefficients
    for (let j = -leftMargin; j <= rightMargin; j++) {
      const idx = i + j;
      const coeffIdx = j + halfWindow;

      if (
        idx >= 0 &&
        idx < gradients.length &&
        coeffIdx >= 0 &&
        coeffIdx < coefficients.length
      ) {
        const gradient = gradients[idx];
        const coeff = coefficients[coeffIdx];
        if (gradient !== undefined && coeff !== undefined) {
          smoothedValue += gradient * coeff;
          coeffSum += coeff;
        }
      }
    }

    // Normalize by sum of coefficients
    const currentGrad = gradients[i];
    result.push(
      coeffSum !== 0 && currentGrad !== undefined
        ? smoothedValue / coeffSum
        : currentGrad ?? 0,
    );
  }

  return result;
}

/**
 * Simple moving average utility.
 */
function simpleMovingAverage(data: number[], windowSize: number): number[] {
  const halfWindow = Math.floor(windowSize / 2);
  const result: number[] = [];

  for (let i = 0; i < data.length; i++) {
    const leftMargin = Math.min(i, halfWindow);
    const rightMargin = Math.min(data.length - 1 - i, halfWindow);

    let sum = 0;
    let count = 0;

    for (let j = -leftMargin; j <= rightMargin; j++) {
      const dataPoint = data[i + j];
      if (dataPoint !== undefined) {
        sum += dataPoint;
        count++;
      }
    }

    result.push(sum / count);
  }

  return result;
}

/**
 * Complete smoothing pipeline: interpolate elevation and smooth gradient.
 *
 * @param elevationPoints - Array of elevation points
 * @param interval - Interpolation interval in meters (default: 10)
 * @param windowSize - Savitzky-Golay window size (default: 5)
 * @returns Object with interpolated elevations and smoothed gradients
 */
export function smoothGradients(
  elevationPoints: ElevationPoint[],
  interval: number = 10,
  windowSize: number = 5,
  polynomialOrder: 2 | 3 = 3,
): {
  elevations: ElevationPoint[];
  gradients: Array<{ distance: number; gradient: number }>;
} {
  // Step 1: Interpolate elevations at regular intervals
  const interpolated = interpolateElevation(elevationPoints, interval);

  if (interpolated.length < 2) {
    return { elevations: interpolated, gradients: [] };
  }

  // Step 2: Calculate raw gradients between consecutive points
  const rawGradients: number[] = [];
  for (let i = 1; i < interpolated.length; i++) {
    const curr = interpolated[i];
    const prev = interpolated[i - 1];
    if (!curr || !prev) continue;

    const elevDiff = curr.elevation - prev.elevation;
    const distDiff = curr.distance - prev.distance;
    const gradient = calculateGradient(elevDiff, distDiff);
    rawGradients.push(gradient);
  }

  // Step 3: Apply Savitzky-Golay smoothing
  const smoothed = savitzkyGolaySmooth(rawGradients, windowSize, polynomialOrder);

  // Step 4: Prepare output with distances
  const gradients: Array<{ distance: number; gradient: number }> = [];
  for (let idx = 0; idx < smoothed.length; idx++) {
    const nextPoint = interpolated[idx + 1];
    const smoothedVal = smoothed[idx];
    if (nextPoint && smoothedVal !== undefined) {
      gradients.push({
        distance: nextPoint.distance,
        gradient: smoothedVal,
      });
    }
  }

  return { elevations: interpolated, gradients };
}
