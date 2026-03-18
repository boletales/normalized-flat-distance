/**
 * Public API for the normalized-flat-distance package.
 */

export type {
  CyclistParams,
  CyclistLevel,
  CourseSection,
  NfdLut,
  GradeFrequency,
} from "./types";

export { G, AIR_DENSITY } from "./types";

export { CYCLIST_PRESETS } from "./presets";

export {
  equilibriumPower,
  speedForPower,
} from "./physics/power";

export {
  STANDARD_COURSE_DISTRIBUTION,
} from "./optimization/standard-course";

export {
  computeAssumedSpeeds,
} from "./optimization/assumed-speed";

export {
  loadFactor,
  buildNfdLut,
} from "./optimization/lut";

export {
  interpolateCoefficient,
  computeNfd,
  computeNfdKm,
} from "./nfd/calculator";
