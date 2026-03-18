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
 * Mass: ~70 kg cyclist + ~8 kg bicycle = 78 kg total.
 * CdA:  0.32 m² (drops position on road bike)
 * Crr:  0.004 (road bike on paved road)
 * eta:  0.97 (drivetrain efficiency)
 *
 * FTP levels (W/kg × 78 kg):
 *   Beginner:     2.0 W/kg → 156 W
 *   Intermediate: 3.0 W/kg → 234 W
 *   Advanced:     4.0 W/kg → 312 W
 *
 * Cruise power: 65% of FTP (mid-point of 60–70% range stated in the spec).
 *
 * Speed limits:
 *   vMin: 4 km/h = 1.11 m/s  (minimum speed on steep climbs)
 *   vMax: 35 km/h = 9.72 m/s (maximum coasting speed; set conservatively)
 */

import type { CyclistParams, CyclistLevel } from "./types";

const BASE_PARAMS = {
  mass: 78,
  Crr: 0.004,
  CdA: 0.32,
  rho: 1.2,
  eta: 0.97,
  cruisePowerFraction: 0.65,
  vMin: 4 / 3.6,   // 4 km/h → m/s
  vMax: 35 / 3.6,  // 35 km/h → m/s
};

export const CYCLIST_PRESETS: Record<CyclistLevel, CyclistParams> = {
  beginner: {
    ...BASE_PARAMS,
    ftp: 156,  // 2.0 W/kg × 78 kg
    vMax: 30 / 3.6,  // Beginners tend to brake earlier on descents
  },
  intermediate: {
    ...BASE_PARAMS,
    ftp: 234,  // 3.0 W/kg × 78 kg
    vMax: 35 / 3.6,
  },
  advanced: {
    ...BASE_PARAMS,
    ftp: 312,  // 4.0 W/kg × 78 kg
    vMax: 40 / 3.6,  // Advanced riders are comfortable at higher descent speeds
  },
};
