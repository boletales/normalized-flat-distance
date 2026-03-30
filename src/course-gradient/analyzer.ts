import type { NfdLut } from "../types";
import { interpolateCoefficient } from "../nfd/calculator";
import {
  interpolateElevation,
  savitzkyGolaySmooth,
  type ElevationPoint,
} from "../optimization/smoothing";

/** Geographic coordinate in WGS84. */
export interface GeoPoint {
  lat: number;
  lon: number;
  /**
   * If true, DEM elevation at this point is ignored and replaced by
   * linear interpolation between non-masked endpoints.
   *
   * Intended for tunnel/bridge sections where surface DEM is not suitable.
   */
  interpolateElevation?: boolean;
}

/** Elevation source abstraction. */
export interface ElevationProvider {
  getElevation(point: GeoPoint): Promise<number>;
}

/** One sampled point on an analyzed route profile. */
export interface RouteProfilePoint extends GeoPoint {
  /** Raw elevation for display/debug (m). Tunnel/bridge masked points are interpolated. */
  rawElevation: number;
  /** Raw DEM elevation returned by provider before interpolation (m). */
  demElevation?: number;
  /** Smoothed elevation used for grade computation (m) */
  elevation: number;
  /** Cumulative horizontal distance from route start (m) */
  distanceFromStart: number;
  /** Elevation source used for this point */
  elevationSource: "dem" | "interpolated";
}

/** Options for route grade analysis. */
export interface CourseGradientBuildOptions {
  /**
   * If true, use Savitzky-Golay smoothing with interpolation.
   * This provides better gradient smoothing via polynomial fitting.
   */
  useSavitzkyGolay?: boolean;
  /**
    * Interpolation interval for Savitzky-Golay smoothing in meters (default: 20).
   */
  savitzkyGolayInterval?: number;
  /**
   * Savitzky-Golay window size (odd number, e.g. 5, 7, 9, 11).
   */
  savitzkyGolayWindowSize?: number;
  /**
   * Savitzky-Golay polynomial order (2 or 3).
   */
  savitzkyGolayPolynomialOrder?: 2 | 3;
  /** Clamp absolute grade (%) to suppress extreme spikes from noisy data. */
  maxAbsGrade?: number;
}

/** Result of route analysis. */
export interface CourseGradientResult {
  profile: RouteProfilePoint[];
}

/** Combined result for grade analysis + NFD conversion. */
export interface NfdFromWaypointsResult extends CourseGradientResult {
  nfdMeters: number;
  nfdKm: number;
}

const EARTH_RADIUS_METERS = 6371000;

/**
 * Haversine distance between two coordinates on Earth.
 */
