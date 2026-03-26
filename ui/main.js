import "leaflet/dist/leaflet.css";
import "leaflet-routing-machine/dist/leaflet-routing-machine.css";

import L from "leaflet";
import "leaflet-routing-machine";
import Chart from "chart.js/auto";

import {
  BIKE_TYPE_PRESETS,
  CYCLIST_PRESETS,
  buildNfdLut,
  computeNfd,
  computeNfdFromWaypoints,
  GsiDemTileElevationProvider,
} from "../src/index";

/** @typedef {{lat:number, lon:number}} GeoPoint */

const bikeTypeSelect = document.getElementById("bikeTypeSelect");
const cdaInput = document.getElementById("cdaInput");
const crrInput = document.getElementById("crrInput");
const massInput = document.getElementById("massInput");
const p0Input = document.getElementById("p0Input");
const minSpeedInput = document.getElementById("minSpeedInput");
const etaInput = document.getElementById("etaInput");
const analyzeButton = document.getElementById("analyzeButton");
const clearButton = document.getElementById("clearButton");
const exportButton = document.getElementById("exportButton");
const swapSgButton = document.getElementById("swapSgButton");
const summary = document.getElementById("summary");
const error = document.getElementById("error");
const profileCanvas = document.getElementById("profileChart");

/** @type {GeoPoint[]} */
let latestRouteCoordinates = [];
/** @type {import("../src/course-gradient/analyzer").RouteProfilePoint[]} */
let latestProfile = [];

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

const FIXED_SG_INTERVAL_METERS = 25;
const FIXED_SG_WINDOW_SIZE = 11;
const FIXED_SG_POLYNOMIAL_ORDER = 3;
const FIXED_MAX_ABS_GRADE = 30;
const POLYLINE_DRAG_HIT_TOLERANCE_METERS = 20;
const POLYLINE_DRAG_MOVE_THRESHOLD_METERS = 8;
const DOM_DRAG_MOVE_THRESHOLD_PX = 6;
const CLICK_SUPPRESS_WINDOW_MS = 220;
const CLICK_SUPPRESS_RADIUS_PX = 18;
const ENABLE_ROUTE_DEBUG_LOG = true;
const DEFAULT_CYCLIST_PARAMS = CYCLIST_PRESETS.intermediate;

let suppressNextMapClick = false;
let suppressMapClickUntilMs = 0;
let suppressMapClickClientPoint = null;
const polylineDragState = {
  active: false,
  startLatLng: null,
  hasMoved: false,
};

const domDragState = {
  active: false,
  pointerId: null,
  startX: 0,
  startY: 0,
  moved: false,
};

function debugLog(eventName, payload = {}) {
  if (!ENABLE_ROUTE_DEBUG_LOG) {
    return;
  }
  console.log(`[route-ui] ${eventName}`, {
    at: new Date().toISOString(),
    ...payload,
  });
}

function suppressMapClickTemporarily(
  reason,
  {
    windowMs = CLICK_SUPPRESS_WINDOW_MS,
    setNextClickFlag = false,
    clientX = null,
    clientY = null,
  } = {},
) {
  if (setNextClickFlag) {
    suppressNextMapClick = true;
  }
  suppressMapClickUntilMs = Math.max(suppressMapClickUntilMs, performance.now() + windowMs);
  if (typeof clientX === "number" && typeof clientY === "number") {
    suppressMapClickClientPoint = { x: clientX, y: clientY };
  }
  debugLog("map.click:suppress-window", {
    reason,
    windowMs,
    setNextClickFlag,
    suppressMapClickClientPoint,
    suppressMapClickUntilMs: Number(suppressMapClickUntilMs.toFixed(1)),
  });
}

function isLeafletInteractiveTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }
  return target.classList.contains("leaflet-interactive");
}

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

function getCurrentWaypoints() {
  return routingControl.getWaypoints()
    .map((w) => w.latLng)
    .filter((v) => v !== null);
}

function setWaypointsAndClearError(waypoints) {
  debugLog("setWaypoints", {
    count: waypoints.length,
    points: waypoints.map((p, i) => ({
      index: i,
      lat: Number(p.lat.toFixed(6)),
      lng: Number(p.lng.toFixed(6)),
    })),
  });
  routingControl.setWaypoints(waypoints);
  clearUiError();
}

