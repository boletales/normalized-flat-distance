/**
 * Public API for the normalized-flat-distance package.
 */

export type {
  CyclistParams,
  CyclistLevel,
  CourseSection,
  NfdLut,
  NfdLutWithStats,
} from "./types";

export { G, AIR_DENSITY } from "./types";

export { CYCLIST_PRESETS, BIKE_TYPE_PRESETS } from "./presets";
export type { BikeType } from "./presets";

export {
  equilibriumPower,
  speedForPower,
} from "./physics/power";

export {
  DEFAULT_GRADE_BINS,
  computeAssumedSpeeds,
} from "./optimization/assumed-speed";

export {
  loadFactor,
  buildNfdLut,
  buildNfdLutWithStats,
  computeCourseTime,
  computeEstimatedNp,
  findClosestGradeBin,
} from "./optimization/lut";

export {
  interpolateCoefficient,
  computeNfd,
  computeNfdKm,
} from "./nfd/calculator";

export type {
  GeoPoint,
  ElevationProvider,
  RouteProfilePoint,
  CourseGradientBuildOptions,
  CourseGradientResult,
  NfdFromWaypointsResult,
  CachedElevationProviderOptions,
  GsiDemPngTileElevationProviderOptions,
} from "./course-gradient/analyzer";

export {
  haversineDistanceMeters,
  smoothElevationsWithSavitzkyGolay,
  parseGsiDemPngRgbaTile,
  buildCourseProfileFromWaypoints,
  computeNfdFromWaypoints,
  CachedElevationProvider,
  DEFAULT_GSI_ELEVATION_ENDPOINT,
  DEFAULT_GSI_DEM_PNG_TILE_TEMPLATES,
  GsiDemPngTileElevationProvider,
  GsiElevationProvider,
} from "./course-gradient/analyzer";

export type { ElevationPoint } from "./optimization/smoothing";

export {
  interpolateElevation,
  savitzkyGolaySmooth,
  smoothGradients,
} from "./optimization/smoothing";
