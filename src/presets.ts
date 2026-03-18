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
 * FTP levels (W/kg × body mass 60 kg; PWR is defined against body mass, not total mass):
 *   Beginner:     2.0 W/kg → 120 W
 *   Intermediate: 3.0 W/kg → 180 W
 *   Advanced:     4.0 W/kg → 240 W
 *
 * Cruise power: 65% of FTP (mid-point of 60–70% range stated in the spec).
 *
 * Speed limits:
 *   vMin: 4 km/h = 1.11 m/s  (minimum speed on steep climbs)
 *   vMax: 40 km/h = 11.11 m/s (maximum coasting speed)
 */

import type { CyclistParams, CyclistLevel } from "./types";

const BODY_MASS = 60;  // kg (body weight only; used for PWR / FTP calculation)
const BIKE_MASS = 8;   // kg

const BASE_PARAMS = {
  mass: BODY_MASS + BIKE_MASS,  // total physical mass for force calculations
  Crr: 0.004,
  CdA: 0.32,
  rho: 1.2,
  eta: 0.97,
  cruisePowerFraction: 0.65,
  vMin: 4 / 3.6,   // 4 km/h → m/s
  vMax: 40 / 3.6,  // 40 km/h → m/s
};

export const CYCLIST_PRESETS: Record<CyclistLevel, CyclistParams> = {
  beginner: {
    ...BASE_PARAMS,
    ftp: 2.0 * BODY_MASS,  // 2.0 W/kg × body mass → 120 W
  },
  intermediate: {
    ...BASE_PARAMS,
    ftp: 3.0 * BODY_MASS,  // 3.0 W/kg × body mass → 180 W
  },
  advanced: {
    ...BASE_PARAMS,
    ftp: 4.0 * BODY_MASS,  // 4.0 W/kg × body mass → 240 W
  },
};