function projectPointToSegment(pointLatLng, aLatLng, bLatLng) {
  const p = map.latLngToLayerPoint(pointLatLng);
  const a = map.latLngToLayerPoint(aLatLng);
  const b = map.latLngToLayerPoint(bLatLng);
  const ab = b.subtract(a);
  const ap = p.subtract(a);
  const len2 = (ab.x * ab.x) + (ab.y * ab.y);

  if (len2 === 0) {
    return {
      latLng: aLatLng,
      t: 0,
      distanceMeters: map.distance(pointLatLng, aLatLng),
    };
  }

  const rawT = ((ap.x * ab.x) + (ap.y * ab.y)) / len2;
  const t = Math.max(0, Math.min(1, rawT));
  const projectionPoint = L.point(a.x + (ab.x * t), a.y + (ab.y * t));
  const projectionLatLng = map.layerPointToLatLng(projectionPoint);

  return {
    latLng: projectionLatLng,
    t,
    distanceMeters: map.distance(pointLatLng, projectionLatLng),
  };
}

function toRouteLatLngs(routeCoordinates) {
  return routeCoordinates.map((c) => L.latLng(c.lat, c.lon));
}

function buildRouteCumulativeDistances(routeLatLngs) {
  const cumulative = [0];
  for (let i = 1; i < routeLatLngs.length; i += 1) {
    cumulative.push(cumulative[i - 1] + map.distance(routeLatLngs[i - 1], routeLatLngs[i]));
  }
  return cumulative;
}

function projectOntoRoute(latLng, routeLatLngs, cumulativeDistances = null) {
  if (!Array.isArray(routeLatLngs) || routeLatLngs.length < 2) {
    return null;
  }

  const cumulative = cumulativeDistances ?? buildRouteCumulativeDistances(routeLatLngs);
  let best = null;

  for (let i = 0; i < routeLatLngs.length - 1; i += 1) {
    const projected = projectPointToSegment(latLng, routeLatLngs[i], routeLatLngs[i + 1]);
    const segmentLength = cumulative[i + 1] - cumulative[i];
    const progress = cumulative[i] + (segmentLength * projected.t);
    if (!best || projected.distanceMeters < best.distanceMeters) {
      best = {
        latLng: projected.latLng,
        distanceMeters: projected.distanceMeters,
        segmentIndex: i,
        progress,
      };
    }
  }

  return best;
}

function computeInsertIndexByRouteProgress(routeProjection, waypoints, routeLatLngs, cumulativeDistances) {
  if (waypoints.length <= 1) {
    return waypoints.length;
  }

  for (let i = 1; i < waypoints.length; i += 1) {
    const waypointProjection = projectOntoRoute(waypoints[i], routeLatLngs, cumulativeDistances);
    if (waypointProjection && routeProjection.progress <= waypointProjection.progress) {
      return i;
    }
  }

  return waypoints.length - 1;
}

function removeWaypointAt(index) {
  const current = getCurrentWaypoints();
  if (index < 0 || index >= current.length) {
    debugLog("removeWaypoint:invalidIndex", { index, count: current.length });
    showUiError("削除対象の地点が見つかりませんでした。");
    return;
  }
  debugLog("removeWaypoint", { index, beforeCount: current.length });
  const next = current.filter((_, i) => i !== index);
  setWaypointsAndClearError(next);
}

function swapStartGoal() {
  const current = getCurrentWaypoints();
  if (current.length < 2) {
    debugLog("swapStartGoal:skipped", { reason: "insufficient-points", count: current.length });
    showUiError("S/G入れ替えには2点以上必要です。");
    return;
  }

  const swapped = [...current];
  const lastIndex = swapped.length - 1;
  [swapped[0], swapped[lastIndex]] = [swapped[lastIndex], swapped[0]];
  debugLog("swapStartGoal", {
    count: swapped.length,
    start: { lat: Number(swapped[0].lat.toFixed(6)), lng: Number(swapped[0].lng.toFixed(6)) },
    goal: { lat: Number(swapped[lastIndex].lat.toFixed(6)), lng: Number(swapped[lastIndex].lng.toFixed(6)) },
  });
  setWaypointsAndClearError(swapped);
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
    const roleText = role === "start" ? "スタート" : (role === "goal" ? "ゴール" : `経由点 ${label}`);

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

    marker.bindPopup(`<button type=\"button\" data-delete-waypoint>${roleText}を削除</button>`);
    marker.on("popupopen", (ev) => {
      const root = ev.popup.getElement();
      const button = root?.querySelector("button[data-delete-waypoint]");
      button?.addEventListener("click", () => {
        map.closePopup();
        removeWaypointAt(index);
      }, { once: true });
    });

    return marker;
  },
}).addTo(map);

