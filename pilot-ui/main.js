import "leaflet/dist/leaflet.css";
import "leaflet-routing-machine/dist/leaflet-routing-machine.css";

import L from "leaflet";
import "leaflet-routing-machine";
import Chart from "chart.js/auto";

import {
  CYCLIST_PRESETS,
  buildNfdLut,
  computeNfdFromWaypoints,
  GsiDemTileElevationProvider,
} from "../src/index";

/** @typedef {{lat:number, lon:number}} GeoPoint */

const levelSelect = document.getElementById("levelSelect");
const smoothingDistanceInput = document.getElementById("smoothingDistance");
const sectionLengthInput = document.getElementById("sectionLength");
const maxAbsGradeInput = document.getElementById("maxAbsGrade");
const analyzeButton = document.getElementById("analyzeButton");
const clearButton = document.getElementById("clearButton");
const exportButton = document.getElementById("exportButton");
const exportInterpolationButton = document.getElementById("exportInterpolationButton");
const summary = document.getElementById("summary");
const error = document.getElementById("error");
const profileCanvas = document.getElementById("profileChart");

/** @type {GeoPoint[]} */
let latestRouteCoordinates = [];
/** @type {import("../src/course-gradient/analyzer").RouteProfilePoint[]} */
let latestProfile = [];
/** @type {import("../src/types").CourseSection[]} */
let latestSections = [];

/** @type {Map<string, {segments:Array<{a:GeoPoint,b:GeoPoint}>}>} */
const tunnelBridgeCache = new Map();

const tileProvider = new GsiDemTileElevationProvider({
  zoom: 15,
  maxTiles: 2048,
  cacheTtlMs: 24 * 60 * 60 * 1000,
});

/** @type {Map<string, Map<number, number>>} */
const lutCache = new Map();

const map = L.map("map", {
  preferCanvas: true,
}).setView([35.68, 139.76], 12);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

const hoverMarker = L.circleMarker([35.68, 139.76], {
  radius: 7,
  color: "#d92d20",
  fillColor: "#f04438",
  fillOpacity: 0.9,
  weight: 2,
});

const initialWaypoints = [];

function showUiError(message) {
  error.textContent = message;
}

function clearUiError() {
  error.textContent = "";
}

function getMarkerRole(index, count) {
  if (index === 0) return "start";
  if (index === count - 1) return "goal";
  return "via";
}

function getMarkerLabel(index, count) {
  if (index === 0) return "S";
  if (index === count - 1) return "G";
  return String(index);
}

function removeWaypointAt(index) {
  const current = routingControl.getWaypoints()
    .map((w) => w.latLng)
    .filter((v) => v !== null);

  if (current.length <= 2) {
    showUiError("スタートとゴールは最低2点必要です。経由点のみ削除できます。");
    return;
  }

  if (index <= 0 || index >= current.length - 1) {
    showUiError("スタート/ゴールは削除できません。経由点を削除してください。");
    return;
  }

  const next = current.filter((_, i) => i !== index);
  routingControl.setWaypoints(next);
  clearUiError();
}

