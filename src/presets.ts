/**
 * Default cyclist parameter presets for beginner, intermediate, and advanced levels.
 *
 * Physical model based on:
 *   Martin, J. C., Milliken, D. L., Cobb, J. E., McFadden, K. L., & Coggan, A. R. (1998).
 *   Validation of a Mathematical Model for Road Cycling Power.
 *   Journal of Applied Biomechanics, 14(3), 276–291.
 *   https://doi.org/10.1123/jab.14.3.276
 *
 * Assumed cyclist: Japanese male/female average body shape on a road bike.
 * Body mass: ~60 kg cyclist + ~8 kg bicycle = 68 kg total.
 * (Japanese male average ~67 kg, female average ~53 kg → midpoint ~60 kg)
 * CdA:  0.32 m² (drops position on road bike)
 * Crr:  0.004 (road bike on paved road)
 * eta:  0.97 (drivetrain efficiency)
 *
 * Flat-road reference power P0 presets:
 *   Beginner:     100 W
 *   Intermediate: 150 W
 *   Advanced:     200 W
 *   Pro:          250 W
 *
 * Practical speed constraint:
 *   vMin: 4 km/h = 1.11 m/s  (minimum speed on steep climbs)
 */

import type { CyclistParams, CyclistLevel } from "./types";

const BODY_MASS = 60;  // kg
const BIKE_MASS = 8;   // kg

const BASE_PARAMS = {
  mass: BODY_MASS + BIKE_MASS,  // total physical mass for force calculations
  Crr: 0.004,
  CdA: 0.32,
  rho: 1.2,
  eta: 0.97,
  vMin: 4 / 3.6,   // 4 km/h → m/s
};

export const CYCLIST_PRESETS: Record<CyclistLevel, CyclistParams> = {
  beginner: {
    ...BASE_PARAMS,
    flatPower: 100,
  },
  intermediate: {
    ...BASE_PARAMS,
    flatPower: 150,
  },
  advanced: {
    ...BASE_PARAMS,
    flatPower: 200,
  },
  pro: {
    ...BASE_PARAMS,
    flatPower: 250,
  },
};