routingControl.on("routesfound", (event) => {
  const route = event.routes?.[0];
  if (!route || !Array.isArray(route.coordinates)) {
    debugLog("routesfound:empty", {
      hasRoutes: Boolean(event.routes),
      routeCount: event.routes?.length ?? 0,
    });
    latestRouteCoordinates = [];
    return;
  }

  latestRouteCoordinates = route.coordinates.map((c) => ({ lat: c.lat, lon: c.lng }));
  debugLog("routesfound", {
    coordinateCount: latestRouteCoordinates.length,
    waypointCount: getCurrentWaypoints().length,
  });
});

const mapContainer = map.getContainer();
mapContainer.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 0) {
    return;
  }

  domDragState.active = true;
  domDragState.pointerId = ev.pointerId;
  domDragState.startX = ev.clientX;
  domDragState.startY = ev.clientY;
  domDragState.moved = false;
  debugLog("dom.pointerdown", {
    x: ev.clientX,
    y: ev.clientY,
    targetTag: ev.target?.tagName,
    targetClass: ev.target?.className ?? "",
  });
}, true);

mapContainer.addEventListener("pointermove", (ev) => {
  if (!domDragState.active || domDragState.pointerId !== ev.pointerId) {
    return;
  }

  const dx = ev.clientX - domDragState.startX;
  const dy = ev.clientY - domDragState.startY;
  const movedPx = Math.hypot(dx, dy);
  if (movedPx >= DOM_DRAG_MOVE_THRESHOLD_PX && !domDragState.moved) {
    domDragState.moved = true;
    debugLog("dom.pointermove:drag", {
      movedPx: Number(movedPx.toFixed(1)),
    });
  }
}, true);

mapContainer.addEventListener("pointerup", (ev) => {
  if (!domDragState.active || domDragState.pointerId !== ev.pointerId) {
    return;
  }

  const dx = ev.clientX - domDragState.startX;
  const dy = ev.clientY - domDragState.startY;
  const movedPx = Math.hypot(dx, dy);
  debugLog("dom.pointerup", {
    x: ev.clientX,
    y: ev.clientY,
    movedPx: Number(movedPx.toFixed(1)),
    moved: domDragState.moved,
    suppressNextMapClick,
    targetTag: ev.target?.tagName,
    targetClass: ev.target?.className ?? "",
  });

  if (domDragState.moved && isLeafletInteractiveTarget(ev.target)) {
    suppressMapClickTemporarily("dom-pointer-drag-interactive", {
      clientX: ev.clientX,
      clientY: ev.clientY,
    });
  }

  domDragState.active = false;
  domDragState.pointerId = null;
  domDragState.moved = false;
}, true);

mapContainer.addEventListener("pointercancel", () => {
  if (!domDragState.active) {
    return;
  }
  debugLog("dom.pointercancel", {});
  domDragState.active = false;
  domDragState.pointerId = null;
  domDragState.moved = false;
}, true);

