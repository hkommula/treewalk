import { attachTreeNodes, buildTour, buildWalkwayGraph, parseTreesCsv } from "./routing.js";

const DEFAULT_CENTER = { lat: -34.4062, lng: 150.8789 };
const DEFAULT_ZOOM = 17;
const GEOLOCATION_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 12000,
  maximumAge: 12000,
};
const ARRIVAL_THRESHOLD_METERS = 18;
const VIBRATION_MAX_DISTANCE_METERS = 25;

const state = {
  map: null,
  trees: [],
  graph: null,
  tour: null,
  selectedTreeId: null,
  arrivedTreeIds: new Set(),
  visitedTreeIds: new Set(),
  currentPosition: null,
  currentHeading: null,
  manualStart: null,
  startSource: null,
  pendingAutoBuild: false,
  pendingLocateCenter: false,
  watchId: null,
  treeMarkers: new Map(),
  selectedLabelMarker: null,
  userMarker: null,
  userAccuracyCircle: null,
  startMarker: null,
  routeLayer: null,
  walkwayLayer: null,
  lastVibrationAt: 0,
};

const elements = {
  statusChip: document.querySelector("#status-chip"),
  treeCount: document.querySelector("#tree-count"),
  routeDistance: document.querySelector("#route-distance"),
  routeTime: document.querySelector("#route-time"),
  routeCount: document.querySelector("#route-count"),
  nextTreeName: document.querySelector("#next-tree-name"),
  nextTreeDistance: document.querySelector("#next-tree-distance"),
  gpsReadout: document.querySelector("#gps-readout"),
  errorText: document.querySelector("#error-text"),
  routeList: document.querySelector("#route-list"),
  treeDetail: document.querySelector("#tree-detail"),
  sidebar: document.querySelector(".sidebar"),
  tourPanel: document.querySelector("#tour-panel"),
  treePanel: document.querySelector("#tree-panel"),
  arrivedCount: document.querySelector("#arrived-count"),
  mapControlGroup: document.querySelector("#map-control-group"),
  mapControlsToggle: document.querySelector("#map-controls-toggle"),
  homeButton: document.querySelector("#home-btn"),
  locateButton: document.querySelector("#locate-btn"),
  resetVisitedButton: document.querySelector("#reset-visited-btn"),
  resetVisitedInlineButton: document.querySelector("#reset-visited-inline-btn"),
  zoomInButton: document.querySelector("#zoom-in-btn"),
  zoomOutButton: document.querySelector("#zoom-out-btn"),
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
  setButtonsDisabled(false);
  showTourPanel();
  startLocationWatch();
}

function bindUi() {
  elements.mapControlsToggle.addEventListener("click", () => {
    const isOpen = elements.mapControlGroup.classList.toggle("is-open");
    elements.mapControlsToggle.setAttribute("aria-expanded", String(isOpen));
  });

  elements.locateButton.addEventListener("click", () => {
    state.startSource = "gps";
    state.pendingAutoBuild = true;
    state.pendingLocateCenter = true;
    renderStartMarker();

    if (state.currentPosition) {
      setStatus("GPS Live");
      focusMapOnPoint([state.currentPosition.lat, state.currentPosition.lng], { zoom: 18, duration: 0.8 });
      buildAndRenderTour();
    } else {
      setStatus("Locating");
    }

    startLocationWatch(true);
  });

  elements.homeButton.addEventListener("click", () => {
    if (state.tour?.coordinates?.length) {
      const bounds = L.latLngBounds(state.tour.coordinates.map(([lat, lng]) => [lat, lng]));
      fitMapToBounds(bounds.pad(0.1), { duration: 1.5 });
      return;
    }

    const bounds = L.latLngBounds(state.trees.map((tree) => [tree.latitude, tree.longitude]));
    fitMapToBounds(bounds.pad(0.22), { duration: 0.8 });
  });

  elements.resetVisitedButton.addEventListener("click", resetVisitedTrees);
  elements.resetVisitedInlineButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    resetVisitedTrees();
  });
  elements.zoomInButton.addEventListener("click", () => state.map?.zoomIn());
  elements.zoomOutButton.addEventListener("click", () => state.map?.zoomOut());
}

function createMap(center) {
  state.map = L.map("map", {
    zoomControl: false,
    preferCanvas: true,
  }).setView([center.lat, center.lng], DEFAULT_ZOOM);

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
    setStatus("Manual Start");
    showError("This browser does not support geolocation. Tap the map to choose a manual start.");
    return;
  }

  clearError();

  if (state.watchId !== null) {
    return;
  }

  if (triggeredByUser) {
    setStatus("Locating");
  }

  state.watchId = navigator.geolocation.watchPosition(
    handleLocationSuccess,
    handleLocationError,
    GEOLOCATION_OPTIONS,
  );
}

