import { attachTreeNodes, buildTour, buildWalkwayGraph, parseTreesCsv } from "./routing.js";

const DEFAULT_CENTER = { lat: -34.4062, lng: 150.8789 };
const DEFAULT_ZOOM = 17;
const GEOLOCATION_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 12000,
  maximumAge: 12000,
};
const ARRIVAL_THRESHOLD_METERS = 18;

const state = {
  map: null,
  trees: [],
  graph: null,
  tour: null,
  selectedTreeId: null,
  arrivedTreeIds: new Set(),
  visitedTreeIds: new Set(),
  currentPosition: null,
  manualStart: null,
  startSource: null,
  pendingAutoBuild: false,
  watchId: null,
  treeMarkers: new Map(),
  selectedLabelMarker: null,
  userMarker: null,
  startMarker: null,
  routeLayer: null,
  walkwayLayer: null,
};

const elements = {
  statusChip: document.querySelector("#status-chip"),
  locationCopy: document.querySelector("#location-copy"),
  startMode: document.querySelector("#start-mode"),
  treeCount: document.querySelector("#tree-count"),
  routeDistance: document.querySelector("#route-distance"),
  routeTime: document.querySelector("#route-time"),
  routeCount: document.querySelector("#route-count"),
  gpsReadout: document.querySelector("#gps-readout"),
  errorText: document.querySelector("#error-text"),
  routeList: document.querySelector("#route-list"),
  treeDetail: document.querySelector("#tree-detail"),
  treePanel: document.querySelector("#tree-panel"),
  arrivedCount: document.querySelector("#arrived-count"),
  homeButton: document.querySelector("#home-btn"),
  locateButton: document.querySelector("#locate-btn"),
  recenterButton: document.querySelector("#recenter-btn"),
};

init().catch((error) => {
  console.error(error);
  showError(error.message || "App startup failed.");
  setStatus("Error");
  setButtonsDisabled(false);
});

async function init() {
  bindUi();
  setButtonsDisabled(true);
  setStatus("Loading");

  const [treesCsv, pathwaysGeojson] = await Promise.all([
    fetchText("./data/trees.csv", "Could not load tree CSV."),
    fetchJson("./data/pathways.geojson", "Could not load pathway GeoJSON."),
  ]);

  const trees = parseTreesCsv(treesCsv);
  const graph = buildWalkwayGraph(pathwaysGeojson);
  const routedTrees = attachTreeNodes(trees, graph);

  state.trees = routedTrees;
  state.graph = graph;

  createMap(getTreeCenter(routedTrees));
  renderWalkways();
  renderTrees();
  renderTreeCount();
  setStatus("Ready");
  elements.locationCopy.textContent =
    "Allow location to start from your GPS. If you deny access, use the current map center as the route start.";
  setButtonsDisabled(false);
  startLocationWatch();
}

function bindUi() {
  elements.locateButton.addEventListener("click", () => {
    state.startSource = "gps";
    state.pendingAutoBuild = true;
    renderStartMarker();

    if (state.currentPosition) {
      elements.startMode.textContent = "Live GPS";
      setStatus("GPS Live");
      buildAndRenderTour();
    } else {
      elements.startMode.textContent = "GPS pending";
      setStatus("Locating");
    }

    startLocationWatch(true);
  });
  elements.recenterButton.addEventListener("click", () => {
    if (state.currentPosition) {
      state.map.flyTo([state.currentPosition.lat, state.currentPosition.lng], 18, { duration: 0.8 });
      return;
    }

    if (state.manualStart) {
      state.map.flyTo([state.manualStart.lat, state.manualStart.lng], 18, { duration: 0.8 });
    }
  });

  elements.homeButton.addEventListener("click", () => {
    if (state.tour?.coordinates?.length) {
      const bounds = L.latLngBounds(state.tour.coordinates.map(([lat, lng]) => [lat, lng]));
      state.map.fitBounds(bounds.pad(0.1), { animate: true, duration: 1.5 });
      return;
    }

    const bounds = L.latLngBounds(state.trees.map((tree) => [tree.latitude, tree.longitude]));
    state.map.fitBounds(bounds.pad(0.22), { animate: true, duration: 0.8 });
  });
}

