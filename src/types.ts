/**
 * Types and constants for the Normalized Flat Distance (NFD) project.
 */

/** Gravitational acceleration (m/s²) */
export const G = 9.81;

/** Air density at sea level, 20°C (kg/m³) */
export const AIR_DENSITY = 1.2;

/**
 * Physical parameters for a cyclist and their bicycle.
 * Based on Martin et al. (1998) cycling power model.
 */
export interface CyclistParams {
  /** Total mass of cyclist + bicycle (kg) */
  mass: number;
  /** Rolling resistance coefficient (dimensionless) */
  Crr: number;
  /** Product of drag coefficient and frontal area, CdA (m²) */
  CdA: number;
  /** Air density (kg/m³) */
  rho: number;
  /** Drivetrain efficiency (0–1) */
  eta: number;
  /** Flat-road power P_0 (W): reference power at 0% grade */
  flatPower: number;
  /** Minimum allowed speed (m/s) */
  vMin: number;
}

/** Cyclist level presets */
export type CyclistLevel = "beginner" | "intermediate" | "advanced" | "pro";

/**
 * A section of a cycling course: horizontal distance and gradient.
 */
export interface CourseSection {
  /** Horizontal distance (m) */
  distance: number;
  /** Gradient (%, e.g. 5 for 5%) */
  grade: number;
}

/**
 * A look-up table mapping grade (%) to NFD coefficient.
 */
export type NfdLut = Map<number, number>;