export function haversineDistanceMeters(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

/**
 * Smooth elevations using Savitzky-Golay filter with linear interpolation.
 *
 * This method:
 * 1. Interpolates elevations at regular intervals using linear interpolation
 * 2. Applies Savitzky-Golay smoothing (polynomial fitting) to the interpolated data
 * 3. Re-samples the smoothed elevations back to the original waypoint distances
 *
 * @param elevations - Array of elevation values at waypoints (m)
 * @param distancesFromStart - Cumulative distances from route start (m)
 * @param interpolationInterval - Interpolation interval in meters (default: 20m)
 * @returns Smoothed elevation array
 */
export function smoothElevationsWithSavitzkyGolay(
  elevations: number[],
  distancesFromStart: number[],
  interpolationInterval: number = 20,
  windowSize: number = 11,
  polynomialOrder: 2 | 3 = 3,
): number[] {
  if (
    elevations.length <= 2
    || elevations.length !== distancesFromStart.length
  ) {
    return [...elevations];
  }

  // Create elevation points from the data
  const elevationPoints: ElevationPoint[] = elevations.map((elev, idx) => ({
    distance: distancesFromStart[idx] as number,
    elevation: elev as number,
  }));

  // Interpolate at regular intervals
  const interpolated = interpolateElevation(elevationPoints, interpolationInterval);

  if (interpolated.length < 2) {
    return [...elevations];
  }

  const firstInterpolated = interpolated[0];
  const lastInterpolated = interpolated[interpolated.length - 1];
  if (!firstInterpolated || !lastInterpolated) {
    return [...elevations];
  }

  // Add one guard point on both sides to stabilize edge behavior.
  // Example (interval=20): -20 and 1620 for a [0..1600] regularized range.
  const paddedInterpolated: ElevationPoint[] = [
    {
      distance: firstInterpolated.distance - interpolationInterval,
      elevation: firstInterpolated.elevation,
    },
    ...interpolated,
    {
      distance: lastInterpolated.distance + interpolationInterval,
      elevation: lastInterpolated.elevation,
    },
  ];

  // Apply Savitzky-Golay smoothing
  const paddedInterpolatedElevs = paddedInterpolated.map((p) => p.elevation);
  const paddedSmoothed = savitzkyGolaySmooth(
    paddedInterpolatedElevs,
    windowSize,
    polynomialOrder,
  );

  // Remove guard points from the smoothed series so it aligns with `interpolated`.
  const smoothed = paddedSmoothed.slice(1, paddedSmoothed.length - 1);

  // Re-sample back to original waypoint distances
  const result: number[] = [];
  for (let i = 0; i < elevations.length; i += 1) {
    const targetDist = distancesFromStart[i] as number;

    // Find the two interpolated points surrounding this distance
    let foundValue: number | null = null;

    for (let j = 0; j < paddedInterpolated.length - 1; j += 1) {
      const p0 = paddedInterpolated[j];
      const p1 = paddedInterpolated[j + 1];

      if (
        p0 && p1
        && targetDist >= p0.distance
        && targetDist <= p1.distance
      ) {
        // Linear interpolation between smoothed points
        const t = (targetDist - p0.distance) / (p1.distance - p0.distance);
        const s0 = paddedSmoothed[j] as number;
        const s1 = paddedSmoothed[j + 1] as number;
        foundValue = s0 + t * (s1 - s0);
        break;
      }
    }

    // Fallback: use nearest original elevation if interpolation fails
    result.push(foundValue ?? (elevations[i] as number));
  }

  return result;
}

/**
 * Apply linear interpolation for masked points using nearest unmasked
 * endpoints on both sides.
 */
export function interpolateMaskedElevations(
  elevations: number[],
  mask: boolean[],
): { elevations: number[]; interpolatedMask: boolean[] } {
  const n = elevations.length;
  const result = [...elevations];
  const interpolatedMask = new Array<boolean>(n).fill(false);

  let i = 0;
  while (i < n) {
    if (!mask[i]) {
      i += 1;
      continue;
    }

    const start = i;
    while (i < n && mask[i]) {
      i += 1;
    }
    const end = i - 1;

    const left = start - 1;
    const right = i;

    if (left < 0 || right >= n) {
      // cannot interpolate without both endpoints
      continue;
    }

    const leftValue = result[left];
    const rightValue = result[right];
    if (
      typeof leftValue !== "number"
      || typeof rightValue !== "number"
      || !Number.isFinite(leftValue)
      || !Number.isFinite(rightValue)
    ) {
      continue;
    }

    const span = right - left;
    for (let j = start; j <= end; j += 1) {
      const t = (j - left) / span;
      result[j] = leftValue + t * (rightValue - leftValue);
      interpolatedMask[j] = true;
    }
  }

  return { elevations: result, interpolatedMask };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computeNfdFromProfile(
  profile: RouteProfilePoint[],
  lut: NfdLut,
  maxAbsGrade: number,
): number {
  let total = 0;
  for (let i = 1; i < profile.length; i += 1) {
    const prev = profile[i - 1];
    const curr = profile[i];
    if (!prev || !curr) {
      continue;
    }

    const distance = curr.distanceFromStart - prev.distanceFromStart;
    if (distance <= 0) {
      continue;
    }

    const rawGrade = ((curr.elevation - prev.elevation) / distance) * 100;
    const grade = clamp(rawGrade, -maxAbsGrade, maxAbsGrade);
    const coeff = interpolateCoefficient(grade, lut);
    total += distance * coeff;
  }

  return total;
}

/**
 * Convert waypoints to a smoothed grade profile.
 *
 * Process:
 * 1. Exclude waypoints marked with `interpolateElevation = true` (tunnel/bridge points).
 * 2. Get elevations for valid waypoints only.
 * 3. Apply Savitzky-Golay smoothing at regular intervals.
 * 4. Return regular-interval profile (not resampled to original waypoint positions).
 */
export async function buildCourseProfileFromWaypoints(
  waypoints: GeoPoint[],
  elevationProvider: ElevationProvider,
  options: CourseGradientBuildOptions = {},
): Promise<CourseGradientResult> {
  if (waypoints.length === 0) {
    return { profile: [] };
  }

  // Step 1: Filter out waypoints marked for exclusion (tunnel/bridge points).
  const validIndices: number[] = [];
  const validWaypoints: GeoPoint[] = [];
  for (let i = 0; i < waypoints.length; i += 1) {
    const wp = waypoints[i];
    // Exclude if interpolateElevation is explicitly true
    if (wp && wp.interpolateElevation !== true) {
      validIndices.push(i);
      validWaypoints.push(wp);
    }
  }

  // If fewer than 2 valid waypoints remain, return empty profile.
  if (validWaypoints.length < 2) {
    return { profile: [] };
  }

  // Step 2: Compute cumulative distances for valid waypoints.
  const distancesFromStart = new Array<number>(validWaypoints.length).fill(0);
  let cumulativeDistance = 0;
  for (let i = 1; i < validWaypoints.length; i += 1) {
    const prev = validWaypoints[i - 1];
    const curr = validWaypoints[i];
    if (prev === undefined || curr === undefined) {
      continue;
    }
    cumulativeDistance += haversineDistanceMeters(prev, curr);
    distancesFromStart[i] = cumulativeDistance;
  }

  // Step 3: Fetch elevations for valid waypoints.
  const rawElevations = await Promise.all(
    validWaypoints.map((point) => elevationProvider.getElevation(point)),
  );

  // Step 4: Apply Savitzky-Golay smoothing to get regular-interval profile.
  const {
    savitzkyGolayInterval = 20,
    savitzkyGolayWindowSize = 11,
    savitzkyGolayPolynomialOrder = 3,
  } = options;

  const profile = buildRegularIntervalProfile(
    validWaypoints,
    rawElevations,
    distancesFromStart,
    savitzkyGolayInterval,
    savitzkyGolayWindowSize,
    savitzkyGolayPolynomialOrder,
  );

  return { profile };
}

/**
 * Build a profile at regular distance intervals from smoothed elevations.
 *
 * - Interpolates elevations at regular intervals.
 * - Applies Savitzky-Golay smoothing.
 * - Returns profile points at regular intervals (no resampling to original waypoints).
 */
function buildRegularIntervalProfile(
  waypoints: GeoPoint[],
  elevations: number[],
  distancesFromStart: number[],
  interval: number,
  windowSize: number,
  polynomialOrder: 2 | 3,
): RouteProfilePoint[] {
  if (waypoints.length === 0 || elevations.length === 0) {
    return [];
  }

  // Apply Savitzky-Golay smoothing with regular interpolation.
  const interpolatedElevations = interpolateElevationAtRegularIntervals(
    elevations,
    distancesFromStart,
    interval,
  );

  if (interpolatedElevations.length === 0) {
    return [];
  }

  // Apply Savitzky-Golay filter to smoothed data.
  const smoothedElevations = savitzkyGolaySmooth(
    interpolatedElevations.map((p) => p.elevation),
    windowSize,
    polynomialOrder,
  );

  // Build profile from regular-interval points.
  const profile: RouteProfilePoint[] = [];
  const maxDistance = distancesFromStart[distancesFromStart.length - 1] ?? 0;

  // Find first and last waypoint for interpolation.
  const firstWaypoint = waypoints[0];
  const lastWaypoint = waypoints[waypoints.length - 1];

  if (!firstWaypoint || !lastWaypoint) {
    return [];
  }

  // Generate profile points at regular intervals.
  for (let i = 0; i < interpolatedElevations.length; i += 1) {
    const distPoint = interpolatedElevations[i];
    const smoothedElev = smoothedElevations[i];

    if (distPoint === undefined || smoothedElev === undefined) {
      continue;
    }

    // Interpolate lat/lon at this distance.
    let interpolatedLat = firstWaypoint.lat;
    let interpolatedLon = firstWaypoint.lon;

    for (let j = 0; j < waypoints.length - 1; j += 1) {
      const wpStart = waypoints[j];
      const wpEnd = waypoints[j + 1];
      const distStart = distancesFromStart[j] ?? 0;
      const distEnd = distancesFromStart[j + 1] ?? 0;

      if (
        wpStart
        && wpEnd
        && distPoint.distance >= distStart
        && distPoint.distance <= distEnd
      ) {
        const t = distEnd > distStart ? (distPoint.distance - distStart) / (distEnd - distStart) : 0;
        interpolatedLat = wpStart.lat + t * (wpEnd.lat - wpStart.lat);
        interpolatedLon = wpStart.lon + t * (wpEnd.lon - wpStart.lon);
        break;
      }
    }

    profile.push({
      lat: interpolatedLat,
      lon: interpolatedLon,
      rawElevation: distPoint.elevation,
      demElevation: distPoint.elevation,
      elevation: smoothedElev,
      distanceFromStart: distPoint.distance,
      elevationSource: "dem",
    });
  }

  return profile;
}

/**
 * Interpolate elevations at regular distance intervals.
 *
 * Returns an array of `{distance, elevation}` pairs at regular intervals.
 */
function interpolateElevationAtRegularIntervals(
  elevations: number[],
  distancesFromStart: number[],
  interval: number,
): Array<{ distance: number; elevation: number }> {
  if (elevations.length === 0 || distancesFromStart.length === 0) {
    return [];
  }

  const maxDistance = distancesFromStart[distancesFromStart.length - 1] ?? 0;
  const result: Array<{ distance: number; elevation: number }> = [];

  for (let dist = 0; dist <= maxDistance; dist += interval) {
    // Find surrounding elevation points.
    let elevBefore: number | undefined;
    let elevAfter: number | undefined;
    let distBefore = 0;
    let distAfter = maxDistance;

    for (let i = 0; i < distancesFromStart.length; i += 1) {
      const d = distancesFromStart[i];
      const e = elevations[i];

      if (d !== undefined && e !== undefined) {
        if (d <= dist && d > distBefore) {
          distBefore = d;
          elevBefore = e;
        }
        if (d >= dist && d < distAfter) {
          distAfter = d;
          elevAfter = e;
        }
      }
    }

    // Interpolate elevation.
    let interpolatedElev: number;
    if (elevBefore !== undefined && elevAfter !== undefined) {
      const t = distAfter > distBefore ? (dist - distBefore) / (distAfter - distBefore) : 0;
      interpolatedElev = elevBefore + t * (elevAfter - elevBefore);
    } else if (elevBefore !== undefined) {
      interpolatedElev = elevBefore;
    } else if (elevAfter !== undefined) {
      interpolatedElev = elevAfter;
    } else {
      continue; // Skip if no elevation data.
    }

    result.push({ distance: dist, elevation: interpolatedElev });
  }

  return result;
}

/**
 * Convenience helper: waypoint route -> profile -> NFD.
 */
export async function computeNfdFromWaypoints(
  waypoints: GeoPoint[],
  elevationProvider: ElevationProvider,
  lut: NfdLut,
  options: CourseGradientBuildOptions = {},
): Promise<NfdFromWaypointsResult> {
  const { profile } = await buildCourseProfileFromWaypoints(
    waypoints,
    elevationProvider,
    options,
  );

  const maxAbsGrade = options.maxAbsGrade ?? 30;
  const nfdMeters = computeNfdFromProfile(profile, lut, maxAbsGrade);

  return {
    profile,
    nfdMeters,
    nfdKm: nfdMeters / 1000,
  };
}

/**
 * Cache options for coordinate-based elevation memoization.
 */
export interface CachedElevationProviderOptions {
  /** Coordinate rounding digits used for cache keys. */
  precision?: number;
  /** Time-to-live for each cache entry (ms). */
  ttlMs?: number;
  /** Maximum number of cache entries kept in memory. */
  maxEntries?: number;
}

interface ElevationCacheEntry {
  value: number;
  expiresAt: number;
}

interface DemTile {
  values: Float64Array;
}

interface DemTileCacheEntry {
  tile: DemTile | null;
  expiresAt: number;
}

type PngRgbaDecoder = (blob: Blob) => Promise<Uint8ClampedArray>;

const DEM_TILE_SIZE = 256;

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function lonToTileX(lon: number, zoom: number): number {
  const n = 2 ** zoom;
  return ((lon + 180) / 360) * n;
}

function latToTileY(lat: number, zoom: number): number {
  const n = 2 ** zoom;
  const latClamped = clamp(lat, -85.05112878, 85.05112878);
  const latRad = (latClamped * Math.PI) / 180;
  return (
    (1 - Math.log(Math.tan(latRad) + (1 / Math.cos(latRad))) / Math.PI)
    / 2
  ) * n;
}

function demValueAt(tile: DemTile, x: number, y: number): number | undefined {
  if (x < 0 || x >= DEM_TILE_SIZE || y < 0 || y >= DEM_TILE_SIZE) {
    return undefined;
  }

  const value = tile.values[y * DEM_TILE_SIZE + x];
  return Number.isFinite(value) ? value : undefined;
}

function findNearestFiniteDemValue(
  tile: DemTile,
  x: number,
  y: number,
  maxRadius = 2,
): number | undefined {
  const direct = demValueAt(tile, x, y);
  if (direct !== undefined) {
    return direct;
  }

  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) {
          continue;
        }

        const v = demValueAt(tile, x + dx, y + dy);
        if (v !== undefined) {
          return v;
        }
      }
    }
  }

  return undefined;
}