function createMap(center) {
  state.map = L.map("map", {
    zoomControl: false,
    preferCanvas: true,
  }).setView([center.lat, center.lng], DEFAULT_ZOOM);

  L.control.zoom({ position: "bottomright" }).addTo(state.map);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
    subdomains: "abcd",
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
  }).addTo(state.map);

  state.map.on("click", (event) => {
    setManualStart({ lat: event.latlng.lat, lng: event.latlng.lng });
  });
}

function renderWalkways() {
  if (state.walkwayLayer) {
    state.walkwayLayer.remove();
  }

  state.walkwayLayer = L.layerGroup(
    state.graph.walkwayLines.map((line) =>
      L.polyline(line, {
        color: "#7fa089",
        weight: 3,
        opacity: 0.55,
      }),
    ),
  ).addTo(state.map);
}

function renderTrees() {
  const markers = state.trees.map((tree) => {
    const marker = L.marker([tree.latitude, tree.longitude], {
      icon: createTreeIcon(tree.id),
    });
    marker.on("click", () => selectTree(tree.id, true));
    state.treeMarkers.set(tree.id, marker);
    return marker;
  });

  L.layerGroup(markers).addTo(state.map);
}

function startLocationWatch(triggeredByUser = false) {
  if (!("geolocation" in navigator)) {
    elements.locationCopy.textContent = "This browser does not support geolocation. Use the map center instead.";
    return;
  }

  clearError();

  if (state.watchId !== null) {
    return;
  }

  if (triggeredByUser) {
    elements.locationCopy.textContent = "Requesting your location permission now.";
  }

  state.watchId = navigator.geolocation.watchPosition(
    handleLocationSuccess,
    handleLocationError,
    GEOLOCATION_OPTIONS,
  );
}

function handleLocationSuccess(position) {
  state.currentPosition = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: position.coords.accuracy,
  };

  if (!state.startSource) {
    state.startSource = "gps";
  }

  renderUserMarker();
  renderStartMarker();
  updateArrivals();
  setStatus(state.startSource === "manual" ? "Manual Ready" : "GPS Live");
  elements.startMode.textContent = state.startSource === "manual" ? "Manual" : "Live GPS";
  elements.gpsReadout.textContent =
    `${state.currentPosition.lat.toFixed(5)}, ${state.currentPosition.lng.toFixed(5)} ` +
    `| +/-${Math.round(state.currentPosition.accuracy)} m`;

  if (state.startSource === "gps" && (state.pendingAutoBuild || !state.tour)) {
    state.pendingAutoBuild = false;
    buildAndRenderTour();
  }
}

function handleLocationError(error) {
  stopLocationWatch();

  if (state.manualStart) {
    state.startSource = "manual";
  } else if (state.startSource === "gps") {
    state.startSource = null;
  }

  if (error.code === error.PERMISSION_DENIED) {
    elements.locationCopy.textContent =
      "Location denied. Click the map or use the current center to choose a manual start point.";
    elements.startMode.textContent = state.manualStart ? "Manual" : "Manual needed";
    showError("Location access was denied. Manual start remains available.");
  } else if (error.code === error.TIMEOUT) {
    showError("Location timed out. You can retry or use map center.");
  } else {
    showError("Could not read your location. You can still build from map center.");
  }

  setStatus("Manual Ready");
  elements.gpsReadout.textContent = "No live GPS fix yet.";
}

function setManualStart(position) {
  state.manualStart = position;
  state.startSource = "manual";
  state.pendingAutoBuild = false;
  renderStartMarker();
  elements.startMode.textContent = "Manual";
  elements.gpsReadout.textContent = `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)} | map start`;
  setStatus("Manual Ready");
  clearError();
  buildAndRenderTour();
}

