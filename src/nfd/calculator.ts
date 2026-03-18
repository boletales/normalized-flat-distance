/**
 * Normalized Flat Distance (NFD) calculator.
 *
 * The NFD of a course is the equivalent flat-road distance that an
 * "assumed cyclist" would find equally difficult (in terms of Normalized
 * Power × time) as riding the actual course.
 *
 * ## Computation
 *
 * For each section of the course with horizontal distance d_i and gradient n_i:
 *
 *   NFD = Σ_i  d_i · c(n_i)
 *
 * where c(n) is the NFD coefficient from the LUT.  For gradients not
 * present in the LUT, linear interpolation between the two nearest entries
 * is used.
 *
 * ## Additive property
 *
 * Because the formula is a sum over sections, NFD is additive: the NFD of a
 * combined course equals the sum of the NFDs of its sub-courses.
 */

import type { CourseSection, NfdLut } from "../types";

/**
 * Interpolate the NFD coefficient for a given grade from the LUT.
 * Linear interpolation between the two nearest grade bins.
 *
 * @param grade Gradient in %
 * @param lut   NFD coefficient LUT
 * @returns Interpolated NFD coefficient
 */
export function interpolateCoefficient(grade: number, lut: NfdLut): number {
  const grades = Array.from(lut.keys()).sort((a, b) => a - b);

  // Exact match
  if (lut.has(grade)) return lut.get(grade) as number;

  // Below minimum
  const first = grades[0];
  if (first === undefined || grade <= first) {
    const c = lut.get(first ?? 0);
    return c ?? 1;
  }

  // Above maximum
  const last = grades[grades.length - 1];
  if (last === undefined || grade >= last) {
    const c = lut.get(last ?? 0);
    return c ?? 1;
  }

  // Find surrounding grades for linear interpolation
  let lo = first;
  let hi = last;
  for (const g of grades) {
    if (g <= grade) lo = g;
    if (g >= grade && g < hi) hi = g;
  }

  const cLo = lut.get(lo) as number;
  const cHi = lut.get(hi) as number;
  const t = (grade - lo) / (hi - lo);
  return cLo + t * (cHi - cLo);
}

/**
 * Compute the Normalized Flat Distance (NFD) for a course.
 *
 * @param sections Array of course sections (distance in m, grade in %)
 * @param lut      NFD coefficient LUT
 * @returns NFD in metres (same unit as input distances)
 */
export function computeNfd(sections: CourseSection[], lut: NfdLut): number {
  return sections.reduce((total, { distance, grade }) => {
    const coefficient = interpolateCoefficient(grade, lut);
    return total + distance * coefficient;
  }, 0);
}

/**
 * Compute NFD in kilometres.
 *
 * @param sections Array of course sections (distance in m, grade in %)
 * @param lut      NFD coefficient LUT
 * @returns NFD in km
 */
export function computeNfdKm(sections: CourseSection[], lut: NfdLut): number {
  return computeNfd(sections, lut) / 1000;
}
