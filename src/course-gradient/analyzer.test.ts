import {
  buildCourseProfileFromWaypoints,
  CachedElevationProvider,
  computeNfdFromWaypoints,
  GsiDemPngTileElevationProvider,
  haversineDistanceMeters,
  interpolateMaskedElevations,
  parseGsiDemPngRgbaTile,
  smoothElevationsWithSavitzkyGolay,
  type ElevationProvider,
  type GeoPoint,
} from "./analyzer";

class FunctionElevationProvider implements ElevationProvider {
  constructor(private readonly fn: (point: GeoPoint) => number) {}

  async getElevation(point: GeoPoint): Promise<number> {
    return this.fn(point);
  }
}

describe("haversineDistanceMeters", () => {
  test("returns approximately 111.2 km per 1 degree latitude", () => {
    const distance = haversineDistanceMeters(
      { lat: 35.0, lon: 139.0 },
      { lat: 36.0, lon: 139.0 },
    );
    expect(distance).toBeGreaterThan(111000);
    expect(distance).toBeLessThan(112000);
  });
});

describe("interpolateMaskedElevations", () => {
  test("linearly interpolates masked interior span", () => {
    const source = [100, 150, 999, 999, 250, 300];
    const mask = [false, false, true, true, false, false];

    const { elevations, interpolatedMask } = interpolateMaskedElevations(source, mask);

    expect(elevations[2]).toBeCloseTo(183.333333, 5);
    expect(elevations[3]).toBeCloseTo(216.666666, 5);
    expect(interpolatedMask[2]).toBe(true);
    expect(interpolatedMask[3]).toBe(true);
  });
});

describe("smoothElevationsWithSavitzkyGolay", () => {
  test("stabilizes tail point with short trailing remainder", () => {
    const elevations = [0, 0, 100];
    const distances = [0, 1600, 1608];

    const smoothed = smoothElevationsWithSavitzkyGolay(
      elevations,
      distances,
      20,
      3,
      2,
    );

    expect(smoothed[2]).toBeLessThan(20);
  });
});