function renderUserMarker() {
  if (!state.currentPosition) {
    return;
  }

  if (!state.userMarker) {
    const icon = L.divIcon({
      className: "",
      html: '<span class="user-marker"></span>',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

    state.userMarker = L.marker([state.currentPosition.lat, state.currentPosition.lng], {
      icon,
      zIndexOffset: 1000,
    }).addTo(state.map);
  } else {
    state.userMarker.setLatLng([state.currentPosition.lat, state.currentPosition.lng]);
  }
}

function renderStartMarker() {
  const start = getActiveStart();

  if (!start) {
    if (state.startMarker) {
      state.startMarker.remove();
      state.startMarker = null;
    }

    return;
  }

  if (!state.startMarker) {
    state.startMarker = L.circleMarker([start.lat, start.lng], {
      radius: 8,
      color: "#154e36",
      weight: 2,
      fillColor: "#ffffff",
      fillOpacity: 1,
    }).addTo(state.map);
  } else {
    state.startMarker.setLatLng([start.lat, start.lng]);
  }
}

function buildAndRenderTour() {
  clearError();

  const start = getActiveStart();

  if (!start) {
    showError("Choose a start point from GPS or use the map center first.");
    return;
  }

  try {
    const tour = buildTour({
      start,
      trees: state.trees,
      graph: state.graph,
    });

    state.tour = tour;
    state.arrivedTreeIds = new Set();
    state.visitedTreeIds = new Set();
    renderRoute();
    renderTourSummary();
    updateArrivedCount();
    updateTreeMarkerStates();
    updateArrivals();

    if (tour.orderedStops[0]) {
      selectTree(tour.orderedStops[0].id, true);
    }

    const bounds = L.latLngBounds(tour.coordinates.map(([lat, lng]) => [lat, lng]));
    state.map.fitBounds(bounds.pad(0.08), { animate: true, duration: 0.8 });
    setStatus("Route Ready");
  } catch (error) {
    console.error(error);
    showError(error.message || "Could not build the walking route.");
  }
}

function renderRoute() {
  if (state.routeLayer) {
    state.routeLayer.remove();
  }

  state.routeLayer = L.polyline(state.tour.coordinates, {
    color: "#1d7a53",
    weight: 5,
    opacity: getRouteOpacity(),
    lineCap: "round",
    lineJoin: "round",
  }).addTo(state.map);
}

function renderTourSummary() {
  if (!state.tour) {
    return;
  }

  elements.routeDistance.textContent = formatDistance(state.tour.totalDistanceMeters);
  elements.routeTime.textContent = `${state.tour.estimatedMinutes} min`;
  elements.routeCount.textContent = `${state.tour.orderedStops.length} stops`;
  elements.routeList.innerHTML = "";

  const fragment = document.createDocumentFragment();

  state.tour.orderedStops.forEach((tree, index) => {
    const item = document.createElement("li");
    const row = document.createElement("div");
    row.className = "route-stop-row";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "route-stop";
    button.dataset.treeId = tree.id;
    button.innerHTML = `<strong>${index + 1}. ${tree.commonName}</strong><span>${tree.scientificName}</span>`;
    button.addEventListener("click", () => {
      selectTree(tree.id, true);
    });

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = `visit-toggle ${state.visitedTreeIds.has(tree.id) ? "is-on" : ""}`;
    toggle.textContent = state.visitedTreeIds.has(tree.id) ? "Visited" : "Visit";
    toggle.addEventListener("click", () => {
      toggleVisited(tree.id);
    });

    row.append(button, toggle);
    item.append(row);
    fragment.append(item);
  });

  elements.routeList.append(fragment);
  updateRouteSelection();
}

function selectTree(treeId, openPopup) {
  state.selectedTreeId = treeId;
  const tree = state.trees.find((item) => item.id === treeId);

  if (!tree) {
    return;
  }

  elements.treeDetail.innerHTML = "";
  elements.treeDetail.append(buildTreeCard(tree, false));
  updateTreeMarkerStates();
  updateRouteSelection();
  updateSelectedTreeLabel(tree);
  scrollSelectedTreePanelIntoView();

  if (openPopup) {
    state.map.flyTo([tree.latitude, tree.longitude], 18, { duration: 0.7 });
  }
}

function updateRouteSelection() {
  elements.routeList.querySelectorAll(".route-stop").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.treeId === state.selectedTreeId);
    button.classList.toggle("is-arrived", state.arrivedTreeIds.has(button.dataset.treeId));
    button.classList.toggle("is-visited", state.visitedTreeIds.has(button.dataset.treeId));
  });
}