const DEM_PNG_EXPONENT_23 = 2 ** 23;
const DEM_PNG_EXPONENT_24 = 2 ** 24;
const DEM_PNG_RESOLUTION = 0.01;

/**
 * Parse a GSI DEM PNG RGBA buffer into fixed 256x256 numeric raster.
 *
 * Pixel format follows GSI DEM PNG spec:
 * - x = 2^16 * R + 2^8 * G + B
 * - x < 2^23: h = x * 0.01
 * - x = 2^23: no-data
 * - x > 2^23: h = (x - 2^24) * 0.01
 *
 * No-data marker color (128,0,0) is also treated as NaN.
 */
export function parseGsiDemPngRgbaTile(rgba: Uint8ClampedArray): DemTile {
  const requiredLength = DEM_TILE_SIZE * DEM_TILE_SIZE * 4;
  if (rgba.length < requiredLength) {
    throw new Error(`Invalid DEM PNG RGBA length: ${rgba.length}`);
  }

  const values = new Float64Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
  values.fill(Number.NaN);

  for (let i = 0; i < DEM_TILE_SIZE * DEM_TILE_SIZE; i += 1) {
    const offset = i * 4;
    const r = rgba[offset] as number;
    const g = rgba[offset + 1] as number;
    const b = rgba[offset + 2] as number;

    if (r === 128 && g === 0 && b === 0) {
      continue;
    }

    const x = (r * 65536) + (g * 256) + b;
    if (x === DEM_PNG_EXPONENT_23) {
      continue;
    }

    const elevation = x < DEM_PNG_EXPONENT_23
      ? x * DEM_PNG_RESOLUTION
      : (x - DEM_PNG_EXPONENT_24) * DEM_PNG_RESOLUTION;
    values[i] = elevation;
  }

  return { values };
}