function handleLocationSuccess(position) {
  const previousPosition = state.currentPosition;
  state.currentPosition = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: position.coords.accuracy,
  };
  state.currentHeading = getPreferredHeading(position.coords.heading, previousPosition, state.currentPosition, state.currentHeading);

  if (!state.startSource) {
    state.startSource = "gps";
  }

  renderUserMarker();
  renderStartMarker();
  updateArrivals();
  updateNextTreeGuidance();
  setStatus(state.startSource === "manual" ? "Manual Start" : "GPS Live");
  elements.gpsReadout.textContent =
    `${state.currentPosition.lat.toFixed(5)}, ${state.currentPosition.lng.toFixed(5)} ` +
    `| +/-${Math.round(state.currentPosition.accuracy)} m`;

  if (state.pendingLocateCenter) {
    state.pendingLocateCenter = false;
    focusMapOnPoint([state.currentPosition.lat, state.currentPosition.lng], { zoom: 18, duration: 0.8 });
  }

  if (state.startSource === "gps" && (state.pendingAutoBuild || !state.tour)) {
    state.pendingAutoBuild = false;
    buildAndRenderTour();
  }

  maybeVibrateForNextTree();
}

function handleLocationError(error) {
  stopLocationWatch();
  state.pendingLocateCenter = false;

  if (state.manualStart) {
    state.startSource = "manual";
  } else if (state.startSource === "gps") {
    state.startSource = null;
  }

  if (error.code === error.PERMISSION_DENIED) {
    showError("Location access was denied. Manual start remains available.");
  } else if (error.code === error.TIMEOUT) {
    showError("Location timed out. You can retry or tap the map for a manual start.");
  } else {
    showError("Could not read your location. You can still build from a manual map start.");
  }

  setStatus("Manual Start");
  elements.gpsReadout.textContent = "No live GPS fix yet.";
}

function setManualStart(position) {
  state.manualStart = position;
  state.startSource = "manual";
  state.pendingAutoBuild = false;
  renderStartMarker();
  elements.gpsReadout.textContent = `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)} | map start`;
  setStatus("Manual Start");
  clearError();
  buildAndRenderTour();
}

function renderUserMarker() {
  if (!state.currentPosition) {
    return;
  }

  const icon = createUserIcon();
  const latLng = [state.currentPosition.lat, state.currentPosition.lng];

  if (!state.userMarker) {
    state.userMarker = L.marker(latLng, {
      icon,
      zIndexOffset: 1000,
    }).addTo(state.map);
  } else {
    state.userMarker.setLatLng(latLng);
    state.userMarker.setIcon(icon);
  }

  if (!state.userAccuracyCircle) {
    state.userAccuracyCircle = L.circle(latLng, {
      radius: state.currentPosition.accuracy,
      color: "rgba(46, 127, 255, 0.22)",
      weight: 1,
      fillColor: "rgba(46, 127, 255, 0.16)",
      fillOpacity: 1,
      interactive: false,
    }).addTo(state.map);
  } else {
    state.userAccuracyCircle.setLatLng(latLng);
    state.userAccuracyCircle.setRadius(state.currentPosition.accuracy);
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
    showError("Choose a start point from GPS or tap the map for a manual start.");
    return;
  }

  try {
    const tour = buildTour({
      start,
      trees: state.trees,
      graph: state.graph,
    });

    state.tour = tour;
    state.selectedTreeId = null;
    state.arrivedTreeIds = new Set();
    state.visitedTreeIds = new Set();
    updateSelectedTreeLabel(null);
    renderRoute();
    renderTourSummary();
    updateArrivedCount();
    updateTreeMarkerStates();
    updateArrivals();
    updateNextTreeGuidance();
    renderSelectedTreeEmptyState();
    showTourPanel();

    const bounds = L.latLngBounds(tour.coordinates.map(([lat, lng]) => [lat, lng]));
    fitMapToBounds(bounds.pad(0.08), { duration: 0.8 });
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

    row.append(button);
    item.append(row);
    fragment.append(item);
  });

  elements.routeList.append(fragment);
  updateRouteSelection();
  updateNextTreeGuidance();
}

