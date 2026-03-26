import {
  buildCourseProfileFromWaypoints,
  CachedElevationProvider,
  computeNfdFromWaypoints,
  GsiDemTileElevationProvider,
  haversineDistanceMeters,
  interpolateMaskedElevations,
  parseGsiDemTextTile,
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

    // Without guard points this tends to fall back to raw last elevation (=100).
    // Guard-point smoothing should keep the tail close to the preceding trend.
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
      return offset * 10; // +10m every ~111m => about 9% grade
    });

    const result = await buildCourseProfileFromWaypoints(waypoints, provider, {
      maxAbsGrade: 30,
    });

    expect(result.profile).toHaveLength(3);
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

  test("keeps profile points for non-uniform waypoint spacing", async () => {
    const waypoints: GeoPoint[] = [
      { lat: 35.0, lon: 139.0 },
      { lat: 35.00017, lon: 139.0 },
      { lat: 35.00049, lon: 139.0 },
      { lat: 35.00112, lon: 139.0 },
      { lat: 35.00187, lon: 139.0 },
      { lat: 35.0027, lon: 139.0 },
    ];

    const provider = new FunctionElevationProvider((point) => {
      const dLat = point.lat - 35.0;
      // roughly linear climb
      return dLat * 100_000;
    });

    const result = await buildCourseProfileFromWaypoints(waypoints, provider, {
      maxAbsGrade: 30,
    });

    expect(result.profile.length).toBe(waypoints.length);
    const courseDistance = result.profile[result.profile.length - 1]?.distanceFromStart ?? 0;
    expect(courseDistance).toBeGreaterThan(0);
  });

  test("uses endpoint interpolation for masked (tunnel/bridge) points", async () => {
    const waypoints: GeoPoint[] = [
      { lat: 35.0, lon: 139.0 },
      { lat: 35.0005, lon: 139.0, interpolateElevation: true },
      { lat: 35.001, lon: 139.0, interpolateElevation: true },
      { lat: 35.0015, lon: 139.0 },
    ];

    const provider = new FunctionElevationProvider((point) => {
      // middle points are intentionally unrealistic (surface DEM over tunnel/bridge)
      if (point.lat < 35.0002) return 100;
      if (point.lat < 35.0012) return 500;
      return 160;
    });

    const result = await buildCourseProfileFromWaypoints(waypoints, provider, {
      maxAbsGrade: 40,
    });

    expect(result.profile).toHaveLength(4);
    expect(result.profile[1]?.elevationSource).toBe("interpolated");
    expect(result.profile[2]?.elevationSource).toBe("interpolated");
    // Savitzky-Golay smoothing produces smoothed values that may differ slightly
    // from simple linear interpolation due to polynomial fitting
    expect((result.profile[1]?.elevation ?? 0)).toBeGreaterThan(115);
    expect((result.profile[1]?.elevation ?? 0)).toBeLessThan(130);
    expect((result.profile[2]?.elevation ?? 0)).toBeGreaterThan(135);
    expect((result.profile[2]?.elevation ?? 0)).toBeLessThan(145);
    expect(result.profile[1]?.demElevation).toBe(500);
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

    expect(result.profile).toHaveLength(2);
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

  test("checks same pixel in next template before nearest search in first template", async () => {
    const target = { lat: 35.70825, lon: 139.79742 };
    const zoom = 15;
    const n = 2 ** zoom;
    const tileX = Math.floor(((target.lon + 180) / 360) * n);
    const tileY = Math.floor((
      (1 - Math.log(Math.tan((target.lat * Math.PI) / 180) + (1 / Math.cos((target.lat * Math.PI) / 180))) / Math.PI)
      / 2
    ) * n);
    const pixelX = Math.floor(((((target.lon + 180) / 360) * n) - tileX) * 256);
    const pixelY = Math.floor((((
      (1 - Math.log(Math.tan((target.lat * Math.PI) / 180) + (1 / Math.cos((target.lat * Math.PI) / 180))) / Math.PI)
      / 2
    ) * n) - tileY) * 256);

    const rows5a = new Array<string>(256)
      .fill(0)
      .map(() => new Array<string>(256).fill("e").join(","));
    // Keep the target pixel as no-data but place a nearby finite value.
    rows5a[Math.max(0, pixelY - 1)] = new Array<string>(256)
      .fill("e")
      .map((v, idx) => (idx === pixelX ? "111" : v))
      .join(",");
    const tileText5a = rows5a.join("\n");

    const tileTextDem = createUniformDemTileText(222);

    const fetchFn: typeof fetch = (async (url: string | URL | Request) => {
      const urlText = String(url);
      if (urlText.includes("dem5a")) {
        return { ok: true, text: async () => tileText5a } as Response;
      }
      if (urlText.includes("dem/")) {
        return { ok: true, text: async () => tileTextDem } as Response;
      }
      return { ok: false, status: 404, statusText: "Not Found", text: async () => "" } as Response;
    }) as typeof fetch;

    const provider = new GsiDemTileElevationProvider({
      fetchFn,
      zoom,
      tileTemplates: [
        "https://example.com/dem5a/{z}/{x}/{y}.txt",
        "https://example.com/dem/{z}/{x}/{y}.txt",
      ],
      noDataTileSearchRadius: 0,
      noDataPixelSearchRadius: 2,
    });

    const elevation = await provider.getElevation(target);

    // If nearest search in dem5a ran first, this would be 111.
    expect(elevation).toBe(222);
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
