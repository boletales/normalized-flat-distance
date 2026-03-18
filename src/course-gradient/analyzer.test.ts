import {
  buildCourseSectionsFromWaypoints,
  CachedElevationProvider,
  computeNfdFromWaypoints,
  GsiDemTileElevationProvider,
  haversineDistanceMeters,
  parseGsiDemTextTile,
  smoothElevations,
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

describe("smoothElevations", () => {
  test("preserves constant series", () => {
    const values = [10, 10, 10, 10, 10];
    expect(smoothElevations(values, 5)).toEqual(values);
  });

  test("reduces a sharp spike", () => {
    const values = [0, 0, 100, 0, 0];
    const smoothed = smoothElevations(values, 3);

    expect(smoothed[2]).toBeLessThan(100);
    expect(smoothed[2]).toBeGreaterThan(0);
  });
});

describe("buildCourseSectionsFromWaypoints", () => {
  test("builds grade sections from waypoints and elevations", async () => {
    const waypoints: GeoPoint[] = [
      { lat: 35.0, lon: 139.0 },
      { lat: 35.001, lon: 139.0 },
      { lat: 35.002, lon: 139.0 },
    ];

    const provider = new FunctionElevationProvider((point) => {
      const offset = Math.round((point.lat - 35.0) * 1000);
      return offset * 10; // +10m every ~111m => about 9% grade
    });

    const result = await buildCourseSectionsFromWaypoints(waypoints, provider, {
      smoothingWindow: 1,
      minimumDistance: 1,
      maxAbsGrade: 30,
    });

    expect(result.profile).toHaveLength(3);
    expect(result.sections.length).toBeGreaterThanOrEqual(2);
    const firstSection = result.sections[0];
    expect(firstSection).toBeDefined();
    expect((firstSection as { grade: number }).grade).toBeGreaterThan(8);
    expect((firstSection as { grade: number }).grade).toBeLessThan(10);
  });

  test("merges very short segments when minimumDistance is set", async () => {
    const waypoints: GeoPoint[] = [
      { lat: 35.0, lon: 139.0 },
      { lat: 35.00001, lon: 139.0 },
      { lat: 35.00002, lon: 139.0 },
      { lat: 35.0005, lon: 139.0 },
    ];

    const provider = new FunctionElevationProvider(() => 0);
    const result = await buildCourseSectionsFromWaypoints(waypoints, provider, {
      smoothingWindow: 1,
      minimumDistance: 10,
      maxAbsGrade: 30,
    });

    expect(result.sections.length).toBeLessThan(3);
    const totalDistance = result.sections.reduce((s, x) => s + x.distance, 0);
    const lastPoint = result.profile[result.profile.length - 1];
    expect(lastPoint).toBeDefined();
    expect(totalDistance).toBeCloseTo((lastPoint as { distanceFromStart: number }).distanceFromStart, 6);
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
  test("returns NFD values along with profile and sections", async () => {
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
      smoothingWindow: 1,
      minimumDistance: 1,
      maxAbsGrade: 30,
    });

    expect(result.profile).toHaveLength(2);
    expect(result.sections.length).toBeGreaterThan(0);
    expect(result.nfdMeters).toBeGreaterThan(0);
    expect(result.nfdKm).toBeCloseTo(result.nfdMeters / 1000, 10);
  });
});

function createUniformDemTileText(value: number): string {
  const row = new Array<string>(256).fill(String(value)).join(",");
  return new Array<string>(256).fill(row).join("\n");
}

describe("parseGsiDemTextTile", () => {
  test("parses numeric values and no-data marker", () => {
    const text = [
      "1,2,e",
      "3,4,5",
    ].join("\n");

    const tile = parseGsiDemTextTile(text);

    expect(tile.values[0]).toBe(1);
    expect(tile.values[1]).toBe(2);
    expect(Number.isNaN(tile.values[2])).toBe(true);
    expect(tile.values[256]).toBe(3);
  });
});

describe("GsiDemTileElevationProvider", () => {
  test("uses tile cache to reduce repeated requests", async () => {
    let requestCount = 0;
    const tileText = createUniformDemTileText(123.45);

    const fetchFn: typeof fetch = (async () => {
      requestCount += 1;
      return {
        ok: true,
        text: async () => tileText,
      } as Response;
    }) as typeof fetch;

    const provider = new GsiDemTileElevationProvider({
      fetchFn,
      zoom: 15,
      maxTiles: 16,
      cacheTtlMs: 60_000,
      tileTemplates: ["https://example.com/{z}/{x}/{y}.txt"],
    });

    const a = await provider.getElevation({ lat: 35.0, lon: 139.0 });
    const b = await provider.getElevation({ lat: 35.0001, lon: 139.0001 });

    expect(a).toBeCloseTo(123.45, 6);
    expect(b).toBeCloseTo(123.45, 6);
    expect(requestCount).toBe(1);
    expect(provider.size).toBe(1);
  });

  test("falls back to next template when first is unavailable", async () => {
    let requestCount = 0;
    const tileText = createUniformDemTileText(88);

    const fetchFn: typeof fetch = (async (url: string | URL | Request) => {
      requestCount += 1;
      const urlText = String(url);
      if (urlText.includes("dem5a")) {
        return {
          ok: false,
          status: 404,
          statusText: "Not Found",
          text: async () => "",
        } as Response;
      }

      return {
        ok: true,
        text: async () => tileText,
      } as Response;
    }) as typeof fetch;

    const provider = new GsiDemTileElevationProvider({
      fetchFn,
      zoom: 15,
      maxTiles: 16,
      cacheTtlMs: 60_000,
      tileTemplates: [
        "https://example.com/dem5a/{z}/{x}/{y}.txt",
        "https://example.com/dem/{z}/{x}/{y}.txt",
      ],
    });

    const elevation = await provider.getElevation({ lat: 35.0, lon: 139.0 });

    expect(elevation).toBe(88);
    expect(requestCount).toBe(2);
  });

  test("deduplicates concurrent requests for the same tile", async () => {
    let requestCount = 0;
    const tileText = createUniformDemTileText(77);

    const fetchFn: typeof fetch = (async () => {
      requestCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        ok: true,
        text: async () => tileText,
      } as Response;
    }) as typeof fetch;

    const provider = new GsiDemTileElevationProvider({
      fetchFn,
      zoom: 15,
      maxTiles: 16,
      cacheTtlMs: 60_000,
      tileTemplates: ["https://example.com/{z}/{x}/{y}.txt"],
    });

    const [a, b, c] = await Promise.all([
      provider.getElevation({ lat: 35.0, lon: 139.0 }),
      provider.getElevation({ lat: 35.00005, lon: 139.00005 }),
      provider.getElevation({ lat: 35.00008, lon: 139.00008 }),
    ]);

    expect(a).toBe(77);
    expect(b).toBe(77);
    expect(c).toBe(77);
    expect(requestCount).toBe(1);
  });

  test("throws by default when DEM has no value", async () => {
    const noDataRow = new Array<string>(256).fill("e").join(",");
    const noDataTileText = new Array<string>(256).fill(noDataRow).join("\n");

    const fetchFn: typeof fetch = (async () => {
      return {
        ok: true,
        text: async () => noDataTileText,
      } as Response;
    }) as typeof fetch;

    const provider = new GsiDemTileElevationProvider({
      fetchFn,
      zoom: 15,
      tileTemplates: ["https://example.com/{z}/{x}/{y}.txt"],
    });

    await expect(provider.getElevation({ lat: 35.70825, lon: 139.79742 }))
      .rejects
      .toThrow("No DEM value available");
  });

  test("uses configured fallback elevation when DEM has no value", async () => {
    const noDataRow = new Array<string>(256).fill("e").join(",");
    const noDataTileText = new Array<string>(256).fill(noDataRow).join("\n");

    const fetchFn: typeof fetch = (async () => {
      return {
        ok: true,
        text: async () => noDataTileText,
      } as Response;
    }) as typeof fetch;

    const provider = new GsiDemTileElevationProvider({
      fetchFn,
      zoom: 15,
      tileTemplates: ["https://example.com/{z}/{x}/{y}.txt"],
      noDataFallbackElevation: 12,
    });

    const elevation = await provider.getElevation({ lat: 35.70825, lon: 139.79742 });
    expect(elevation).toBe(12);
  });

  test("searches nearby tiles when current tile pixel is no-data", async () => {
    const target = { lat: 35.70825, lon: 139.79742 };
    const zoom = 15;
    const n = 2 ** zoom;
    const centerTileX = Math.floor(((target.lon + 180) / 360) * n);

    const noDataRow = new Array<string>(256).fill("e").join(",");
    const noDataTileText = new Array<string>(256).fill(noDataRow).join("\n");
    const tileText = createUniformDemTileText(42);

    const fetchFn: typeof fetch = (async (url: string | URL | Request) => {
      const urlText = String(url);
      const match = urlText.match(/\/(\d+)\/(\d+)\/(\d+)\.txt$/);
      if (!match) {
        return { ok: false, status: 404, statusText: "Not Found", text: async () => "" } as Response;
      }

      const x = Number(match[2]);
      if (x === centerTileX) {
        return { ok: true, text: async () => noDataTileText } as Response;
      }
      if (x === centerTileX + 1) {
        return { ok: true, text: async () => tileText } as Response;
      }
      return { ok: true, text: async () => noDataTileText } as Response;
    }) as typeof fetch;

    const provider = new GsiDemTileElevationProvider({
      fetchFn,
      zoom,
      tileTemplates: ["https://example.com/{z}/{x}/{y}.txt"],
      noDataTileSearchRadius: 1,
      noDataPixelSearchRadius: 255,
    });

    const elevation = await provider.getElevation(target);
    expect(elevation).toBe(42);
  });
});