function selectTree(treeId, openPopup) {
  state.selectedTreeId = treeId;
  const tree = state.trees.find((item) => item.id === treeId);

  if (!tree) {
    return;
  }

  elements.treeDetail.innerHTML = "";
  elements.treeDetail.append(buildTreeCard(tree, false));
  showSelectedTreePanel();
  updateTreeMarkerStates();
  updateRouteSelection();
  updateSelectedTreeLabel(tree);

  if (openPopup) {
    focusMapOnPoint([tree.latitude, tree.longitude], { zoom: 18, duration: 0.7 });
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
  const mediaTop = document.createElement("div");
  mediaTop.className = "tree-card-media-top";
  mediaTop.innerHTML = `
    <span class="tree-card-badge is-selected">Selected</span>
    <button type="button" class="tree-back-link tree-back-link-overlay" data-tree-action="back">
      <span aria-hidden="true">&#8592;</span>
      <span>Go back to tour</span>
    </button>
  `;

  const ribbon = document.createElement("div");
  ribbon.className = "tree-card-ribbon";

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
  const statusText = state.visitedTreeIds.has(tree.id)
    ? "Visited"
    : state.arrivedTreeIds.has(tree.id)
      ? "Arrived"
      : "Active stop";
  const coordinatesLabel = `${tree.latitude.toFixed(5)}, ${tree.longitude.toFixed(5)}`;
  body.innerHTML = `
    <div class="tree-header">
      <div class="tree-title-wrap">
        <p class="tree-overline">Selected tree</p>
        <h3>${tree.commonName}</h3>
        <p class="tree-subtitle">${tree.scientificName}</p>
      </div>
      <span class="tree-route-pill">${getTreeRouteIndex(tree.id)}</span>
    </div>
    <div class="tree-inline-meta">
      <span>${tree.family}</span>
      <span>${statusText}</span>
      <span>${coordinatesLabel}</span>
    </div>
    <div class="tree-actions">
      <button type="button" class="tree-action ${state.visitedTreeIds.has(tree.id) ? "is-on" : ""}" data-tree-action="visit">
        ${state.visitedTreeIds.has(tree.id) ? "Visited" : "Mark Visited"}
      </button>
    </div>
  `;

  body.querySelector('[data-tree-action="back"]')?.addEventListener("click", () => {
    showTourPanel();
  });
  body.querySelector('[data-tree-action="visit"]')?.addEventListener("click", () => {
    toggleVisited(tree.id);
  });

  media.append(mediaTop, image, ribbon);
  card.append(media, body);
  return card;
}

function renderTreeCount() {
  elements.treeCount.textContent = String(state.trees.length);
  updateArrivedCount();
}

function renderSelectedTreeEmptyState() {
  elements.treeDetail.innerHTML = '<p class="empty-state">Select a tree marker or route stop to view details.</p>';
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
  if (elements.statusChip) {
    elements.statusChip.textContent = text;
  }
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
  elements.mapControlsToggle.disabled = disabled;
  elements.homeButton.disabled = disabled;
  elements.locateButton.disabled = disabled;
  elements.resetVisitedButton.disabled = disabled;
  elements.resetVisitedInlineButton.disabled = disabled;
  elements.zoomInButton.disabled = disabled;
  elements.zoomOutButton.disabled = disabled;
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

function createUserIcon() {
  return L.divIcon({
    className: "",
    html: `
      <span class="user-marker">
        <span class="user-heading-cone" style="transform: rotate(${state.currentHeading ?? 0}deg)"></span>
        <span class="user-dot"></span>
      </span>
    `,
    iconSize: [52, 52],
    iconAnchor: [26, 26],
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
    updateNextTreeGuidance();

    const selectedTree = state.trees.find((tree) => tree.id === state.selectedTreeId);

    if (selectedTree) {
      elements.treeDetail.innerHTML = "";
      elements.treeDetail.append(buildTreeCard(selectedTree, false));
    }
  }
}

function updateArrivedCount() {
  elements.arrivedCount.textContent = String(new Set([...state.arrivedTreeIds, ...state.visitedTreeIds]).size);
}

function scrollSelectedTreePanelIntoView() {
  elements.treePanel?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
}

function showSelectedTreePanel() {
  if (elements.tourPanel) {
    elements.tourPanel.hidden = true;
  }

  if (elements.treePanel) {
    elements.treePanel.hidden = false;
  }

  if (elements.treePanel && "open" in elements.treePanel) {
    elements.treePanel.open = true;
  }

  scrollSelectedTreePanelIntoView();
}

function showTourPanel() {
  if (elements.treePanel) {
    elements.treePanel.hidden = true;
  }

  if (elements.tourPanel) {
    elements.tourPanel.hidden = false;
  }

  if (elements.tourPanel && "open" in elements.tourPanel) {
    elements.tourPanel.open = true;
  }

  elements.tourPanel?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
}

function fitMapToBounds(bounds, options = {}) {
  const padding = getViewportPadding();
  state.map.fitBounds(bounds, {
    animate: true,
    duration: options.duration ?? 0.8,
    paddingTopLeft: [padding.left, padding.top],
    paddingBottomRight: [padding.right, padding.bottom],
  });
}

function focusMapOnPoint(latLng, options = {}) {
  const zoom = options.zoom ?? state.map.getZoom();
  const targetCenter = getAdjustedMapCenter(latLng, zoom);
  state.map.flyTo(targetCenter, zoom, { duration: options.duration ?? 0.8 });
}

function getAdjustedMapCenter(latLng, zoom) {
  const padding = getViewportPadding();
  const size = state.map.getSize();
  const targetPoint = state.map.project(L.latLng(latLng), zoom);
  const offset = L.point((padding.right - padding.left) / 2, (padding.bottom - padding.top) / 2);
  const centerPoint = targetPoint.add(offset);
  return state.map.unproject(centerPoint, zoom);
}

function getViewportPadding() {
  const sidebarRect = elements.sidebar?.getBoundingClientRect();
  const controlsRect = elements.mapControlGroup?.getBoundingClientRect();
  const isMobile = window.matchMedia("(max-width: 767px)").matches;

  if (!isMobile) {
    return {
      left: 18,
      top: 18,
      right: 18,
      bottom: 18,
    };
  }

  return {
    left: Math.round((controlsRect?.width ?? 48) + 18),
    top: 18,
    right: isMobile ? 18 : Math.round((sidebarRect?.width ?? 0) + 18),
    bottom: Math.round((sidebarRect?.height ?? 0) + 18),
  };
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

function updateNextTreeGuidance() {
  const nextTree = getNextPendingTree();

  if (!nextTree) {
    elements.nextTreeName.textContent = "Tour complete";
    elements.nextTreeDistance.textContent = "-";
    return;
  }

  elements.nextTreeName.textContent = nextTree.commonName;

  if (!state.currentPosition) {
    elements.nextTreeDistance.textContent = "Need GPS";
    return;
  }

  const distance = distanceBetween(state.currentPosition, {
    lat: nextTree.latitude,
    lng: nextTree.longitude,
  });
  elements.nextTreeDistance.textContent = formatDistance(distance);
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
  updateNextTreeGuidance();
}

function resetVisitedTrees() {
  state.visitedTreeIds = new Set();
  updateTreeMarkerStates();
  updateRouteSelection();
  updateRouteProgressAppearance();
  updateNextTreeGuidance();

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

function getNextPendingTree() {
  return state.tour?.orderedStops?.find(
    (tree) => !state.arrivedTreeIds.has(tree.id) && !state.visitedTreeIds.has(tree.id),
  ) ?? null;
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

function getPreferredHeading(rawHeading, previousPosition, currentPosition, fallbackHeading) {
  if (Number.isFinite(rawHeading)) {
    return rawHeading;
  }

  if (previousPosition) {
    const movement = distanceBetween(previousPosition, currentPosition);

    if (movement >= 2) {
      return bearingBetween(previousPosition, currentPosition);
    }
  }

  return fallbackHeading;
}

function bearingBetween(from, to) {
  const fromLat = toRadians(from.lat);
  const toLat = toRadians(to.lat);
  const deltaLng = toRadians(to.lng - from.lng);
  const y = Math.sin(deltaLng) * Math.cos(toLat);
  const x =
    Math.cos(fromLat) * Math.sin(toLat) -
    Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLng);

  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

function maybeVibrateForNextTree() {
  const nextTree = getNextPendingTree();

  if (!nextTree || !state.currentPosition || typeof navigator.vibrate !== "function") {
    return;
  }

  const distance = distanceBetween(state.currentPosition, {
    lat: nextTree.latitude,
    lng: nextTree.longitude,
  });

  if (distance > VIBRATION_MAX_DISTANCE_METERS) {
    return;
  }

  const now = Date.now();
  const { pattern, cooldown } = getVibrationProfile(distance);

  if (now - state.lastVibrationAt < cooldown) {
    return;
  }

  state.lastVibrationAt = now;
  navigator.vibrate(pattern);
}

function getVibrationProfile(distance) {
  if (distance <= 5) {
    return { pattern: [220, 70, 220, 70, 220], cooldown: 900 };
  }

  if (distance <= 10) {
    return { pattern: [180, 80, 180], cooldown: 1400 };
  }

  if (distance <= 18) {
    return { pattern: [130, 90, 130], cooldown: 2200 };
  }

  return { pattern: [90], cooldown: 3600 };
}
