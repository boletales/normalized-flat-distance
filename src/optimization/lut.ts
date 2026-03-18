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
 * Here v(n) is the assumed speed at gradient n (see assumed-speed.ts) and
 * P_eq is the equilibrium power at that speed.
 *
 * A section of distance d at gradient n contributes d · c(n) km to the
 * total NFD of a course.
 */

import { equilibriumPower } from "../physics/power";
import { computeAssumedSpeeds } from "./assumed-speed";
import { STANDARD_COURSE_DISTRIBUTION } from "./standard-course";
import type { CyclistParams, GradeFrequency, NfdLut } from "../types";

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
 * Build the NFD coefficient LUT for a cyclist on a given distribution.
 *
 * @param params       Cyclist parameters
 * @param distribution Grade distribution (defaults to standard course)
 * @returns Map from grade (%) to NFD coefficient (dimensionless)
 */
export function buildNfdLut(
  params: CyclistParams,
  distribution: GradeFrequency[] = STANDARD_COURSE_DISTRIBUTION,
): NfdLut {
  const assumedSpeeds = computeAssumedSpeeds(params, distribution);

  // s(0): load factor at 0% gradient
  const v0 = assumedSpeeds.get(0);
  if (v0 === undefined) {
    throw new Error("Standard course distribution must include 0% grade");
  }
  const s0 = loadFactor(v0, 0, params);

  const lut: NfdLut = new Map();
  for (const [grade, v] of assumedSpeeds) {
    const s = loadFactor(v, grade, params);
    lut.set(grade, s / s0);
  }
  return lut;
}