map.on("click", (e) => {
  const now = performance.now();
  const inSuppressWindow = now < suppressMapClickUntilMs;
  const clickClientX = typeof e.originalEvent?.clientX === "number" ? e.originalEvent.clientX : null;
  const clickClientY = typeof e.originalEvent?.clientY === "number" ? e.originalEvent.clientY : null;
  let inSuppressRadius = true;
  if (suppressMapClickClientPoint && clickClientX !== null && clickClientY !== null) {
    const dx = clickClientX - suppressMapClickClientPoint.x;
    const dy = clickClientY - suppressMapClickClientPoint.y;
    inSuppressRadius = Math.hypot(dx, dy) <= CLICK_SUPPRESS_RADIUS_PX;
  }
  const shouldSuppressByWindow = inSuppressWindow && inSuppressRadius;
  debugLog("map.click:start", {
    suppressNextMapClick,
    inSuppressWindow,
    inSuppressRadius,
    shouldSuppressByWindow,
    clickClientX,
    clickClientY,
    lat: Number(e.latlng.lat.toFixed(6)),
    lng: Number(e.latlng.lng.toFixed(6)),
  });
  if (suppressNextMapClick || shouldSuppressByWindow) {
    debugLog("map.click:suppressed", {
      reason: suppressNextMapClick ? "flag" : "window+radius",
      lat: Number(e.latlng.lat.toFixed(6)),
      lng: Number(e.latlng.lng.toFixed(6)),
    });
    suppressNextMapClick = false;
    return;
  }

  const current = getCurrentWaypoints();
  debugLog("map.click:beforeUpdate", { waypointCount: current.length });

  if (current.length < 2) {
    current.push(e.latlng);
  } else {
    // 既存ゴールを最後の経由点として残し、クリック点を新しいゴールにする
    current.push(e.latlng);
  }
  debugLog("map.click:apply", {
    nextCount: current.length,
    mode: current.length <= 2 ? "set-initial" : "set-new-goal",
  });
  setWaypointsAndClearError(current);
});

map.on("mousedown", (e) => {
  debugLog("map.mousedown", {
    lat: Number(e.latlng.lat.toFixed(6)),
    lng: Number(e.latlng.lng.toFixed(6)),
    routeCoordinateCount: latestRouteCoordinates.length,
  });
  if (latestRouteCoordinates.length < 2) {
    debugLog("map.mousedown:skip", { reason: "no-route" });
    return;
  }

  const routeLatLngs = toRouteLatLngs(latestRouteCoordinates);
  const hit = projectOntoRoute(e.latlng, routeLatLngs);
  if (!hit || hit.distanceMeters > POLYLINE_DRAG_HIT_TOLERANCE_METERS) {
    debugLog("map.mousedown:skip", {
      reason: "outside-polyline-hit-area",
      distanceMeters: hit ? Number(hit.distanceMeters.toFixed(2)) : null,
    });
    return;
  }

  polylineDragState.active = true;
  polylineDragState.startLatLng = e.latlng;
  polylineDragState.hasMoved = false;
  debugLog("map.mousedown:drag-start", {
    distanceMeters: Number(hit.distanceMeters.toFixed(2)),
  });
  map.dragging.disable();
});

map.on("mousemove", (e) => {
  if (!polylineDragState.active || !polylineDragState.startLatLng) {
    return;
  }

  const movedMeters = map.distance(polylineDragState.startLatLng, e.latlng);
  if (movedMeters >= POLYLINE_DRAG_MOVE_THRESHOLD_METERS) {
    polylineDragState.hasMoved = true;
    debugLog("map.mousemove:dragging", {
      movedMeters: Number(movedMeters.toFixed(2)),
    });
  }
});