async function defaultDecodeDemPngToRgba(blob: Blob): Promise<Uint8ClampedArray> {
  const globalLike = globalThis as {
    createImageBitmap?: (image: Blob) => Promise<unknown>;
    OffscreenCanvas?: new (width: number, height: number) => {
      getContext: (contextId: string) => {
        drawImage: (image: unknown, dx: number, dy: number) => void;
        getImageData: (sx: number, sy: number, sw: number, sh: number) => { data: Uint8ClampedArray };
      } | null;
    };
    document?: {
      createElement: (tagName: string) => {
        width: number;
        height: number;
        getContext: (contextId: string) => {
          drawImage: (image: unknown, dx: number, dy: number) => void;
          getImageData: (sx: number, sy: number, sw: number, sh: number) => { data: Uint8ClampedArray };
        } | null;
      };
    };
  };

  const createImageBitmapFn = globalLike.createImageBitmap;
  if (typeof createImageBitmapFn !== "function") {
    throw new Error("createImageBitmap is not available; provide decodePngRgba option");
  }

  const bitmap = await createImageBitmapFn(blob);

  const OffscreenCanvasCtor = globalLike.OffscreenCanvas;
  if (typeof OffscreenCanvasCtor === "function") {
    const canvas = new OffscreenCanvasCtor(DEM_TILE_SIZE, DEM_TILE_SIZE);
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      throw new Error("Failed to get 2d context from OffscreenCanvas");
    }
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, DEM_TILE_SIZE, DEM_TILE_SIZE).data;
  }

  const documentRef = globalLike.document;
  if (documentRef !== undefined) {
    const canvas = documentRef.createElement("canvas");
    canvas.width = DEM_TILE_SIZE;
    canvas.height = DEM_TILE_SIZE;
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      throw new Error("Failed to get 2d context from canvas");
    }
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, DEM_TILE_SIZE, DEM_TILE_SIZE).data;
  }

  throw new Error("No canvas implementation available; provide decodePngRgba option");
}

