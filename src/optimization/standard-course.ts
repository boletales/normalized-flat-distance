/**
 * Standard course gradient distribution.
 *
 * The "standard course" is a conceptual infinite course whose gradient
 * distribution represents typical Japanese cycling roads (national roads
 * and prefectural roads). It is used to derive the per-gradient "assumed
 * speed" for a cyclist.
 *
 * TODO: Replace the placeholder distribution below with one derived from
 * actual OSM + DEM road data once the statistics collection tool is built.
 *
 * Current placeholder: a discretised normal-ish distribution centred on
 * 0% grade, symmetric, covering -15% to +15%, reflecting a mildly hilly
 * course. The distribution is normalised so that frequencies sum to 1.
 */

import type { GradeFrequency } from "../types";

/**
 * Discrete grade bins and their relative frequencies for the standard course.
 * Grade is in percent; frequency is a non-negative weight (need not sum to 1
 * but must be strictly positive for at least the 0% bin).
 */
export const STANDARD_COURSE_DISTRIBUTION: GradeFrequency[] = (() => {
  // Approximate distribution: mostly flat, with exponentially decaying
  // frequency at higher absolute gradients.
  const grades = [];
  for (let g = -15; g <= 15; g++) {
    // Use a Laplace-like distribution: weight ∝ exp(-|g| / 4)
    const weight = Math.exp(-Math.abs(g) / 4);
    grades.push({ grade: g, frequency: weight });
  }
  // Normalise
  const total = grades.reduce((s, x) => s + x.frequency, 0);
  return grades.map((x) => ({ grade: x.grade, frequency: x.frequency / total }));
})();