function buildTreeCard(tree, compact) {
  const card = document.createElement("article");
  card.className = "tree-card";
  card.classList.toggle("is-selected", tree.id === state.selectedTreeId);
  card.classList.toggle("is-arrived", state.arrivedTreeIds.has(tree.id));
  card.classList.toggle("is-visited", state.visitedTreeIds.has(tree.id));

  const media = document.createElement("div");
  media.className = "tree-card-media";

  const ribbon = document.createElement("div");
  ribbon.className = "tree-card-ribbon";
  ribbon.append(buildTreeBadge("Selected", "is-selected"));

  if (state.arrivedTreeIds.has(tree.id)) {
    ribbon.append(buildTreeBadge("Arrived", "is-arrived"));
  }

  if (state.visitedTreeIds.has(tree.id)) {
    ribbon.append(buildTreeBadge("Visited", "is-visited"));
  }

  const image = document.createElement("img");
  image.src = encodeURI(`./images/${tree.photoFilename}`);
  image.alt = tree.commonName;
  image.loading = "lazy";

  image.addEventListener("error", () => {
    image.remove();
  });

  const body = document.createElement("div");
  body.className = "tree-body";
  body.innerHTML = `
    <div class="tree-header">
      <h3>${tree.commonName}</h3>
      <p class="tree-subtitle">${tree.scientificName}</p>
      <p class="tree-family">${tree.family}</p>
    </div>
    <dl class="tree-meta">
      <div>
        <dt>Status</dt>
        <dd>${state.visitedTreeIds.has(tree.id) ? "Visited" : state.arrivedTreeIds.has(tree.id) ? "Arrived" : "Active stop"}</dd>
      </div>
      <div>
        <dt>Route</dt>
        <dd>${getTreeRouteIndex(tree.id)}</dd>
      </div>
      <div>
        <dt>Latitude</dt>
        <dd>${tree.latitude.toFixed(6)}</dd>
      </div>
      <div>
        <dt>Longitude</dt>
        <dd>${tree.longitude.toFixed(6)}</dd>
      </div>
    </dl>
    <div class="tree-actions">
      <button type="button" class="tree-action ${state.visitedTreeIds.has(tree.id) ? "is-on" : ""}" data-tree-action="visit">
        ${state.visitedTreeIds.has(tree.id) ? "Visited" : "Mark Visited"}
      </button>
    </div>
  `;

  body.querySelector('[data-tree-action="visit"]')?.addEventListener("click", () => {
    toggleVisited(tree.id);
  });

  media.append(image, ribbon);
  card.append(media, body);
  return card;
}

function renderTreeCount() {
  elements.treeCount.textContent = String(state.trees.length);
  updateArrivedCount();
}

function getActiveStart() {
  if (state.startSource === "manual") {
    return state.manualStart;
  }

  if (state.startSource === "gps") {
    return state.currentPosition;
  }

  return state.currentPosition ?? state.manualStart;
}

function setStatus(text) {
  elements.statusChip.textContent = text;
}

function showError(message) {
  elements.errorText.hidden = false;
  elements.errorText.textContent = message;
}

function clearError() {
  elements.errorText.hidden = true;
  elements.errorText.textContent = "";
}

function setButtonsDisabled(disabled) {
  elements.homeButton.disabled = disabled;
  elements.locateButton.disabled = disabled;
  elements.recenterButton.disabled = disabled;
}

function stopLocationWatch() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
}

function getTreeCenter(trees) {
  if (!trees.length) {
    return DEFAULT_CENTER;
  }

  const totals = trees.reduce(
    (accumulator, tree) => {
      accumulator.lat += tree.latitude;
      accumulator.lng += tree.longitude;
      return accumulator;
    },
    { lat: 0, lng: 0 },
  );

  return {
    lat: totals.lat / trees.length,
    lng: totals.lng / trees.length,
  };
}

async function fetchText(url, errorMessage) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(errorMessage);
  }

  return response.text();
}

async function fetchJson(url, errorMessage) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(errorMessage);
  }

  return response.json();
}