describe("buildCourseProfileFromWaypoints", () => {
  test("builds smoothed profile from waypoints and elevations", async () => {
    const waypoints: GeoPoint[] = [
      { lat: 35.0, lon: 139.0 },
      { lat: 35.001, lon: 139.0 },
      { lat: 35.002, lon: 139.0 },
    ];

    const provider = new FunctionElevationProvider((point) => {
      const offset = Math.round((point.lat - 35.0) * 1000);
      return offset * 10;
    });

    const result = await buildCourseProfileFromWaypoints(waypoints, provider, {
      maxAbsGrade: 30,
    });

    expect(result.profile.length).toBeGreaterThan(0);
    const first = result.profile[0];
    const last = result.profile[result.profile.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    expect((last as { elevation: number }).elevation).toBeGreaterThan((first as { elevation: number }).elevation);
  });

  test("profile distances are monotonic", async () => {
    const waypoints: GeoPoint[] = [
      { lat: 35.0, lon: 139.0 },
      { lat: 35.00001, lon: 139.0 },
      { lat: 35.00002, lon: 139.0 },
      { lat: 35.0005, lon: 139.0 },
    ];

    const provider = new FunctionElevationProvider(() => 0);
    const result = await buildCourseProfileFromWaypoints(waypoints, provider, {
      maxAbsGrade: 30,
    });

    expect(result.profile.length).toBeGreaterThan(1);
    for (let i = 1; i < result.profile.length; i += 1) {
      const prev = result.profile[i - 1];
      const curr = result.profile[i];
      expect((curr as { distanceFromStart: number }).distanceFromStart)
        .toBeGreaterThanOrEqual((prev as { distanceFromStart: number }).distanceFromStart);
    }
  });
});

describe("CachedElevationProvider", () => {
  test("avoids duplicate fetches for same rounded coordinate", async () => {
    let callCount = 0;
    const base: ElevationProvider = {
      getElevation: async () => {
        callCount += 1;
        return 123;
      },
    };

    const cached = new CachedElevationProvider(base, {
      precision: 5,
      ttlMs: 60_000,
      maxEntries: 100,
    });

    await cached.getElevation({ lat: 35.1234567, lon: 139.1234567 });
    await cached.getElevation({ lat: 35.1234568, lon: 139.1234568 });

    expect(callCount).toBe(1);
    expect(cached.size).toBe(1);
  });
});

describe("computeNfdFromWaypoints", () => {
  test("returns NFD values along with profile", async () => {
    const waypoints: GeoPoint[] = [
      { lat: 35.0, lon: 139.0 },
      { lat: 35.001, lon: 139.0 },
    ];

    const provider = new FunctionElevationProvider((point) => {
      if (point.lat < 35.0005) return 0;
      return 10;
    });

    const lut = new Map<number, number>([
      [-10, 0.8],
      [0, 1.0],
      [10, 1.6],
    ]);

    const result = await computeNfdFromWaypoints(waypoints, provider, lut, {
      maxAbsGrade: 30,
    });

    expect(result.profile.length).toBeGreaterThan(0);
    expect(result.nfdMeters).toBeGreaterThan(0);
    expect(result.nfdKm).toBeCloseTo(result.nfdMeters / 1000, 10);
  });
});

function createUniformDemPngRgbaTile(elevation: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(256 * 256 * 4);

  let x = Math.round(elevation * 100);
  if (x < 0) {
    x += 2 ** 24;
  }

  const r = Math.floor(x / 65536);
  const g = Math.floor((x % 65536) / 256);
  const b = x % 256;

  for (let i = 0; i < 256 * 256; i += 1) {
    const idx = i * 4;
    data[idx] = r;
    data[idx + 1] = g;
    data[idx + 2] = b;
    data[idx + 3] = 255;
  }

  return data;
}

describe("parseGsiDemPngRgbaTile", () => {
  test("parses positive, negative and no-data pixels", () => {
    const rgba = new Uint8ClampedArray(256 * 256 * 4);
    rgba.fill(0);

    rgba[0] = 0;
    rgba[1] = 2;
    rgba[2] = 16;
    rgba[3] = 255;

    rgba[4] = 255;
    rgba[5] = 255;
    rgba[6] = 133;
    rgba[7] = 255;

    rgba[8] = 128;
    rgba[9] = 0;
    rgba[10] = 0;
    rgba[11] = 255;

    const tile = parseGsiDemPngRgbaTile(rgba);
    expect(tile.values[0]).toBeCloseTo(5.28, 6);
    expect(tile.values[1]).toBeCloseTo(-1.23, 6);
    expect(Number.isNaN(tile.values[2])).toBe(true);
  });
});

describe("GsiDemPngTileElevationProvider", () => {
  test("uses tile cache to reduce repeated requests", async () => {
    let requestCount = 0;
    const rgba = createUniformDemPngRgbaTile(123.45);

    const fetchFn: typeof fetch = (async () => {
      requestCount += 1;
      return {
        ok: true,
        blob: async () => new Blob(["png"], { type: "image/png" }),
      } as Response;
    }) as typeof fetch;

    const provider = new GsiDemPngTileElevationProvider({
      fetchFn,
      decodePngRgba: async () => rgba,
      zoom: 15,
      maxTiles: 16,
      cacheTtlMs: 60_000,
      tileTemplates: ["https://example.com/{z}/{x}/{y}.png"],
    });

    const a = await provider.getElevation({ lat: 35.0, lon: 139.0 });
    const b = await provider.getElevation({ lat: 35.0001, lon: 139.0001 });

    expect(a).toBeCloseTo(123.45, 6);
    expect(b).toBeCloseTo(123.45, 6);
    expect(requestCount).toBe(1);
    expect(provider.size).toBe(1);
  });

  test("falls back to next template when first template is unavailable", async () => {
    let requestCount = 0;
    const rgba = createUniformDemPngRgbaTile(88);

    const fetchFn: typeof fetch = (async (url: string | URL | Request) => {
      requestCount += 1;
      const urlText = String(url);

      if (urlText.includes("dem5a_png")) {
        return {
          ok: false,
          status: 404,
          statusText: "Not Found",
          blob: async () => new Blob(),
        } as Response;
      }

      return {
        ok: true,
        blob: async () => new Blob(["png"], { type: "image/png" }),
      } as Response;
    }) as typeof fetch;

    const provider = new GsiDemPngTileElevationProvider({
      fetchFn,
      decodePngRgba: async () => rgba,
      zoom: 15,
      maxTiles: 16,
      cacheTtlMs: 60_000,
      tileTemplates: [
        "https://example.com/dem5a_png/{z}/{x}/{y}.png",
        "https://example.com/dem_png/{z}/{x}/{y}.png",
      ],
    });

    const elevation = await provider.getElevation({ lat: 35.0, lon: 139.0 });
    expect(elevation).toBe(88);
    expect(requestCount).toBe(2);
  });
});
