import type { CourseSection, NfdLut } from "../types";
import { computeNfd, computeNfdKm } from "../nfd/calculator";

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
   * Distance-based smoothing half-window in meters.
   * If set (> 0), this takes precedence over `smoothingWindow`.
   */
  smoothingDistanceMeters?: number;
  /** Moving-average window size for elevation smoothing. 1 disables smoothing. */
  smoothingWindow?: number;
  /**
   * Section length for grade computation (m).
   * Sections are created at fixed distance intervals independent of source
   * waypoint/OSM boundaries.
   */
  sectionLengthMeters?: number;
  /** Segments shorter than this are merged for grade estimation (m). */
  minimumDistance?: number;
  /** Clamp absolute grade (%) to suppress extreme spikes from noisy data. */
  maxAbsGrade?: number;
}

/** Result of route analysis. */
export interface CourseGradientResult {
  profile: RouteProfilePoint[];
  sections: CourseSection[];
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
 * Apply centered moving average to elevation samples.
 */
export function smoothElevations(
  elevations: number[],
  windowSize = 5,
): number[] {
  if (windowSize <= 1 || elevations.length <= 2) {
    return [...elevations];
  }

  const normalizedWindow = windowSize % 2 === 0 ? windowSize + 1 : windowSize;
  const radius = Math.floor(normalizedWindow / 2);

  return elevations.map((_, index) => {
    const start = Math.max(0, index - radius);
    const end = Math.min(elevations.length - 1, index + radius);

    let sum = 0;
    let count = 0;
    for (let i = start; i <= end; i += 1) {
      sum += elevations[i] as number;
      count += 1;
    }

    return sum / count;
  });
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const left = sorted[mid - 1] as number;
    const right = sorted[mid] as number;
    return (left + right) / 2;
  }
  return sorted[mid] as number;
}

/**
 * Smooth elevations in distance-elevation domain.
 *
 * The smoothing window is converted to a metric radius using median point
 * spacing, then centered averaging is applied with distance-based neighbors.
 */
export function smoothElevationsByDistance(
  elevations: number[],
  distancesFromStart: number[],
  windowSize = 5,
): number[] {
  if (
    windowSize <= 1
    || elevations.length <= 2
    || elevations.length !== distancesFromStart.length
  ) {
    return [...elevations];
  }

  const positiveSteps: number[] = [];
  for (let i = 1; i < distancesFromStart.length; i += 1) {
    const prev = distancesFromStart[i - 1];
    const curr = distancesFromStart[i];
    if (prev === undefined || curr === undefined) {
      continue;
    }
    const step = curr - prev;
    if (step > 0) {
      positiveSteps.push(step);
    }
  }

  const medianStep = median(positiveSteps);
  if (!Number.isFinite(medianStep) || medianStep <= 0) {
    return smoothElevations(elevations, windowSize);
  }

  const normalizedWindow = windowSize % 2 === 0 ? windowSize + 1 : windowSize;
  const halfWindowMeters = (normalizedWindow * medianStep) / 2;

  return elevations.map((_, index) => {
    const centerDistance = distancesFromStart[index];
    if (typeof centerDistance !== "number" || !Number.isFinite(centerDistance)) {
      return elevations[index] as number;
    }

    let sum = 0;
    let count = 0;
    for (let j = 0; j < elevations.length; j += 1) {
      const d = distancesFromStart[j];
      const e = elevations[j];
      if (
        typeof d !== "number"
        || typeof e !== "number"
        || !Number.isFinite(d)
        || !Number.isFinite(e)
      ) {
        continue;
      }
      if (Math.abs(d - centerDistance) <= halfWindowMeters) {
        sum += e;
        count += 1;
      }
    }

    if (count === 0) {
      return elevations[index] as number;
    }
    return sum / count;
  });
}

/**
 * Smooth elevations in distance-elevation domain with explicit metric radius.
 */
