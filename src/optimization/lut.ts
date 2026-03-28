/**
 * Generation of the NFD look-up table (LUT).
 *
 * The NFD coefficient c(n) for gradient n is defined as:
 *
 *   c(n) = s(n) / s(0)
 *
 * where the load factor s(n) is:
 *
 *   s(n) = P_eq(v(n), n)⁴ / v(n)   [W⁴·s/m]
 *
 * Here v(n) is the assumed speed at gradient n computed from flat-road
 * power P_0 (see assumed-speed.ts), and P_eq is the equilibrium power at
 * that speed.
 *
 * A section of distance d at gradient n contributes d · c(n) m to the
 * total NFD of a course.
 */

import { equilibriumPower } from "../physics/power";
import { computeAssumedSpeeds, DEFAULT_GRADE_BINS } from "./assumed-speed";
import type { CourseSection, CyclistParams, NfdLut, NfdLutWithStats } from "../types";

/**
 * Compute the load factor s(n) = P_eq(v, n)⁴ / v for a given speed and grade.
 *
 * @param v     Speed in m/s
 * @param grade Gradient in %
 * @param params Cyclist parameters
 * @returns Load factor in W⁴·s/m
 */
export function loadFactor(
  v: number,
  grade: number,
  params: CyclistParams,
): number {
  const pEff = Math.max(0, equilibriumPower(v, grade, params));
  return Math.pow(pEff, 4) / v;
}

/**
 * Build the NFD coefficient LUT for a cyclist on given grade bins.
 *
 * @param params Cyclist parameters
 * @param grades Grade bins in percent (defaults to -15..15 integer bins)
 * @returns Map from grade (%) to NFD coefficient (dimensionless)
 */
export function buildNfdLut(
  params: CyclistParams,
  grades: number[] = DEFAULT_GRADE_BINS,
): NfdLut {
  const assumedSpeeds = computeAssumedSpeeds(params, grades);

  // s(0): load factor at 0% gradient
  const v0 = assumedSpeeds.get(0);
  if (v0 === undefined) {
    throw new Error("Standard course distribution must include 0% grade");
  }
  const s0 = loadFactor(v0, 0, params);

  const lut: NfdLut = new Map();
  for (const [grade, v] of assumedSpeeds.entries()) {
    const s = loadFactor(v, grade, params);
    lut.set(grade, s / s0);
  }
  return lut;
}

/**
 * Find the closest grade bin to a given grade value.
 *
 * @param grade Grade value in %
 * @param bins Sorted array of grade bins in %
 * @returns The closest grade bin value from the array
 */
export function findClosestGradeBin(grade: number, bins: number[]): number {
  if (bins.length === 0) {
    throw new Error("Grade bins array cannot be empty");
  }
  const firstBin = bins[0] as number;
  let closest = firstBin;
  let minDistance = Math.abs(grade - firstBin);
  for (const bin of bins) {
    const distance = Math.abs(grade - bin);
    if (distance < minDistance) {
      minDistance = distance;
      closest = bin;
    }
  }
  return closest;
}

/**
 * Compute the total course riding time in seconds.
 *
 * @param sections Array of course sections with distance (m) and grade (%)
 * @param speedsMap Map from grade (%) to assumed speed (m/s)
 * @returns Total riding time in seconds, or 0 if sections is empty
 */
export function computeCourseTime(
  sections: CourseSection[],
  speedsMap: Map<number, number>,
): number {
  if (sections.length === 0 || speedsMap.size === 0) {
    return 0;
  }

  const grades = Array.from(speedsMap.keys()).sort((a, b) => a - b);

  let totalTimeSeconds = 0;
  for (const section of sections) {
    const closestGrade = findClosestGradeBin(section.grade, grades);
    const speedMs = speedsMap.get(closestGrade) ?? 0;
    if (speedMs > 0) {
      const timeSeconds = section.distance / speedMs;
      totalTimeSeconds += timeSeconds;
    }
  }

  return totalTimeSeconds;
}

/**
 * Compute estimated normalized power (NP) for a course using a simple
 * time-weighted 4th-power average without 30-second smoothing.
 *
 * NP = (sum(P_i^4 * t_i) / sum(t_i))^(1/4)
 *
 * where each section power P_i is computed from equilibriumPower at the
 * assumed speed for the section grade. Negative powers are clamped to 0.
 *
 * @param sections Array of course sections with distance (m) and grade (%)
 * @param speedsMap Map from grade (%) to assumed speed (m/s)
 * @param params Cyclist parameters
 * @returns Estimated NP in watts, or 0 if sections/time is empty
 */
export function computeEstimatedNp(
  sections: CourseSection[],
  speedsMap: Map<number, number>,
  params: CyclistParams,
): number {
  if (sections.length === 0 || speedsMap.size === 0) {
    return 0;
  }

  const grades = Array.from(speedsMap.keys()).sort((a, b) => a - b);

  let totalTimeSeconds = 0;
  let totalPower4Time = 0;

  for (const section of sections) {
    const closestGrade = findClosestGradeBin(section.grade, grades);
    const speedMs = speedsMap.get(closestGrade) ?? 0;
    if (speedMs <= 0) {
      continue;
    }

    const timeSeconds = section.distance / speedMs;
    const sectionPower = Math.max(0, equilibriumPower(speedMs, section.grade, params));
    totalTimeSeconds += timeSeconds;
    totalPower4Time += Math.pow(sectionPower, 4) * timeSeconds;
  }

  if (totalTimeSeconds <= 0) {
    return 0;
  }

  return Math.pow(totalPower4Time / totalTimeSeconds, 1 / 4);
}

/**
 * Build the comprehensive NFD LUT with statistics.
 *
 * This function combines the NFD coefficient LUT and the assumed speed map
 * into a single data structure, avoiding redundant recalculation of speeds.
 *
 * @param params Cyclist parameters
 * @param grades Grade bins in percent (defaults to -15..15 in 0.1% steps)
 * @returns Comprehensive LUT containing both NFD coefficients and speed map
 */
export function buildNfdLutWithStats(
  params: CyclistParams,
  grades: number[] = DEFAULT_GRADE_BINS,
): NfdLutWithStats {
  const speedsMap = computeAssumedSpeeds(params, grades);

  // s(0): load factor at 0% gradient
  const v0 = speedsMap.get(0);
  if (v0 === undefined) {
    throw new Error("Standard course distribution must include 0% grade");
  }
  const s0 = loadFactor(v0, 0, params);

  const nfdLut: NfdLut = new Map();
  for (const [grade, v] of speedsMap.entries()) {
    const s = loadFactor(v, grade, params);
    nfdLut.set(grade, s / s0);
  }

  return { nfdLut, speedsMap };
}