/**
 * A thin in-memory cache wrapper for any elevation provider.
 */
export class CachedElevationProvider implements ElevationProvider {
  private readonly cache = new Map<string, ElevationCacheEntry>();

  private readonly precision: number;

  private readonly ttlMs: number;

  private readonly maxEntries: number;

  constructor(
    private readonly baseProvider: ElevationProvider,
    options: CachedElevationProviderOptions = {},
  ) {
    this.precision = options.precision ?? 5;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 100000;
  }

  async getElevation(point: GeoPoint): Promise<number> {
    const key = this.cacheKey(point);
    const now = Date.now();

    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.value;
    }

    const value = await this.baseProvider.getElevation(point);
    this.cache.set(key, {
      value,
      expiresAt: now + this.ttlMs,
    });

    if (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }

    return value;
  }

  clearExpired(now = Date.now()): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
      }
    }
  }

  get size(): number {
    return this.cache.size;
  }

  private cacheKey(point: GeoPoint): string {
    const lat = point.lat.toFixed(this.precision);
    const lon = point.lon.toFixed(this.precision);
    return `${lat},${lon}`;
  }
}

/** Public DEM endpoint for GSI elevation API. */
export const DEFAULT_GSI_ELEVATION_ENDPOINT =
  "https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon={lon}&lat={lat}&outtype=JSON";