function formatDistance(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

function createTreeIcon(treeId) {
  const classes = ["tree-marker"];

  if (state.visitedTreeIds.has(treeId)) {
    classes.push("is-visited");
  } else if (state.arrivedTreeIds.has(treeId)) {
    classes.push("is-arrived");
  } else if (state.selectedTreeId === treeId) {
    classes.push("is-selected");
  }

  return L.divIcon({
    className: "",
    html: `<span class="${classes.join(" ")}"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function updateTreeMarkerStates() {
  state.treeMarkers.forEach((marker, treeId) => {
    marker.setIcon(createTreeIcon(treeId));
  });
}

function updateArrivals() {
  if (!state.currentPosition || !state.tour) {
    return;
  }

  let changed = false;

  for (const tree of state.tour.orderedStops) {
    if (state.arrivedTreeIds.has(tree.id)) {
      continue;
    }

    const distance = distanceBetween(state.currentPosition, {
      lat: tree.latitude,
      lng: tree.longitude,
    });

    if (distance <= ARRIVAL_THRESHOLD_METERS) {
      state.arrivedTreeIds.add(tree.id);
      changed = true;
    }
  }

  if (changed) {
    updateArrivedCount();
    updateTreeMarkerStates();
    updateRouteSelection();
    updateRouteProgressAppearance();

    const selectedTree = state.trees.find((tree) => tree.id === state.selectedTreeId);

    if (selectedTree) {
      elements.treeDetail.innerHTML = "";
      elements.treeDetail.append(buildTreeCard(selectedTree, false));
    }
  }
}

function updateArrivedCount() {
  elements.arrivedCount.textContent = String(state.arrivedTreeIds.size);
}

function scrollSelectedTreePanelIntoView() {
  elements.treePanel?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
}

function distanceBetween(from, to) {
  const earthRadius = 6371000;
  const dLat = toRadians(to.lat - from.lat);
  const dLng = toRadians(to.lng - from.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.lat)) *
      Math.cos(toRadians(to.lat)) *
      Math.sin(dLng / 2) ** 2;

  return 2 * earthRadius * Math.asin(Math.sqrt(a));
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function toggleVisited(treeId) {
  if (state.visitedTreeIds.has(treeId)) {
    state.visitedTreeIds.delete(treeId);
  } else {
    state.visitedTreeIds.add(treeId);
  }

  updateTreeMarkerStates();
  updateRouteSelection();
  updateRouteProgressAppearance();

  const selectedTree = state.trees.find((tree) => tree.id === state.selectedTreeId);

  if (selectedTree) {
    elements.treeDetail.innerHTML = "";
    elements.treeDetail.append(buildTreeCard(selectedTree, false));
  }

  renderTourSummary();
}

function updateSelectedTreeLabel(tree) {
  if (!tree || !state.map) {
    if (state.selectedLabelMarker) {
      state.selectedLabelMarker.remove();
      state.selectedLabelMarker = null;
    }
    return;
  }

  const labelIcon = L.divIcon({
    className: "tree-name-label",
    html: `<span>${tree.commonName}</span>`,
    iconSize: null,
    iconAnchor: [0, 36],
  });

  if (!state.selectedLabelMarker) {
    state.selectedLabelMarker = L.marker([tree.latitude, tree.longitude], {
      icon: labelIcon,
      interactive: false,
      zIndexOffset: 1100,
    }).addTo(state.map);
  } else {
    state.selectedLabelMarker.setLatLng([tree.latitude, tree.longitude]);
    state.selectedLabelMarker.setIcon(labelIcon);
  }
}

function updateRouteProgressAppearance() {
  if (state.routeLayer) {
    state.routeLayer.setStyle({ opacity: getRouteOpacity() });
  }
}

function getRouteOpacity() {
  if (!state.tour?.orderedStops?.length) {
    return 0.92;
  }

  const completed = new Set([...state.arrivedTreeIds, ...state.visitedTreeIds]).size;
  const progress = completed / state.tour.orderedStops.length;
  return Math.max(0.22, 0.92 - progress * 0.6);
}

function getTreeRouteIndex(treeId) {
  if (!state.tour?.orderedStops?.length) {
    return "Not in route";
  }

  const index = state.tour.orderedStops.findIndex((tree) => tree.id === treeId);
  return index >= 0 ? `${index + 1} of ${state.tour.orderedStops.length}` : "Not in route";
}

function buildTreeBadge(text, modifier) {
  const badge = document.createElement("span");
  badge.className = `tree-card-badge ${modifier}`;
  badge.textContent = text;
  return badge;
}
