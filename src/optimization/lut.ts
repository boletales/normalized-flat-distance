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
import type { CyclistParams, NfdLut } from "../types";

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