const routingControl = L.Routing.control({
  waypoints: initialWaypoints,
  router: L.Routing.osrmv1({
    // 自転車向けプロファイルを利用して高速道路選択を避ける
    profile: "cycling",
    serviceUrl: "https://router.project-osrm.org/route/v1",
  }),
  lineOptions: {
    styles: [{ color: "#1769ff", weight: 5 }],
    extendToWaypoints: true,
    missingRouteTolerance: 5,
  },
  routeWhileDragging: true,
  addWaypoints: true,
  fitSelectedRoutes: true,
  showAlternatives: false,
  show: false,
  draggableWaypoints: true,
  createMarker: (index, waypoint, count) => {
    const role = getMarkerRole(index, count);
    const label = getMarkerLabel(index, count);

    const marker = L.marker(waypoint.latLng, {
      title: `Waypoint ${index + 1}/${count}`,
      draggable: true,
      icon: L.divIcon({
        className: `waypoint-badge waypoint-badge--${role}`,
        html: `<span>${label}</span>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      }),
    });

    if (role === "via") {
      marker.bindTooltip("右クリック / ダブルクリックで削除", {
        direction: "top",
        offset: [0, -12],
      });

      marker.on("contextmenu", () => {
        removeWaypointAt(index);
      });

      marker.on("dblclick", () => {
        removeWaypointAt(index);
      });

      marker.bindPopup("<button type=\"button\" data-delete-waypoint>この経由点を削除</button>");
      marker.on("popupopen", (ev) => {
        const root = ev.popup.getElement();
        const button = root?.querySelector("button[data-delete-waypoint]");
        button?.addEventListener("click", () => {
          map.closePopup();
          removeWaypointAt(index);
        }, { once: true });
      });
    }

    return marker;
  },
}).addTo(map);

routingControl.on("routesfound", (event) => {
  const route = event.routes?.[0];
  if (!route || !Array.isArray(route.coordinates)) {
    latestRouteCoordinates = [];
    return;
  }

  latestRouteCoordinates = route.coordinates.map((c) => ({ lat: c.lat, lon: c.lng }));
});

map.on("click", (e) => {
  const current = routingControl.getWaypoints()
    .map((w) => w.latLng)
    .filter((v) => v !== null);

  if (current.length < 2) {
    current.push(e.latlng);
  } else {
    // 使い勝手のため、地図クリックで「ゴールの手前」に経由点を挿入する
    current.splice(current.length - 1, 0, e.latlng);
  }
  routingControl.setWaypoints(current);
  clearUiError();
});

clearButton.addEventListener("click", () => {
  routingControl.setWaypoints([...initialWaypoints]);
  latestRouteCoordinates = [];
  latestProfile = [];
  latestSections = [];
  if (chart) {
    chart.data.labels = [];
    chart.data.datasets[0].data = [];
    chart.data.datasets[1].data = [];
    chart.data.datasets[2].data = [];
    chart.data.datasets[3].data = [];
    chart.update();
  }
  hoverMarker.remove();
  summary.textContent = "地図をクリックしてS/Gを作成し、「解析」を押してください。";
  clearUiError();
});

function toCsvCell(value) {
  const text = String(value ?? "");
  if (/[,"\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function triggerDownload(filename, content, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function buildProfileDebugCsv(profile) {
  const header = [
    "index",
    "lat",
    "lon",
    "distanceFromStart_m",
    "demElevation_m",
    "rawElevationInterpolated_m",
    "smoothedElevation_m",
    "segmentGrade_percent",
    "elevationSource",
  ];

  const lines = [header.map(toCsvCell).join(",")];
  for (let i = 0; i < profile.length; i += 1) {
    const p = profile[i];
    const prev = i > 0 ? profile[i - 1] : undefined;
    const d = prev ? p.distanceFromStart - prev.distanceFromStart : 0;
    const de = prev ? p.elevation - prev.elevation : 0;
    const grade = d <= 0 ? 0 : (de / d) * 100;

    lines.push([
      i,
      p.lat,
      p.lon,
      p.distanceFromStart,
      p.demElevation ?? p.rawElevation,
      p.rawElevation,
      p.elevation,
      grade,
      p.elevationSource,
    ].map(toCsvCell).join(","));
  }

  return lines.join("\n");
}

function buildSectionsDebugCsv(sections) {
  const lines = ["index,distance_m,grade_percent"];
  for (let i = 0; i < sections.length; i += 1) {
    const s = sections[i];
    lines.push([i, s.distance, s.grade].map(toCsvCell).join(","));
  }
  return lines.join("\n");
}

function buildInterpolationDebugCsv(profile) {
  const header = [
    "緯度 / deg",
    "経度 / deg",
    "距離程 / m",
    "内挿前標高 / m",
    "内挿後標高 / m",
  ];

  const lines = [header.map(toCsvCell).join(",")];
  for (const p of profile) {
    lines.push([
      p.lat,
      p.lon,
      p.distanceFromStart,
      p.demElevation ?? p.rawElevation,
      p.rawElevation,
    ].map(toCsvCell).join(","));
  }
  return lines.join("\n");
}

exportButton?.addEventListener("click", () => {
  if (!latestProfile.length) {
    showUiError("先に解析を実行してください。出力対象データがありません。");
    return;
  }

  const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
  triggerDownload(
    `nfd-profile-debug-${timestamp}.csv`,
    buildProfileDebugCsv(latestProfile),
    "text/csv;charset=utf-8",
  );
  triggerDownload(
    `nfd-sections-debug-${timestamp}.csv`,
    buildSectionsDebugCsv(latestSections),
    "text/csv;charset=utf-8",
  );
  clearUiError();
});

exportInterpolationButton?.addEventListener("click", () => {
  if (!latestProfile.length) {
    showUiError("先に解析を実行してください。出力対象データがありません。");
    return;
  }

  const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
  triggerDownload(
    `nfd-interpolation-debug-${timestamp}.csv`,
    buildInterpolationDebugCsv(latestProfile),
    "text/csv;charset=utf-8",
  );
  clearUiError();
});

const chart = new Chart(profileCanvas, {
  type: "line",
  data: {
    labels: [],
    datasets: [
      {
        label: "生標高 [m]",
        data: [],
        yAxisID: "y",
        borderColor: "#98a2b3",
        backgroundColor: "rgba(152, 162, 179, 0.1)",
        borderWidth: 1,
        borderDash: [5, 5],
        pointRadius: 0,
        tension: 0.1,
      },
      {
        label: "平滑化標高 [m]",
        data: [],
        yAxisID: "y",
        borderColor: "#1570ef",
        backgroundColor: "rgba(21, 112, 239, 0.2)",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.1,
      },
      {
        label: "セクション境界",
        data: [],
        type: "scatter",
        yAxisID: "y",
        borderColor: "#1570ef",
        backgroundColor: "#1570ef",
        borderWidth: 1,
        showLine: false,
        pointRadius: 2.5,
        pointHoverRadius: 4,
      },
      {
        label: "勾配 [%]",
        data: [],
        yAxisID: "y1",
        borderColor: "#f79009",
        backgroundColor: "rgba(247, 144, 9, 0.2)",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0,
      },
    ],
  },
  options: {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    parsing: false,
    scales: {
      x: {
        type: "linear",
        title: { display: true, text: "距離 [km]" },
      },
      y: {
        type: "linear",
        position: "left",
        title: { display: true, text: "標高 [m]" },
      },
      y1: {
        type: "linear",
        position: "right",
        title: { display: true, text: "勾配 [%]" },
        grid: { drawOnChartArea: false },
      },
    },
    plugins: {
      tooltip: {
        callbacks: {
          title(items) {
            const x = items[0]?.parsed?.x;
            if (typeof x !== "number") return "";
            return `距離 ${x.toFixed(3)} km`;
          },
        },
      },
    },
    onHover(_event, activeElements) {
      const first = activeElements[0];
      if (!first) return;

      const datasetIndex = first.datasetIndex;
      const dataIndex = first.index;
      const dataset = chart.data.datasets[datasetIndex];
      const dataPoint = dataset?.data?.[dataIndex];

      let xKm = 0;
      if (dataPoint && typeof dataPoint === "object" && "x" in dataPoint && typeof dataPoint.x === "number") {
        xKm = dataPoint.x;
      }

      let nearest = null;
      let minAbs = Number.POSITIVE_INFINITY;
      for (const p of latestProfile) {
        const dx = Math.abs((p.distanceFromStart / 1000) - xKm);
        if (dx < minAbs) {
          minAbs = dx;
          nearest = p;
        }
      }

      const point = nearest;
      if (!point) return;

      hoverMarker.setLatLng([point.lat, point.lon]);
      if (!map.hasLayer(hoverMarker)) {
        hoverMarker.addTo(map);
      }
    },
  },
});

function getOrBuildLut(level) {
  const existing = lutCache.get(level);
  if (existing) return existing;
  const lut = buildNfdLut(CYCLIST_PRESETS[level]);
  lutCache.set(level, lut);
  return lut;
}

/**
 * Route coordinate count can be large; downsample to keep analysis responsive.
 * @param {GeoPoint[]} points
 * @param {number} maxPoints
 * @returns {GeoPoint[]}
 */
function downsample(points, maxPoints = 2500) {
  if (points.length <= maxPoints) {
    return points;
  }

  const stride = Math.ceil(points.length / maxPoints);
  const sampled = [];
  for (let i = 0; i < points.length; i += stride) {
    sampled.push(points[i]);
  }
  const last = points[points.length - 1];
  if (sampled[sampled.length - 1] !== last && last) {
    sampled.push(last);
  }
  return sampled;
}

function buildBBox(points, padding = 0.003) {
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;

  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  return {
    south: minLat - padding,
    west: minLon - padding,
    north: maxLat + padding,
    east: maxLon + padding,
  };
}

function bboxKey(bbox) {
  return [bbox.south, bbox.west, bbox.north, bbox.east]
    .map((v) => v.toFixed(3))
    .join(",");
}

function toLocalMeters(p, originLatRad) {
  const kx = 111320 * Math.cos(originLatRad);
  const ky = 110540;
  return { x: p.lon * kx, y: p.lat * ky };
}

function squaredDistancePointToSegment(point, a, b, originLatRad) {
  const p = toLocalMeters(point, originLatRad);
  const s = toLocalMeters(a, originLatRad);
  const e = toLocalMeters(b, originLatRad);

  const vx = e.x - s.x;
  const vy = e.y - s.y;
  const wx = p.x - s.x;
  const wy = p.y - s.y;

  const vv = vx * vx + vy * vy;
  if (vv === 0) {
    const dx = p.x - s.x;
    const dy = p.y - s.y;
    return dx * dx + dy * dy;
  }

  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / vv));
  const qx = s.x + t * vx;
  const qy = s.y + t * vy;
  const dx = p.x - qx;
  const dy = p.y - qy;
  return dx * dx + dy * dy;
}

async function fetchTunnelBridgeSegments(points) {
  if (points.length === 0) {
    return { segments: [] };
  }

  const bbox = buildBBox(points);
  const key = bboxKey(bbox);
  const cached = tunnelBridgeCache.get(key);
  if (cached) return cached;

  const query = `
[out:json][timeout:25];
(
  way["tunnel"~"yes|building_passage"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  way["bridge"~"yes|viaduct|movable|aqueduct"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
);
out geom;
`;

  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      Accept: "application/json",
    },
    body: query,
  });

  if (!response.ok) {
    throw new Error(`OSM tunnel/bridge fetch failed: ${response.status} ${response.statusText}`);
  }

  const body = await response.json();
  const segments = [];

  for (const element of body.elements ?? []) {
    if (!Array.isArray(element?.geometry) || element.geometry.length < 2) {
      continue;
    }

    for (let i = 1; i < element.geometry.length; i += 1) {
      const prev = element.geometry[i - 1];
      const curr = element.geometry[i];
      if (
        typeof prev?.lat !== "number"
        || typeof prev?.lon !== "number"
        || typeof curr?.lat !== "number"
        || typeof curr?.lon !== "number"
      ) {
        continue;
      }

      segments.push({
        a: { lat: prev.lat, lon: prev.lon },
        b: { lat: curr.lat, lon: curr.lon },
      });
    }
  }

  const payload = { segments };
  tunnelBridgeCache.set(key, payload);
  return payload;
}

function markTunnelBridgeInterpolation(points, segments, thresholdMeters = 20) {
  if (segments.length === 0) {
    return { points, markedCount: 0 };
  }

  const threshold2 = thresholdMeters * thresholdMeters;
  const originLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const originLatRad = (originLat * Math.PI) / 180;

  let markedCount = 0;
  const marked = points.map((p) => {
    let near = false;
    for (const seg of segments) {
      const d2 = squaredDistancePointToSegment(p, seg.a, seg.b, originLatRad);
      if (d2 <= threshold2) {
        near = true;
        break;
      }
    }

    if (near) {
      markedCount += 1;
      return { ...p, interpolateElevation: true };
    }

    return p;
  });

  return { points: marked, markedCount };
}

/**
 * @param {import("../src/course-gradient/analyzer").RouteProfilePoint[]} profile
 * @param {import("../src/types").CourseSection[]} sections
 */
function buildChartData(profile, sections) {
  const rawElevationSeries = [];
  const smoothedElevationSeries = [];
  const sectionBoundaryPoints = [];
  const sectionGradeSeries = [];

  for (let i = 0; i < profile.length; i += 1) {
    const current = profile[i];
    const x = current.distanceFromStart / 1000;

    rawElevationSeries.push({ x, y: current.rawElevation });
    smoothedElevationSeries.push({ x, y: current.elevation });

  }

  let accumulated = 0;
  const findNearestProfilePointByDistance = (distanceMeters) => {
    if (!profile.length) {
      return null;
    }
    let nearest = profile[0] ?? null;
    let minAbs = Number.POSITIVE_INFINITY;
    for (const p of profile) {
      const d = Math.abs(p.distanceFromStart - distanceMeters);
      if (d < minAbs) {
        minAbs = d;
        nearest = p;
      }
    }
    return nearest;
  };

  if (profile.length > 0) {
    const first = profile[0];
    if (first) {
      sectionBoundaryPoints.push({ x: 0, y: first.elevation });
    }
  }

  for (const section of sections) {
    const d = section.distance;
    const start = accumulated;
    const end = accumulated + d;
    const mid = (start + end) / 2;
    sectionGradeSeries.push({ x: mid / 1000, y: section.grade });

    const boundaryPoint = findNearestProfilePointByDistance(end);
    if (boundaryPoint) {
      sectionBoundaryPoints.push({
        x: end / 1000,
        y: boundaryPoint.elevation,
      });
    }

    accumulated = end;
  }

  return {
    rawElevationSeries,
    smoothedElevationSeries,
    sectionBoundaryPoints,
    sectionGradeSeries,
  };
}

analyzeButton.addEventListener("click", async () => {
  error.textContent = "";

  try {
    if (latestRouteCoordinates.length < 2) {
      throw new Error("ルートが未確定です。ウェイポイントを調整して数秒待ってください。");
    }

    analyzeButton.disabled = true;
    analyzeButton.textContent = "解析中...";

    const level = levelSelect.value;
    const smoothingDistanceMeters = Number(smoothingDistanceInput.value);
    const sectionLengthMeters = Number(sectionLengthInput.value);
    const maxAbsGrade = Number(maxAbsGradeInput.value);

    const sampledCoordinates = downsample(latestRouteCoordinates, 2500);
    const lut = getOrBuildLut(level);

    let interpolationMarkedCount = 0;
    let coordinatesForAnalysis = sampledCoordinates;
    try {
      const { segments } = await fetchTunnelBridgeSegments(sampledCoordinates);
      const marked = markTunnelBridgeInterpolation(sampledCoordinates, segments, 20);
      coordinatesForAnalysis = marked.points;
      interpolationMarkedCount = marked.markedCount;
    } catch (osmError) {
      // OSM補助データが取れない場合は通常処理を継続
      console.warn("Failed to fetch tunnel/bridge geometries:", osmError);
    }

    const result = await computeNfdFromWaypoints(
      coordinatesForAnalysis,
      tileProvider,
      lut,
      {
        smoothingDistanceMeters,
        sectionLengthMeters,
        maxAbsGrade,
      },
    );

    latestProfile = result.profile;
  latestSections = result.sections;

    const {
      rawElevationSeries,
      smoothedElevationSeries,
      sectionBoundaryPoints,
      sectionGradeSeries,
    } = buildChartData(result.profile, result.sections);
    chart.data.datasets[0].data = rawElevationSeries;
    chart.data.datasets[1].data = smoothedElevationSeries;
    chart.data.datasets[2].data = sectionBoundaryPoints;
    chart.data.datasets[3].data = sectionGradeSeries;
    chart.update();

    const actualDistanceMeters = result.profile[result.profile.length - 1]?.distanceFromStart ?? 0;

    summary.innerHTML = [
      `入力点数: ${sampledCoordinates.length.toLocaleString()} 点`,
      `実距離: ${(actualDistanceMeters / 1000).toFixed(2)} km`,
      `NFD: ${result.nfdKm.toFixed(2)} km`,
      `NFD/実距離: ${(actualDistanceMeters > 0 ? result.nfdMeters / actualDistanceMeters : 0).toFixed(3)}`,
      `セクション数: ${result.sections.length.toLocaleString()}`,
      `内挿点(トンネル/橋推定): ${interpolationMarkedCount.toLocaleString()} 点`,
      `タイルキャッシュ: ${tileProvider.size.toLocaleString()} 枚`,
    ].join("<br>");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    error.textContent = message;
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.textContent = "解析";
  }
});
