/**
 * Computation of the "assumed speed" for each gradient.
 *
 * The assumed speed v(n) for gradient n is the speed at which a cyclist
 * travelling the standard course achieves the minimum total time while
 * keeping the Normalized Power (NP, Coggan) equal to their cruise power.
 *
 * ## Derivation
 *
 * Let f(n) be the fraction of the standard course at gradient n, P(v, n) be
 * the equilibrium power at speed v and gradient n, and P_c be the cruise
 * power. We seek v(n) that:
 *
 *   minimise   Σ_n  f(n) / v(n)          (total time, up to a constant)
 *   subject to Σ_n  f(n) · P(v(n),n)⁴ / v(n)
 *              = P_c⁴ · Σ_n  f(n) / v(n)   (NP⁴ average = P_c⁴)
 *   and        v_min ≤ v(n) ≤ v_max
 *
 * This is equivalent to:
 *
 *   Σ_n  f(n) · [P(v(n),n)⁴ − P_c⁴] / v(n) = 0   ... (*)
 *
 * Without the speed constraints the optimal strategy is constant power
 * P(v(n),n) = P_c (classic result: minimise time with fixed NP means ride
 * at constant power).  Speed clamping means some gradients are pinned at
 * v_min or v_max with a different power; for the remaining "free" gradients
 * we choose a single target power P_target (found by bisection) that
 * satisfies (*).
 *
 * Algorithm:
 *   1. For a trial P_target, compute v(n) = speedForPower(P_target, n, params)
 *      which already clamps to [v_min, v_max].
 *   2. Evaluate the constraint residual Σ f(n)·[P(v(n),n)⁴ − P_c⁴] / v(n).
 *   3. Bisect on P_target until the residual is ≈ 0.
 */

import { equilibriumPower, speedForPower } from "../physics/power";
import type { CyclistParams, GradeFrequency } from "../types";

/**
 * Compute the assumed speed for each gradient entry in `distribution`.
 *
 * @param params       Cyclist parameters (including cruise power fraction and FTP)
 * @param distribution Standard course gradient distribution
 * @returns Map from grade (%) to assumed speed (m/s)
 */
export function computeAssumedSpeeds(
  params: CyclistParams,
  distribution: GradeFrequency[],
): Map<number, number> {
  const cruisePower = params.ftp * params.cruisePowerFraction;
  const cruisePower4 = Math.pow(cruisePower, 4);

  /**
   * Given a trial target power, compute the NP-constraint residual.
   * residual = Σ f(n)·[P_eff(v(n),n)⁴ − P_c⁴] / v(n)
   * Positive → actual NP > P_c (target too high), negative → NP < P_c.
   *
   * P_eff = max(0, P_eq): the cyclist cannot produce negative power; on
   * downhills where gravity exceeds resistances the rider simply coasts.
   */
  function residual(targetPower: number): number {
    return distribution.reduce((sum, { grade, frequency }) => {
      const v = speedForPower(targetPower, grade, params);
      const pEff = Math.max(0, equilibriumPower(v, grade, params));
      return sum + frequency * (Math.pow(pEff, 4) - cruisePower4) / v;
    }, 0);
  }

  // Bisect to find P_target such that residual ≈ 0.
  // Search range: a very small power (near zero) up to 2 × FTP.
  let lo = 1;           // W (near-zero power, implies very slow speed)
  let hi = params.ftp * 2; // W

  const rLo = residual(lo);
  const rHi = residual(hi);

  let targetPower: number;
  if (rLo >= 0) {
    // Even at minimum power, NP >= cruise; pin everything at minimum speed
    targetPower = lo;
  } else if (rHi <= 0) {
    // Even at maximum power, NP <= cruise; pin everything at maximum speed
    targetPower = hi;
  } else {
    // Bisect (residual is increasing in targetPower)
    for (let i = 0; i < 64; i++) {
      const mid = (lo + hi) / 2;
      if (residual(mid) < 0) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    targetPower = (lo + hi) / 2;
  }

  // Build the result map
  const result = new Map<number, number>();
  for (const { grade } of distribution) {
    result.set(grade, speedForPower(targetPower, grade, params));
  }
  return result;
}
