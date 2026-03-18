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
const smoothingWindowInput = document.getElementById("smoothingWindow");
const minimumDistanceInput = document.getElementById("minimumDistance");
const maxAbsGradeInput = document.getElementById("maxAbsGrade");
const analyzeButton = document.getElementById("analyzeButton");
const clearButton = document.getElementById("clearButton");
const summary = document.getElementById("summary");
const error = document.getElementById("error");
const profileCanvas = document.getElementById("profileChart");

/** @type {GeoPoint[]} */
let latestRouteCoordinates = [];
/** @type {import("../src/course-gradient/analyzer").RouteProfilePoint[]} */
let latestProfile = [];

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

const initialWaypoints = [
  L.latLng(35.681236, 139.767125), // Tokyo Station
  L.latLng(35.710063, 139.8107), // Skytree
];

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
  if (chart) {
    chart.data.labels = [];
    chart.data.datasets[0].data = [];
    chart.data.datasets[1].data = [];
    chart.update();
  }
  hoverMarker.remove();
  summary.textContent = "ルートを作成して「解析」を押してください。";
  clearUiError();
});

const chart = new Chart(profileCanvas, {
  type: "line",
  data: {
    labels: [],
    datasets: [
      {
        label: "標高 [m]",
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
        tension: 0.1,
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

      const index = first.index;
      const point = latestProfile[index];
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

/**
 * @param {import("../src/course-gradient/analyzer").RouteProfilePoint[]} profile
 */
function buildChartData(profile) {
  const elevationSeries = [];
  const gradeSeries = [];

  for (let i = 0; i < profile.length; i += 1) {
    const current = profile[i];
    const x = current.distanceFromStart / 1000;

    elevationSeries.push({ x, y: current.elevation });

    if (i === 0) {
      gradeSeries.push({ x, y: 0 });
      continue;
    }

    const previous = profile[i - 1];
    const d = current.distanceFromStart - previous.distanceFromStart;
    const de = current.elevation - previous.elevation;
    const grade = d <= 0 ? 0 : (de / d) * 100;
    gradeSeries.push({ x, y: grade });
  }

  return { elevationSeries, gradeSeries };
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
    const smoothingWindow = Number(smoothingWindowInput.value);
    const minimumDistance = Number(minimumDistanceInput.value);
    const maxAbsGrade = Number(maxAbsGradeInput.value);

    const sampledCoordinates = downsample(latestRouteCoordinates, 2500);
    const lut = getOrBuildLut(level);

    const result = await computeNfdFromWaypoints(
      sampledCoordinates,
      tileProvider,
      lut,
      {
        smoothingWindow,
        minimumDistance,
        maxAbsGrade,
      },
    );

    latestProfile = result.profile;

    const { elevationSeries, gradeSeries } = buildChartData(result.profile);
    chart.data.datasets[0].data = elevationSeries;
    chart.data.datasets[1].data = gradeSeries;
    chart.update();

    const actualDistanceMeters = result.profile[result.profile.length - 1]?.distanceFromStart ?? 0;

    summary.innerHTML = [
      `入力点数: ${sampledCoordinates.length.toLocaleString()} 点`,
      `実距離: ${(actualDistanceMeters / 1000).toFixed(2)} km`,
      `NFD: ${result.nfdKm.toFixed(2)} km`,
      `NFD/実距離: ${(actualDistanceMeters > 0 ? result.nfdMeters / actualDistanceMeters : 0).toFixed(3)}`,
      `セクション数: ${result.sections.length.toLocaleString()}`,
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
