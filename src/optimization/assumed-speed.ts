/**
 * Computation of the "assumed speed" for each gradient.
 *
 * This module implements the P_0-based formulation described in docs/NFD.md.
 *
 * Let the equilibrium power be P(v, n) = a v^3 + b(n) v where:
 *   a = 0.5 * rho * CdA / eta
 *   b(n) = mass * g * (sin(theta) + Crr * cos(theta)) / eta
 *   theta = arctan(n / 100)
 *
 * Given a flat-road power P_0 (at n=0), define v_0 by P(v_0, 0) = P_0 and:
 *
 *   c = (11 a v_0^2 + 3 b(0)) (a v_0^2 + b(0))^3 v_0^4
 *
 * For each gradient n, the optimal speed v_op(n) satisfies:
 *
 *   (11 a v^2 + 3 b(n)) (a v^2 + b(n))^3 v^4 = c
 *
 * We select the largest positive root with positive equilibrium power and
 * then apply the practical minimum speed limit:
 *
 *   v_est(n) = max(v_op(n), v_min)
 */

import { G } from "../types";
import type { CyclistParams } from "../types";

/** Default discrete grade bins for LUT generation. */
export const DEFAULT_GRADE_BINS: number[] = (() => {
  const bins: number[] = [];
  for (let g = -300; g <= 300; g++) bins.push(g/10);
  return bins;
})();

/** Internal upper bound (m/s) for numerical root search. */
const SPEED_SEARCH_MAX = 200;

function aerodynamicCoeff(params: CyclistParams): number {
  return (0.5 * params.rho * params.CdA) / params.eta;
}

function linearCoeff(grade: number, params: CyclistParams): number {
  const gradeRatio = grade / 100;
  const hyp = Math.sqrt(1 + gradeRatio * gradeRatio);
  const sinTheta = gradeRatio / hyp;
  const cosTheta = 1 / hyp;
  return (params.mass * G * (sinTheta + params.Crr * cosTheta)) / params.eta;
}

function equilibriumPowerFromCoeffs(v: number, a: number, b: number): number {
  return (a * v * v + b) * v;
}

function costResidual(v: number, a: number, b: number, c: number): number {
  const v2 = v * v;
  const q = a * v2 + b;
  return (11 * a * v2 + 3 * b) * Math.pow(q, 3) * Math.pow(v, 4) - c;
}

function bisectRoot(
  f: (v: number) => number,
  lo: number,
  hi: number,
  iterations = 80,
): number {
  let l = lo;
  let h = hi;
  let fl = f(l);
  for (let i = 0; i < iterations; i++) {
    const mid = (l + h) / 2;
    const fm = f(mid);
    if (fl === 0) return l;
    if (fm === 0) return mid;
    if (fl * fm < 0) {
      h = mid;
    } else {
      l = mid;
      fl = fm;
    }
  }
  return (l + h) / 2;
}

function solveFlatSpeedForPower(params: CyclistParams): number {
  const a = aerodynamicCoeff(params);
  const b0 = linearCoeff(0, params);

  const power = (v: number) => equilibriumPowerFromCoeffs(v, a, b0);
  let lo = 0;
  let hi = Math.max(params.vMin, 1);

  while (power(hi) < params.flatPower && hi < SPEED_SEARCH_MAX) {
    hi *= 2;
  }

  hi = Math.min(hi, SPEED_SEARCH_MAX);

  return bisectRoot((v) => power(v) - params.flatPower, lo, hi);
}

function solveOptimalSpeedForGrade(
  params: CyclistParams,
  grade: number,
  c: number,
): number {
  const a = aerodynamicCoeff(params);
  const b = linearCoeff(grade, params);

  const f = (v: number) => costResidual(v, a, b, c);
  const p = (v: number) => equilibriumPowerFromCoeffs(v, a, b);

  // When b < 0, the equilibrium power polynomial has a minimum at v = sqrt(-b/a).
  // The optimal speed must be to the right of this point (and have positive power).
  const lo = (b < 0 ? Math.sqrt(-b / a) : 0) + 1e-6;

  let hi = Math.max(params.vMin, lo + 1);
  while (f(hi) <= 0 && hi < SPEED_SEARCH_MAX) {
    hi *= 2;
  }

  hi = Math.min(hi, SPEED_SEARCH_MAX);

  const scanCount = 512;
  const roots: number[] = [];

  let prevV = lo;
  let prevF = f(prevV);

  for (let i = 1; i <= scanCount; i++) {
    const v = lo + ((hi - lo) * i) / scanCount;
    const fv = f(v);

    if (prevF === 0) {
      roots.push(prevV);
    } else if (fv === 0) {
      roots.push(v);
    } else if (prevF * fv < 0) {
      roots.push(bisectRoot(f, prevV, v));
    }

    prevV = v;
    prevF = fv;
  }

  const validRoots = roots.filter((v) => p(v) > 0);
  if (validRoots.length === 0) {
    return params.vMin;
  }
  return Math.max(...validRoots);
}

/**
 * Compute the assumed speed for each grade bin.
 *
 * @param params Cyclist parameters (including flat-road power P_0)
 * @param grades  Grade bins in percent (defaults to -30..30 in 0.1% steps)
 * @returns Map from grade (%) to assumed speed (m/s)
 */
export function computeAssumedSpeeds(
  params: CyclistParams,
  grades: number[] = DEFAULT_GRADE_BINS,
): Map<number, number> {
  const a = aerodynamicCoeff(params);
  const b0 = linearCoeff(0, params);
  const v0 = solveFlatSpeedForPower(params);
  const c = (11 * a * v0 * v0 + 3 * b0) * Math.pow(a * v0 * v0 + b0, 3) * Math.pow(v0, 4);

  const result = new Map<number, number>();
  for (const grade of grades) {
    const vOp = solveOptimalSpeedForGrade(params, grade, c);
    const vEst = Math.max(params.vMin, vOp);
    result.set(grade, vEst);
  }
  return result;
}