/**
 * Recommended DEM PNG tile templates in fallback order.
 */
export const DEFAULT_GSI_DEM_PNG_TILE_TEMPLATES = [
  "https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png",
  "https://cyberjapandata.gsi.go.jp/xyz/dem5b_png/{z}/{x}/{y}.png",
  "https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png",
] as const;

function isGsiDem10PngTemplate(template: string): boolean {
  return template.includes("/dem_png/{z}/") && !template.includes("/dem5");
}

/**
 * Options for PNG tile-based GSI DEM provider.
 */
export interface GsiDemPngTileElevationProviderOptions {
  zoom?: number;
  tileTemplates?: string[];
  cacheTtlMs?: number;
  maxTiles?: number;
  fetchFn?: typeof fetch;
  decodePngRgba?: PngRgbaDecoder;
  noDataTileSearchRadius?: number;
  noDataPixelSearchRadius?: number;
  noDataFallbackElevation?: number;
}

/**
 * Tile-based elevation provider using GSI DEM PNG tiles.
 *
 * Compared to text DEM, PNG avoids CSV parsing overhead and usually performs
 * better in browser runtimes.
 */
export class GsiDemPngTileElevationProvider implements ElevationProvider {
  private readonly zoom: number;

  private readonly tileTemplates: string[];

  private readonly cacheTtlMs: number;

  private readonly maxTiles: number;

  private readonly fetchFn: typeof fetch;

  private readonly decodePngRgba: PngRgbaDecoder;

  private readonly noDataTileSearchRadius: number;

  private readonly noDataPixelSearchRadius: number;

  private readonly noDataFallbackElevation: number | undefined;