map.on("mouseup", (e) => {
  debugLog("map.mouseup:start", {
    active: polylineDragState.active,
    hasMoved: polylineDragState.hasMoved,
    lat: Number(e.latlng.lat.toFixed(6)),
    lng: Number(e.latlng.lng.toFixed(6)),
  });
  if (!polylineDragState.active) {
    debugLog("map.mouseup:skip", { reason: "drag-not-active" });
    return;
  }

  if (map.dragging && !map.dragging.enabled()) {
    map.dragging.enable();
  }

  polylineDragState.active = false;
  const shouldInsert = polylineDragState.hasMoved;
  polylineDragState.startLatLng = null;
  polylineDragState.hasMoved = false;

  // ドラッグ操作後に Leaflet の click が連鎖してゴール更新されるのを防ぐ
  if (shouldInsert) {
    const mouseUpClientX = typeof e.originalEvent?.clientX === "number" ? e.originalEvent.clientX : null;
    const mouseUpClientY = typeof e.originalEvent?.clientY === "number" ? e.originalEvent.clientY : null;
    suppressMapClickTemporarily("polyline-drag-insert", {
      setNextClickFlag: true,
      clientX: mouseUpClientX,
      clientY: mouseUpClientY,
    });
    debugLog("map.mouseup:suppress-next-click", { shouldInsert });
  }

  if (!shouldInsert || latestRouteCoordinates.length < 2) {
    debugLog("map.mouseup:skip-insert", {
      shouldInsert,
      routeCoordinateCount: latestRouteCoordinates.length,
    });
    return;
  }

  const currentWaypoints = getCurrentWaypoints();
  if (currentWaypoints.length < 2) {
    debugLog("map.mouseup:skip-insert", {
      reason: "insufficient-waypoints",
      waypointCount: currentWaypoints.length,
    });
    return;
  }

  const routeLatLngs = toRouteLatLngs(latestRouteCoordinates);
  const cumulativeDistances = buildRouteCumulativeDistances(routeLatLngs);
  const projection = projectOntoRoute(e.latlng, routeLatLngs, cumulativeDistances);
  if (!projection || projection.distanceMeters > POLYLINE_DRAG_HIT_TOLERANCE_METERS) {
    debugLog("map.mouseup:skip-insert", {
      reason: "outside-polyline-hit-area",
      distanceMeters: projection ? Number(projection.distanceMeters.toFixed(2)) : null,
    });
    return;
  }

  const insertIndex = computeInsertIndexByRouteProgress(
    projection,
    currentWaypoints,
    routeLatLngs,
    cumulativeDistances,
  );

  const next = [...currentWaypoints];
  next.splice(insertIndex, 0, projection.latLng);
  debugLog("map.mouseup:insert-via", {
    insertIndex,
    beforeCount: currentWaypoints.length,
    afterCount: next.length,
    projectionDistanceMeters: Number(projection.distanceMeters.toFixed(2)),
    projectionProgress: Number(projection.progress.toFixed(2)),
  });
  setWaypointsAndClearError(next);
});

swapSgButton?.addEventListener("click", () => {
  swapStartGoal();
});

