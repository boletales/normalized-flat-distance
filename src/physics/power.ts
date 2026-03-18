/**
 * Cycling power model.
 *
 * Reference:
 *   Martin, J. C., Milliken, D. L., Cobb, J. E., McFadden, K. L., & Coggan, A. R. (1998).
 *   Validation of a Mathematical Model for Road Cycling Power.
 *   Journal of Applied Biomechanics, 14(3), 276–291.
 *   https://doi.org/10.1123/jab.14.3.276
 *
 * Total power = (gravity + rolling + aerodynamic) forces × velocity / drivetrain_efficiency
 */

import { G, AIR_DENSITY } from "../types";
import type { CyclistParams } from "../types";

/**
 * Compute the equilibrium mechanical power output (W) required to maintain a
 * constant speed `v` (m/s) on a slope of `grade` percent.
 *
 * A positive result means the rider must produce power; a negative result
 * means gravity is doing more work than friction/aero, so the rider could
 * coast (or even brake) to maintain that speed.
 *
 * @param v     Speed in m/s (must be > 0)
 * @param grade Gradient in percent (e.g. 5 for 5% uphill, -3 for 3% downhill)
 * @param params Cyclist physical parameters
 * @returns Power in watts
 */
export function equilibriumPower(
  v: number,
  grade: number,
  params: CyclistParams,
): number {
  const gradeRatio = grade / 100;
  const hyp = Math.sqrt(1 + gradeRatio * gradeRatio);
  const sinTheta = gradeRatio / hyp;
  const cosTheta = 1 / hyp;

  const fGravity = params.mass * G * sinTheta;
  const fRolling = params.Crr * params.mass * G * cosTheta;
  const fAero = 0.5 * params.rho * params.CdA * v * v;

  return ((fGravity + fRolling + fAero) * v) / params.eta;
}

/**
 * Find the speed (m/s) at which the equilibrium power equals `targetPower`,
 * for a given gradient, using bisection search.
 *
 * The speed is clamped to [params.vMin, params.vMax].
 * If the equilibrium power at vMax is still below targetPower (e.g. steep
 * downhill), vMax is returned.
 * If the equilibrium power at vMin already exceeds targetPower (e.g. very
 * steep uphill), vMin is returned.
 *
 * @param targetPower Target power in watts
 * @param grade       Gradient in percent
 * @param params      Cyclist physical parameters
 * @returns Speed in m/s
 */
export function speedForPower(
  targetPower: number,
  grade: number,
  params: CyclistParams,
): number {
  const pAtMin = equilibriumPower(params.vMin, grade, params);
  if (pAtMin >= targetPower) return params.vMin;

  const pAtMax = equilibriumPower(params.vMax, grade, params);
  if (pAtMax <= targetPower) return params.vMax;

  // Bisection: equilibriumPower is strictly increasing in v (for v > 0)
  let lo = params.vMin;
  let hi = params.vMax;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (equilibriumPower(mid, grade, params) < targetPower) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

// Re-export constants for convenience
export { G, AIR_DENSITY };