  private readonly tileCache = new Map<string, DemTileCacheEntry>();

  private readonly inFlightTileRequests = new Map<string, Promise<DemTile | null>>();

  constructor(options: GsiDemPngTileElevationProviderOptions = {}) {
    this.zoom = options.zoom ?? 15;
    this.tileTemplates = options.tileTemplates ?? [...DEFAULT_GSI_DEM_PNG_TILE_TEMPLATES];
    this.cacheTtlMs = options.cacheTtlMs ?? 24 * 60 * 60 * 1000;
    this.maxTiles = options.maxTiles ?? 1024;
    this.fetchFn = options.fetchFn === undefined
      ? globalThis.fetch.bind(globalThis)
      : options.fetchFn.bind(globalThis);
    this.decodePngRgba = options.decodePngRgba ?? defaultDecodeDemPngToRgba;
    this.noDataTileSearchRadius = Math.max(0, Math.trunc(options.noDataTileSearchRadius ?? 2));
    this.noDataPixelSearchRadius = Math.max(0, Math.trunc(options.noDataPixelSearchRadius ?? 16));
    this.noDataFallbackElevation = options.noDataFallbackElevation;

    if (this.tileTemplates.length === 0) {
      throw new Error("At least one tile template is required");
    }
  }

  async getElevation(point: GeoPoint): Promise<number> {
    const availableTiles: Array<{
      template: string;
      templateZoom: number;
      tileX: number;
      tileY: number;
      pixelX: number;
      pixelY: number;
      tile: DemTile;
    }> = [];

    for (const template of this.tileTemplates) {
      const templateZoom = this.resolveTemplateZoom(template);
      const tileXFloat = lonToTileX(point.lon, templateZoom);
      const tileYFloat = latToTileY(point.lat, templateZoom);

      const n = 2 ** templateZoom;
      const tileX = clampInteger(Math.floor(tileXFloat), 0, n - 1);
      const tileY = clampInteger(Math.floor(tileYFloat), 0, n - 1);

      const pixelXFloat = (tileXFloat - tileX) * DEM_TILE_SIZE;
      const pixelYFloat = (tileYFloat - tileY) * DEM_TILE_SIZE;
      const pixelX = clampInteger(Math.floor(pixelXFloat), 0, DEM_TILE_SIZE - 1);
      const pixelY = clampInteger(Math.floor(pixelYFloat), 0, DEM_TILE_SIZE - 1);

      const tile = await this.getTile(template, templateZoom, tileX, tileY);
      if (tile === null) {
        continue;
      }

      availableTiles.push({
        template,
        templateZoom,
        tileX,
        tileY,
        pixelX,
        pixelY,
        tile,
      });

      const exact = demValueAt(tile, pixelX, pixelY);
      if (exact !== undefined) {
        return exact;
      }
    }

    for (const { tile, pixelX, pixelY } of availableTiles) {
      const value = findNearestFiniteDemValue(tile, pixelX, pixelY);
      if (value !== undefined) {
        return value;
      }
    }

    for (const {
      template,
      templateZoom,
      tileX,
      tileY,
      pixelX,
      pixelY,
    } of availableTiles) {
      const nearby = await this.findNearbyValueAcrossTiles(
        template,
        templateZoom,
        tileX,
        tileY,
        pixelX,
        pixelY,
      );
      if (nearby !== undefined) {
        return nearby;
      }
    }

    if (this.noDataFallbackElevation !== undefined) {
      return this.noDataFallbackElevation;
    }

    throw new Error(`No DEM value available for lat=${point.lat}, lon=${point.lon}`);
  }