clearButton.addEventListener("click", () => {
  routingControl.setWaypoints([...initialWaypoints]);
  latestRouteCoordinates = [];
  latestProfile = [];
  if (chart) {
    chart.data.labels = [];
    chart.data.datasets[0].data = [];
    chart.data.datasets[1].data = [];
    chart.data.datasets[2].data = [];
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

function buildLutCacheKey(params) {
  return [
    params.mass,
    params.Crr,
    params.CdA,
    params.rho,
    params.eta,
    params.flatPower,
    params.vMin,
  ].map((v) => Number(v).toFixed(6)).join("|");
}

function setDetailInputsFromBikeType(bikeType) {
  const bikePreset = BIKE_TYPE_PRESETS[bikeType] ?? BIKE_TYPE_PRESETS.road;
  cdaInput.value = String(bikePreset.CdA);
  crrInput.value = String(bikePreset.Crr);
  massInput.value = String(bikePreset.mass);
  etaInput.value = String(bikePreset.eta);
}

function buildCyclistParamsFromUi() {
  const cda = Number(cdaInput.value);
  const crr = Number(crrInput.value);
  const mass = Number(massInput.value);
  const flatPower = Number(p0Input.value);
  const minSpeedKmh = Number(minSpeedInput.value);
  const eta = Number(etaInput.value);

  if (
    !Number.isFinite(cda)
    || !Number.isFinite(crr)
    || !Number.isFinite(mass)
    || !Number.isFinite(flatPower)
    || !Number.isFinite(minSpeedKmh)
    || !Number.isFinite(eta)
  ) {
    throw new Error("詳細オプションの数値入力が不正です。");
  }

  if (cda <= 0 || crr <= 0 || mass <= 0 || flatPower <= 0 || minSpeedKmh <= 0) {
    throw new Error("CdA, Crr, 重量, P_0, 最低速度には正の値を指定してください。");
  }
  if (eta <= 0 || eta > 1) {
    throw new Error("駆動効率 η は 0 より大きく 1 以下で指定してください。");
  }

  return {
    ...DEFAULT_CYCLIST_PARAMS,
    CdA: cda,
    Crr: crr,
    mass,
    flatPower,
    vMin: minSpeedKmh / 3.6,
    eta,
  };
}

function getOrBuildLut(params) {
  const key = buildLutCacheKey(params);
  const existing = lutCache.get(key);
  if (existing) return existing;
  const lut = buildNfdLut(params);
  lutCache.set(key, lut);
  return lut;
}

function buildSectionsFromProfile(profile, maxAbsGrade = FIXED_MAX_ABS_GRADE) {
  const sections = [];
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
    const grade = Math.max(-maxAbsGrade, Math.min(maxAbsGrade, rawGrade));
    sections.push({ distance, grade });
  }
  return sections;
}

function buildNfdSummaryLines(profile, cyclistParams, defaultNfdKm) {
  const sections = buildSectionsFromProfile(profile, FIXED_MAX_ABS_GRADE);
  const baseP0 = cyclistParams.flatPower;
  const standardPowers = [100, 150, 200];
  const tolerance = 1e-9;

  const isStandardPower = standardPowers.some((p0) => Math.abs(baseP0 - p0) < tolerance);
  const powersToShow = isStandardPower ? standardPowers : [...standardPowers, baseP0];

  return powersToShow.map((p0) => {
    const isCustom = !standardPowers.includes(p0);
    const nfdKm = isCustom
      ? (sections.length > 0
        ? computeNfd(sections, getOrBuildLut({ ...cyclistParams, flatPower: p0 })) / 1000
        : defaultNfdKm)
      : (sections.length > 0
        ? computeNfd(sections, getOrBuildLut({ ...cyclistParams, flatPower: p0 })) / 1000
        : defaultNfdKm);
    const label = isCustom ? `NFD (P_0=${p0.toFixed(1)}W, custom)` : `NFD (P_0=${p0}W)`;
    return `${label}: ${nfdKm.toFixed(2)} km`;
  });
}

setDetailInputsFromBikeType(bikeTypeSelect.value);
bikeTypeSelect.addEventListener("change", () => {
  setDetailInputsFromBikeType(bikeTypeSelect.value);
});

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
 */
function buildChartData(profile) {
  const rawElevationSeries = [];
  const smoothedElevationSeries = [];
  const gradeSeries = [];

  for (let i = 0; i < profile.length; i += 1) {
    const current = profile[i];
    const x = current.distanceFromStart / 1000;

    rawElevationSeries.push({ x, y: current.rawElevation });
    smoothedElevationSeries.push({ x, y: current.elevation });

  }

  // 勾配は「平滑化済み標高」を距離で差分して生成する
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

    const elevationDiff = curr.elevation - prev.elevation;
    const grade = (elevationDiff / distance) * 100;
    const midX = (prev.distanceFromStart + curr.distanceFromStart) / 2000;
    gradeSeries.push({ x: midX, y: grade });
  }

  return {
    rawElevationSeries,
    smoothedElevationSeries,
    gradeSeries,
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

    const cyclistParams = buildCyclistParamsFromUi();
    const sampledCoordinates = downsample(latestRouteCoordinates, 2500);
    const lut = getOrBuildLut(cyclistParams);

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

    // Build options for Savitzky-Golay smoothing (only method now)
    const analysisOptions = {
      maxAbsGrade: FIXED_MAX_ABS_GRADE,
      useSavitzkyGolay: true,
      savitzkyGolayInterval: FIXED_SG_INTERVAL_METERS,
      savitzkyGolayWindowSize: FIXED_SG_WINDOW_SIZE,
      savitzkyGolayPolynomialOrder: FIXED_SG_POLYNOMIAL_ORDER,
    };

    const result = await computeNfdFromWaypoints(
      coordinatesForAnalysis,
      tileProvider,
      lut,
      analysisOptions,
    );

    latestProfile = result.profile;

    const {
      rawElevationSeries,
      smoothedElevationSeries,
      gradeSeries,
    } = buildChartData(result.profile);
    chart.data.datasets[0].data = rawElevationSeries;
    chart.data.datasets[1].data = smoothedElevationSeries;
    chart.data.datasets[2].data = gradeSeries;
    chart.update();

    const actualDistanceMeters = result.profile[result.profile.length - 1]?.distanceFromStart ?? 0;

    const nfdLines = buildNfdSummaryLines(result.profile, cyclistParams, result.nfdKm);

    summary.innerHTML = [
      `入力点数: ${sampledCoordinates.length.toLocaleString()} 点`,
      `実距離: ${(actualDistanceMeters / 1000).toFixed(2)} km`,
      ...nfdLines,
      `NFD/実距離: ${(actualDistanceMeters > 0 ? result.nfdMeters / actualDistanceMeters : 0).toFixed(3)}`,
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