export function smoothElevationsByDistanceMeters(
  elevations: number[],
  distancesFromStart: number[],
  halfWindowMeters = 30,
): number[] {
  if (
    halfWindowMeters <= 0
    || elevations.length <= 2
    || elevations.length !== distancesFromStart.length
  ) {
    return [...elevations];
  }

  return elevations.map((_, index) => {
    const centerDistance = distancesFromStart[index];
    if (typeof centerDistance !== "number" || !Number.isFinite(centerDistance)) {
      return elevations[index] as number;
    }

    let sum = 0;
    let count = 0;
    for (let j = 0; j < elevations.length; j += 1) {
      const d = distancesFromStart[j];
      const e = elevations[j];
      if (
        typeof d !== "number"
        || typeof e !== "number"
        || !Number.isFinite(d)
        || !Number.isFinite(e)
      ) {
        continue;
      }
      if (Math.abs(d - centerDistance) <= halfWindowMeters) {
        sum += e;
        count += 1;
      }
    }

    if (count === 0) {
      return elevations[index] as number;
    }
    return sum / count;
  });
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

function elevationAtDistance(profile: RouteProfilePoint[], distance: number): number {
  if (profile.length === 0) {
    return 0;
  }

  const first = profile[0];
  if (!first) {
    return 0;
  }
  if (distance <= 0) {
    return first.elevation;
  }

  const last = profile[profile.length - 1];
  if (!last) {
    return first.elevation;
  }
  if (distance >= last.distanceFromStart) {
    return last.elevation;
  }

  for (let i = 1; i < profile.length; i += 1) {
    const prev = profile[i - 1];
    const curr = profile[i];
    if (!prev || !curr) {
      continue;
    }

    if (distance <= curr.distanceFromStart) {
      const span = curr.distanceFromStart - prev.distanceFromStart;
      if (span <= 0) {
        return curr.elevation;
      }
      const t = (distance - prev.distanceFromStart) / span;
      return prev.elevation + t * (curr.elevation - prev.elevation);
    }
  }

  return last.elevation;
}

/**
 * Convert waypoints to a smoothed grade profile and NFD-ready sections.
 */
export async function buildCourseSectionsFromWaypoints(
  waypoints: GeoPoint[],
  elevationProvider: ElevationProvider,
  options: CourseGradientBuildOptions = {},
): Promise<CourseGradientResult> {
  if (waypoints.length === 0) {
    return { profile: [], sections: [] };
  }

  const smoothingWindow = options.smoothingWindow ?? 5;
  const smoothingDistanceMeters = options.smoothingDistanceMeters;
  const sectionLengthMeters = options.sectionLengthMeters
    ?? options.minimumDistance
    ?? 100;
  const maxAbsGrade = options.maxAbsGrade ?? 30;

  const distancesFromStart = new Array<number>(waypoints.length).fill(0);
  let cumulativeDistance = 0;
  for (let i = 1; i < waypoints.length; i += 1) {
    const prev = waypoints[i - 1];
    const curr = waypoints[i];
    if (prev === undefined || curr === undefined) {
      continue;
    }
    cumulativeDistance += haversineDistanceMeters(prev, curr);
    distancesFromStart[i] = cumulativeDistance;
  }

  const rawElevations = await Promise.all(
    waypoints.map((point) => elevationProvider.getElevation(point)),
  );

  const interpolationMask = waypoints.map((point) => point.interpolateElevation === true);
  const {
    elevations: interpolatedRawElevations,
    interpolatedMask,
  } = interpolateMaskedElevations(rawElevations, interpolationMask);

  const smoothedElevations = (
    typeof smoothingDistanceMeters === "number"
    && Number.isFinite(smoothingDistanceMeters)
    && smoothingDistanceMeters > 0
  )
    ? smoothElevationsByDistanceMeters(
      interpolatedRawElevations,
      distancesFromStart,
      smoothingDistanceMeters,
    )
    : smoothElevationsByDistance(
      interpolatedRawElevations,
      distancesFromStart,
      smoothingWindow,
    );

  const {
    elevations: adjustedElevations,
  } = interpolateMaskedElevations(smoothedElevations, interpolationMask);

  const profile: RouteProfilePoint[] = [];
  let cumulative = 0;

  const firstWaypoint = waypoints[0];
  const firstRawElevation = rawElevations[0];
  const firstSmoothedElevation = smoothedElevations[0];
  if (
    firstWaypoint === undefined
    || firstRawElevation === undefined
    || firstSmoothedElevation === undefined
  ) {
    return { profile: [], sections: [] };
  }

  profile.push({
    ...firstWaypoint,
    rawElevation: interpolatedRawElevations[0] as number,
    demElevation: firstRawElevation,
    elevation: adjustedElevations[0] as number,
    distanceFromStart: 0,
    elevationSource: interpolatedMask[0] ? "interpolated" : "dem",
  });

  for (let i = 1; i < waypoints.length; i += 1) {
    const previousWaypoint = waypoints[i - 1];
    const currentWaypoint = waypoints[i];
    const rawElevation = rawElevations[i];
    const smoothedElevation = smoothedElevations[i];
    const adjustedElevation = adjustedElevations[i];
    if (
      previousWaypoint === undefined
      || currentWaypoint === undefined
      || rawElevation === undefined
      || smoothedElevation === undefined
      || adjustedElevation === undefined
    ) {
      continue;
    }

    const distance = haversineDistanceMeters(previousWaypoint, currentWaypoint);
    cumulative += distance;

    profile.push({
      ...currentWaypoint,
      rawElevation: interpolatedRawElevations[i] as number,
      demElevation: rawElevation,
      elevation: adjustedElevation,
      distanceFromStart: cumulative,
      elevationSource: interpolatedMask[i] ? "interpolated" : "dem",
    });
  }

  const sections: CourseSection[] = [];
  const totalDistance = profile[profile.length - 1]?.distanceFromStart ?? 0;
  const normalizedSectionLength = Number.isFinite(sectionLengthMeters) && sectionLengthMeters > 0
    ? sectionLengthMeters
    : 100;

  let sectionStart = 0;
  while (sectionStart < totalDistance) {
    const sectionEnd = Math.min(totalDistance, sectionStart + normalizedSectionLength);
    const distance = sectionEnd - sectionStart;
    if (distance <= 0) {
      break;
    }

    const startElevation = elevationAtDistance(profile, sectionStart);
    const endElevation = elevationAtDistance(profile, sectionEnd);
    const rawGrade = ((endElevation - startElevation) / distance) * 100;
    const grade = clamp(rawGrade, -maxAbsGrade, maxAbsGrade);

    sections.push({ distance, grade });
    sectionStart = sectionEnd;
  }

  return { profile, sections };
}

/**
 * Convenience helper: waypoint route -> grade sections -> NFD.
 */
export async function computeNfdFromWaypoints(
  waypoints: GeoPoint[],
  elevationProvider: ElevationProvider,
  lut: NfdLut,
  options: CourseGradientBuildOptions = {},
): Promise<NfdFromWaypointsResult> {
  const { profile, sections } = await buildCourseSectionsFromWaypoints(
    waypoints,
    elevationProvider,
    options,
  );

  const nfdMeters = computeNfd(sections, lut);

  return {
    profile,
    sections,
    nfdMeters,
    nfdKm: computeNfdKm(sections, lut),
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

/**
 * Parse GSI DEM text tile (.txt) into fixed 256x256 numeric raster.
 * No-data marker "e" is treated as NaN.
 */
export function parseGsiDemTextTile(text: string): DemTile {
  const values = new Float64Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
  values.fill(Number.NaN);

  const rows = text.split(/\r?\n/).filter((row) => row.length > 0);
  const maxY = Math.min(rows.length, DEM_TILE_SIZE);

  for (let y = 0; y < maxY; y += 1) {
    const row = rows[y];
    if (row === undefined) {
      continue;
    }

    const cells = row.split(",");
    const maxX = Math.min(cells.length, DEM_TILE_SIZE);

    for (let x = 0; x < maxX; x += 1) {
      const token = cells[x]?.trim();
      if (token === undefined || token.length === 0 || token.toLowerCase() === "e") {
        continue;
      }

      const parsed = Number(token);
      if (Number.isFinite(parsed)) {
        values[y * DEM_TILE_SIZE + x] = parsed;
      }
    }
  }

  return { values };
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
 * Primary DEM text tile template (5m mesh where available).
 */
export const DEFAULT_GSI_DEM_TILE_TEMPLATE =
  "https://cyberjapandata.gsi.go.jp/xyz/dem5a/{z}/{x}/{y}.txt";

/**
 * Recommended DEM tile templates in fallback order.
 */
export const DEFAULT_GSI_DEM_TILE_TEMPLATES = [
  "https://cyberjapandata.gsi.go.jp/xyz/dem5a/{z}/{x}/{y}.txt",
  "https://cyberjapandata.gsi.go.jp/xyz/dem5b/{z}/{x}/{y}.txt",
  "https://cyberjapandata.gsi.go.jp/xyz/dem/{z}/{x}/{y}.txt",
] as const;

/**
 * Options for tile-based GSI DEM provider.
 */
export interface GsiDemTileElevationProviderOptions {
  zoom?: number;
  tileTemplates?: string[];
  cacheTtlMs?: number;
  maxTiles?: number;
  fetchFn?: typeof fetch;
  /**
   * Max tile-ring radius used to search a nearby valid elevation when
   * the target pixel is no-data (e.g. river/water).
   *
   * 0 means current tile only, 1 includes 8 surrounding tiles.
   *
   * @default 2
   */
  noDataTileSearchRadius?: number;
  /**
   * Pixel search radius inside each candidate tile.
   *
   * @default 16
   */
  noDataPixelSearchRadius?: number;
  /**
   * Fallback elevation (m) used when DEM has no value (e.g. water area).
   * Set to `undefined` to throw an error instead.
   *
   * @default undefined
   */
  noDataFallbackElevation?: number;
}

/**
 * Tile-based elevation provider using GSI DEM text tiles.
 *
 * This provider is suitable for long routes because requests are done per tile,
 * not per point. Nearby points reuse the same cached tile.
 */
export class GsiDemTileElevationProvider implements ElevationProvider {
  private readonly zoom: number;

  private readonly tileTemplates: string[];

  private readonly cacheTtlMs: number;

  private readonly maxTiles: number;

  private readonly fetchFn: typeof fetch;

  private readonly noDataTileSearchRadius: number;

  private readonly noDataPixelSearchRadius: number;

  private readonly noDataFallbackElevation: number | undefined;

  private readonly tileCache = new Map<string, DemTileCacheEntry>();

  private readonly inFlightTileRequests = new Map<string, Promise<DemTile | null>>();

  constructor(options: GsiDemTileElevationProviderOptions = {}) {
    this.zoom = options.zoom ?? 15;
    this.tileTemplates = options.tileTemplates ?? [...DEFAULT_GSI_DEM_TILE_TEMPLATES];
    this.cacheTtlMs = options.cacheTtlMs ?? 24 * 60 * 60 * 1000;
    this.maxTiles = options.maxTiles ?? 1024;
    this.fetchFn = options.fetchFn === undefined
      ? globalThis.fetch.bind(globalThis)
      : options.fetchFn.bind(globalThis);
    this.noDataTileSearchRadius = Math.max(0, Math.trunc(options.noDataTileSearchRadius ?? 2));
    this.noDataPixelSearchRadius = Math.max(0, Math.trunc(options.noDataPixelSearchRadius ?? 16));
    this.noDataFallbackElevation = options.noDataFallbackElevation;

    if (this.tileTemplates.length === 0) {
      throw new Error("At least one tile template is required");
    }
  }

  async getElevation(point: GeoPoint): Promise<number> {
    const tileXFloat = lonToTileX(point.lon, this.zoom);
    const tileYFloat = latToTileY(point.lat, this.zoom);

    const n = 2 ** this.zoom;
    const tileX = clampInteger(Math.floor(tileXFloat), 0, n - 1);
    const tileY = clampInteger(Math.floor(tileYFloat), 0, n - 1);

    const pixelXFloat = (tileXFloat - tileX) * DEM_TILE_SIZE;
    const pixelYFloat = (tileYFloat - tileY) * DEM_TILE_SIZE;
    const pixelX = clampInteger(Math.floor(pixelXFloat), 0, DEM_TILE_SIZE - 1);
    const pixelY = clampInteger(Math.floor(pixelYFloat), 0, DEM_TILE_SIZE - 1);

    for (const template of this.tileTemplates) {
      const tile = await this.getTile(template, tileX, tileY);
      if (tile === null) {
        continue;
      }

      const value = findNearestFiniteDemValue(tile, pixelX, pixelY);
      if (value !== undefined) {
        return value;
      }

      const nearby = await this.findNearbyValueAcrossTiles(
        template,
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
    baseTileX: number,
    baseTileY: number,
    basePixelX: number,
    basePixelY: number,
  ): Promise<number | undefined> {
    const n = 2 ** this.zoom;

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

          const tile = await this.getTile(template, tileX, tileY);
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
    tileX: number,
    tileY: number,
  ): Promise<DemTile | null> {
    const cacheKey = `${template}|${this.zoom}|${tileX}|${tileY}`;
    const now = Date.now();

    const cached = this.tileCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.tile;
    }

    const inFlight = this.inFlightTileRequests.get(cacheKey);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const requestPromise = this.fetchTileAndCache(cacheKey, template, tileX, tileY, now);
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
    tileX: number,
    tileY: number,
    now: number,
  ): Promise<DemTile | null> {

    const url = template
      .replace("{z}", String(this.zoom))
      .replace("{x}", String(tileX))
      .replace("{y}", String(tileY));

    const response = await this.fetchFn(url, {
      headers: {
        Accept: "text/plain",
      },
    });

    if (!response.ok) {
      this.putTileCache(cacheKey, null, now);
      return null;
    }

    const text = await response.text();
    const tile = parseGsiDemTextTile(text);
    this.putTileCache(cacheKey, tile, now);
    return tile;
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
 * @deprecated Prefer `GsiDemTileElevationProvider` for route analysis, because
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