  private async findNearbyValueAcrossTiles(
    template: string,
    zoom: number,
    baseTileX: number,
    baseTileY: number,
    basePixelX: number,
    basePixelY: number,
  ): Promise<number | undefined> {
    const n = 2 ** zoom;

    for (let tileRadius = 1; tileRadius <= this.noDataTileSearchRadius; tileRadius += 1) {
      for (let dy = -tileRadius; dy <= tileRadius; dy += 1) {
        for (let dx = -tileRadius; dx <= tileRadius; dx += 1) {
          if (Math.abs(dx) !== tileRadius && Math.abs(dy) !== tileRadius) {
            continue;
          }

          const tileX = baseTileX + dx;
          const tileY = baseTileY + dy;
          if (tileX < 0 || tileX >= n || tileY < 0 || tileY >= n) {
            continue;
          }

          const tile = await this.getTile(template, zoom, tileX, tileY);
          if (tile === null) {
            continue;
          }

          const candidatePixelX = clampInteger(
            basePixelX - dx * DEM_TILE_SIZE,
            0,
            DEM_TILE_SIZE - 1,
          );
          const candidatePixelY = clampInteger(
            basePixelY - dy * DEM_TILE_SIZE,
            0,
            DEM_TILE_SIZE - 1,
          );

          const value = findNearestFiniteDemValue(
            tile,
            candidatePixelX,
            candidatePixelY,
            this.noDataPixelSearchRadius,
          );
          if (value !== undefined) {
            return value;
          }
        }
      }
    }

    return undefined;
  }

  clearExpired(now = Date.now()): void {
    for (const [key, entry] of this.tileCache) {
      if (entry.expiresAt <= now) {
        this.tileCache.delete(key);
      }
    }
  }

  get size(): number {
    return this.tileCache.size;
  }

  private async getTile(
    template: string,
    zoom: number,
    tileX: number,
    tileY: number,
  ): Promise<DemTile | null> {
    const cacheKey = `${template}|${zoom}|${tileX}|${tileY}`;
    const now = Date.now();

    const cached = this.tileCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.tile;
    }

    const inFlight = this.inFlightTileRequests.get(cacheKey);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const requestPromise = this.fetchTileAndCache(cacheKey, template, zoom, tileX, tileY, now);
    this.inFlightTileRequests.set(cacheKey, requestPromise);

    try {
      return await requestPromise;
    } finally {
      this.inFlightTileRequests.delete(cacheKey);
    }
  }

  private async fetchTileAndCache(
    cacheKey: string,
    template: string,
    zoom: number,
    tileX: number,
    tileY: number,
    now: number,
  ): Promise<DemTile | null> {
    const url = template
      .replace("{z}", String(zoom))
      .replace("{x}", String(tileX))
      .replace("{y}", String(tileY));

    const response = await this.fetchFn(url, {
      headers: {
        Accept: "image/png",
      },
    });

    if (!response.ok) {
      this.putTileCache(cacheKey, null, now);
      return null;
    }

    const blob = await response.blob();
    const rgba = await this.decodePngRgba(blob);
    const tile = parseGsiDemPngRgbaTile(rgba);
    this.putTileCache(cacheKey, tile, now);
    return tile;
  }

  private resolveTemplateZoom(template: string): number {
    if (isGsiDem10PngTemplate(template)) {
      return Math.max(0, this.zoom - 1);
    }
    return this.zoom;
  }

  private putTileCache(key: string, tile: DemTile | null, now: number): void {
    this.tileCache.set(key, {
      tile,
      expiresAt: now + this.cacheTtlMs,
    });

    if (this.tileCache.size > this.maxTiles) {
      const oldest = this.tileCache.keys().next().value;
      if (oldest !== undefined) {
        this.tileCache.delete(oldest);
      }
    }
  }
}

/**
 * Elevation provider backed by GSI's public elevation API.
 *
 * @deprecated Prefer `GsiDemPngTileElevationProvider` for route analysis, because
 * it dramatically reduces request count by reusing tile data.
 */
export class GsiElevationProvider implements ElevationProvider {
  constructor(private readonly endpointTemplate = DEFAULT_GSI_ELEVATION_ENDPOINT) {}

  async getElevation(point: GeoPoint): Promise<number> {
    const url = this.endpointTemplate
      .replace("{lat}", encodeURIComponent(String(point.lat)))
      .replace("{lon}", encodeURIComponent(String(point.lon)));

    const response = await globalThis.fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch elevation: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as {
      elevation?: number | string;
    };

    const parsed = typeof body.elevation === "string"
      ? Number(body.elevation)
      : body.elevation;

    if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
      throw new Error("Invalid elevation response from GSI endpoint");
    }

    return parsed;
  }
}
