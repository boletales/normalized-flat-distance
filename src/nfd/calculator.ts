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

const LUT_GRADE_EPSILON = 1e-9;

interface LutGradeGrid {
  keys: number[];
  min: number;
  max: number;
  step: number;
}

const lutGradeGridCache = new WeakMap<NfdLut, LutGradeGrid>();

function tryBuildArithmeticGrid(lut: NfdLut): LutGradeGrid | undefined {
  const keys = Array.from(lut.keys()).sort((a, b) => a - b);
  if (keys.length < 2) {
    return undefined;
  }

  const min = keys[0] as number;
  const second = keys[1] as number;
  const step = second - min;
  if (!(step > 0)) {
    return undefined;
  }

  for (let i = 2; i < keys.length; i += 1) {
    const prev = keys[i - 1] as number;
    const current = keys[i] as number;
    const delta = current - prev;
    if (!(delta > 0) || Math.abs(delta - step) > LUT_GRADE_EPSILON) {
      return undefined;
    }
  }

  return {
    keys,
    min,
    max: keys[keys.length - 1] as number,
    step,
  };
}

function getLutGradeGrid(lut: NfdLut): LutGradeGrid | undefined {
  const cached = lutGradeGridCache.get(lut);
  if (cached) {
    return cached;
  }

  const grid = tryBuildArithmeticGrid(lut);
  if (grid) {
    lutGradeGridCache.set(lut, grid);
  }
  return grid;
}

/**
 * Interpolate the NFD coefficient for a given grade from the LUT.
 * Linear interpolation between the two nearest grade bins.
 *
 * @param grade Gradient in %
 * @param lut   NFD coefficient LUT
 * @returns Interpolated NFD coefficient
 */
export function interpolateCoefficient(grade: number, lut: NfdLut): number {
  if (lut.size === 0) {
    return 1;
  }

  // Exact match
  if (lut.has(grade)) return lut.get(grade) as number;

  const grid = getLutGradeGrid(lut);
  if (grid) {
    const { keys, min, max, step } = grid;
    if (grade <= min) {
      return lut.get(keys[0] as number) ?? 1;
    }
    if (grade >= max) {
      return lut.get(keys[keys.length - 1] as number) ?? 1;
    }

    const ratio = (grade - min) / step;
    const loIndex = Math.floor(ratio + LUT_GRADE_EPSILON);
    const hiIndex = Math.min(keys.length - 1, loIndex + 1);
    const loKey = keys[loIndex] as number;
    const hiKey = keys[hiIndex] as number;

    if (loKey === hiKey) {
      return lut.get(loKey) ?? 1;
    }

    const cLo = lut.get(loKey) ?? 1;
    const cHi = lut.get(hiKey) ?? cLo;
    const t = (grade - loKey) / (hiKey - loKey);
    return cLo + t * (cHi - cLo);
  }

  const grades = Array.from(lut.keys()).sort((a, b) => a - b);

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
    if (g >= grade) {
      hi = g;
      break;
    }
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
