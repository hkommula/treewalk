import {
  attachTreeNodes,
  buildTour,
  buildWalkwayGraph,
  haversineDistance,
  parseTreesCsv,
} from "./routing.js";

const DEFAULT_VIEW_ZOOM = 16;
const DEFAULT_TRACKING_ZOOM = 16;
const MIN_TRACKING_ZOOM = 16;
const MAX_TRACKING_ZOOM = 22;
const ARRIVAL_THRESHOLD_METERS = 18;
const ROUTE_BASE_OPACITY = 0.92;

const GEOLOCATION_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 12000,
  timeout: 15000,
};

const APPROACH_VIBRATION_BUCKETS = [
  { maxDistance: 18, pattern: [220, 80, 220] },
  { maxDistance: 40, pattern: [120, 60, 120] },
  { maxDistance: 75, pattern: [70] },
];

const state = {
  map: null,
  graph: null,
  trees: [],
  treeLayer: null,
  walkwayLayer: null,
  routeLayer: null,
  userMarker: null,
  userAccuracyCircle: null,
  manualStartMarker: null,
  homeBounds: null,
  currentPosition: null,
  watchId: null,
  pendingGpsRouteBuild: false,
  shouldCenterOnNextFix: false,
  startMode: null,
  startPosition: null,
  tour: null,
  routeIndexByTreeId: new Map(),
  treeMarkers: new Map(),
  selectedTreeId: null,
  visitedTreeIds: new Set(),
  arrivedTreeIds: new Set(),
  activePanel: "tour",
  isTourCollapsed: false,
  mapControlsOpen: window.innerWidth >= 768,
  lastApproachVibrationKey: "",
};

const elements = {
  mapPanel: document.querySelector(".map-panel"),
  mapElement: document.querySelector("#map"),
  sidebar: document.querySelector(".sidebar"),
  mapControlGroup: document.querySelector("#map-control-group"),
  mapControlsToggle: document.querySelector("#map-controls-toggle"),
  homeButton: document.querySelector("#home-btn"),
  locateButton: document.querySelector("#locate-btn"),
  resetVisitedButton: document.querySelector("#reset-visited-btn"),
  zoomInButton: document.querySelector("#zoom-in-btn"),
  zoomOutButton: document.querySelector("#zoom-out-btn"),
  attributionButton: document.querySelector("#attribution-btn"),
  attributionPanel: document.querySelector("#map-attribution-panel"),
  tourPanel: document.querySelector("#tour-panel"),
  treePanel: document.querySelector("#tree-panel"),
  treePanelBackButton: document.querySelector("#tree-panel-back-btn"),
  treeDetail: document.querySelector("#tree-detail"),
  tourRestoreButton: document.querySelector("#tour-restore-btn"),
  tourCollapseButton: document.querySelector("#tour-collapse-btn"),
  resetVisitedInlineButton: document.querySelector("#reset-visited-inline-btn"),
  statusChip: document.querySelector("#status-chip"),
  nextTreeName: document.querySelector("#next-tree-name"),
  nextTreeDistance: document.querySelector("#next-tree-distance"),
  treeCount: document.querySelector("#tree-count"),
  arrivedCount: document.querySelector("#arrived-count"),
  routeDistance: document.querySelector("#route-distance"),
  routeTime: document.querySelector("#route-time"),
  gpsReadout: document.querySelector("#gps-readout"),
  errorText: document.querySelector("#error-text"),
  routeCount: document.querySelector("#route-count"),
  routeList: document.querySelector("#route-list"),
  lightbox: document.querySelector("#image-lightbox"),
  lightboxImage: document.querySelector("#image-lightbox-image"),
  lightboxTitle: document.querySelector("#image-lightbox-title"),
  lightboxBackdrop: document.querySelector("#image-lightbox-close"),
  lightboxDismiss: document.querySelector("#image-lightbox-dismiss"),
};

init().catch((error) => {
  console.error(error);
  showError(error.message || "The app could not finish loading.");
  setStatus("Error");
});

async function init() {
  if (window.location.protocol === "file:") {
    return;
  }

  bindUi();
  syncMapControls();
  showTourPanel();
  renderSelectedTreePlaceholder();
  updateRouteMetrics();
  updateTreeCount();
  updateNextTreeGuide();
  setGpsReadout("Use Locate Me to start from GPS, or tap the map to choose a manual start.");
  setStatus("Loading");

  const [treesCsvText, pathwaysGeojson] = await Promise.all([
    fetchText("./data/trees.csv", "Unable to load tree CSV data."),
    fetchJson("./data/pathways.geojson", "Unable to load pathway GeoJSON data."),
  ]);

  const graph = buildWalkwayGraph(pathwaysGeojson);
  const trees = attachTreeNodes(parseTreesCsv(treesCsvText), graph);

  state.graph = graph;
  state.trees = trees;

  createMap(getInitialCenter(trees));
  renderWalkwayNetwork();
  renderTreeMarkers();
  state.homeBounds = buildHomeBounds();
  fitHomeView(false);

  updateTreeCount();
  updateRouteList();
  setStatus("Ready");
  requestLiveLocation({ buildRoute: true, centerOnFix: true });
}

function bindUi() {
  elements.mapControlsToggle.addEventListener("click", () => {
    state.mapControlsOpen = !state.mapControlsOpen;
    syncMapControls();
  });

  elements.homeButton.addEventListener("click", () => {
    fitHomeView(true);
  });

  elements.locateButton.addEventListener("click", () => {
    requestLiveLocation({ buildRoute: true, centerOnFix: true });
  });

  elements.resetVisitedButton.addEventListener("click", () => {
    resetVisitedTrees();
  });

  elements.resetVisitedInlineButton.addEventListener("click", () => {
    resetVisitedTrees();
  });

  elements.tourCollapseButton.addEventListener("click", () => {
    const isMobile = window.matchMedia("(max-width: 767px)").matches;
    showTourPanel({ collapsed: isMobile ? !state.isTourCollapsed : true });
  });

  elements.zoomInButton.addEventListener("click", () => {
    state.map?.zoomIn();
  });

  elements.zoomOutButton.addEventListener("click", () => {
    state.map?.zoomOut();
  });

  elements.attributionButton.addEventListener("click", () => {
    const isOpen = !elements.attributionPanel.hidden;
    elements.attributionPanel.hidden = isOpen;
    elements.attributionButton.setAttribute("aria-expanded", String(!isOpen));
  });

  elements.tourRestoreButton.addEventListener("click", () => {
    showTourPanel({ collapsed: !state.isTourCollapsed });
  });

  elements.treePanelBackButton.addEventListener("click", () => {
    showTourPanel();
  });

  elements.lightboxBackdrop.addEventListener("click", closeLightbox);
  elements.lightboxDismiss.addEventListener("click", closeLightbox);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.lightbox.hidden) {
      closeLightbox();
    }

    if (event.key === "Escape" && !elements.attributionPanel.hidden) {
      elements.attributionPanel.hidden = true;
      elements.attributionButton.setAttribute("aria-expanded", "false");
    }
  });

  document.addEventListener("click", (event) => {
    if (
      !elements.attributionPanel.hidden &&
      !elements.attributionPanel.contains(event.target) &&
      !elements.attributionButton.contains(event.target)
    ) {
      elements.attributionPanel.hidden = true;
      elements.attributionButton.setAttribute("aria-expanded", "false");
    }
  });
}

function createMap(center) {
  state.map = L.map("map", {
    zoomControl: false,
    preferCanvas: true,
    maxZoom: MAX_TRACKING_ZOOM,
  }).setView([center.lat, center.lng], DEFAULT_VIEW_ZOOM);

  state.map.attributionControl.setPrefix(false);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    subdomains: "abcd",
    maxNativeZoom: 20,
    maxZoom: MAX_TRACKING_ZOOM,
  }).addTo(state.map);

  state.map.on("click", (event) => {
    handleManualStart(event.latlng);
  });
}

function renderWalkwayNetwork() {
  if (state.walkwayLayer) {
    state.walkwayLayer.remove();
  }

  state.walkwayLayer = L.polyline(state.graph.walkwayLines, {
    color: "#859184",
    weight: 2,
    opacity: 0.42,
    interactive: false,
  }).addTo(state.map);
}

function renderTreeMarkers() {
  if (state.treeLayer) {
    state.treeLayer.remove();
  }

  state.treeMarkers.clear();
  const markers = [];

  for (const tree of state.trees) {
    const marker = L.marker([tree.latitude, tree.longitude], {
      icon: createTreeMarkerIcon(tree.id),
      keyboard: true,
    });

    marker.bindTooltip(tree.commonName, {
      direction: "top",
      offset: [0, -12],
      className: "tree-name-label",
    });

    marker.on("click", () => {
      selectTree(tree.id, { panToTree: false });
    });

    state.treeMarkers.set(tree.id, marker);
    markers.push(marker);
  }

  state.treeLayer = L.layerGroup(markers).addTo(state.map);
}

function handleManualStart(latlng) {
  clearError();
  state.pendingGpsRouteBuild = false;

  const start = { lat: latlng.lat, lng: latlng.lng };

  state.startMode = "manual";
  state.startPosition = start;
  renderManualStartMarker(start);
  buildRouteFromStart(start, "manual");

  if (state.currentPosition) {
    setGpsReadout(
      `GPS live at ${formatCoordinates(state.currentPosition.lat, state.currentPosition.lng)}. Manual route start fixed at ${formatCoordinates(start.lat, start.lng)}.`,
    );
  } else {
    setGpsReadout(`Manual start set at ${formatCoordinates(start.lat, start.lng)}. Tap elsewhere to rebuild the route.`);
  }
}

function requestLiveLocation({ buildRoute = false, centerOnFix = false } = {}) {
  if (!("geolocation" in navigator)) {
    showError("Geolocation is unavailable in this browser. Tap the map to choose a manual start.");
    setGpsReadout("Geolocation unavailable. Tap the map to choose a manual start.");
    setStatus("Manual");
    return;
  }

  clearError();
  state.pendingGpsRouteBuild = buildRoute;
  state.shouldCenterOnNextFix = centerOnFix;

  if (state.watchId === null) {
    setStatus("Locating");
    setGpsReadout("Requesting a live GPS fix...");
    state.watchId = navigator.geolocation.watchPosition(
      handleLocationSuccess,
      handleLocationError,
      GEOLOCATION_OPTIONS,
    );
    return;
  }

  if (state.currentPosition) {
    if (centerOnFix) {
      centerOnCurrentLocation();
      state.shouldCenterOnNextFix = false;
    }

    if (buildRoute) {
      state.pendingGpsRouteBuild = false;
      buildRouteFromStart(state.currentPosition, "gps");
    }
  }
}

function handleLocationSuccess(position) {
  state.currentPosition = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: position.coords.accuracy,
    heading:
      Number.isFinite(position.coords.heading) && position.coords.heading >= 0
        ? position.coords.heading
        : null,
    timestamp: position.timestamp,
  };

  updateUserLocationLayers();
  setGpsReadout(buildGpsReadout(state.currentPosition));

  if (state.shouldCenterOnNextFix) {
    centerOnCurrentLocation();
    state.shouldCenterOnNextFix = false;
  }

  if (state.pendingGpsRouteBuild) {
    state.pendingGpsRouteBuild = false;
    buildRouteFromStart(state.currentPosition, "gps");
  }

  updateProgressFromCurrentPosition();
  syncStatus();
}

function handleLocationError(error) {
  state.pendingGpsRouteBuild = false;
  state.shouldCenterOnNextFix = false;

  const denied = error.code === 1;
  const timedOut = error.code === 3;

  if (denied) {
    stopWatchingLocation();
    showError("Location permission was denied. Tap the map to choose a manual start.");
    setGpsReadout("Location denied. Tap the map to choose a manual start.");
    setStatus("Manual");
    return;
  }

  if (timedOut) {
    showError("Location lookup timed out. Tap the map to choose a manual start, or try Locate Me again.");
    setGpsReadout("Location timed out. Tap the map for a manual start.");
    syncStatus();
    return;
  }

  showError("A live location fix could not be retrieved. Tap the map to choose a manual start.");
  setGpsReadout("Location unavailable. Tap the map to choose a manual start.");
  syncStatus();
}

function stopWatchingLocation() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
}

function buildRouteFromStart(start, mode) {
  if (!state.graph || !state.trees.length) {
    return;
  }

  try {
    const tour = buildTour({
      start,
      trees: state.trees,
      graph: state.graph,
    });

    state.tour = tour;
    state.startMode = mode;
    state.startPosition = { lat: start.lat, lng: start.lng };
    state.routeIndexByTreeId = new Map(
      tour.orderedStops.map((tree, index) => [tree.id, index + 1]),
    );
    clearError();

    if (mode === "gps" && state.manualStartMarker) {
      state.manualStartMarker.remove();
      state.manualStartMarker = null;
    }

    renderRoute();
    updateRouteMetrics();
    updateRouteList();
    updateNextTreeGuide();
    rerenderSelectedTree();
    syncStatus();
    fitRouteBounds(true);
    updateProgressFromCurrentPosition();
  } catch (error) {
    console.error(error);
    showError(error.message || "The walking route could not be built.");
    setStatus("Error");
  }
}

function renderRoute() {
  if (state.routeLayer) {
    state.routeLayer.remove();
  }

  if (!state.tour?.coordinates?.length) {
    return;
  }

  state.routeLayer = L.polyline(state.tour.coordinates, {
    color: "#1f7b55",
    weight: 5,
    opacity: getRouteOpacity(),
    lineCap: "round",
    lineJoin: "round",
  }).addTo(state.map);
}

function renderManualStartMarker(start) {
  if (!state.map) {
    return;
  }

  if (!state.manualStartMarker) {
    state.manualStartMarker = L.circleMarker([start.lat, start.lng], {
      radius: 7,
      color: "#d77724",
      weight: 2,
      fillColor: "#fff6ea",
      fillOpacity: 0.9,
    }).addTo(state.map);
  } else {
    state.manualStartMarker.setLatLng([start.lat, start.lng]);
  }
}

function updateUserLocationLayers() {
  if (!state.map || !state.currentPosition) {
    return;
  }

  const latlng = [state.currentPosition.lat, state.currentPosition.lng];
  const userIcon = L.divIcon({
    className: "",
    html: buildUserMarkerHtml(state.currentPosition.heading),
    iconSize: [54, 54],
    iconAnchor: [27, 27],
  });

  if (!state.userMarker) {
    state.userMarker = L.marker(latlng, {
      icon: userIcon,
      zIndexOffset: 1000,
    }).addTo(state.map);
  } else {
    state.userMarker.setLatLng(latlng);
    state.userMarker.setIcon(userIcon);
  }

  if (!state.userAccuracyCircle) {
    state.userAccuracyCircle = L.circle(latlng, {
      radius: state.currentPosition.accuracy,
      color: "#2e7fff",
      weight: 1,
      opacity: 0.55,
      fillColor: "#2e7fff",
      fillOpacity: 0.09,
      interactive: false,
    }).addTo(state.map);
  } else {
    state.userAccuracyCircle.setLatLng(latlng);
    state.userAccuracyCircle.setRadius(state.currentPosition.accuracy);
  }
}

function selectTree(treeId, { panToTree = true } = {}) {
  const tree = getTreeById(treeId);

  if (!tree) {
    return;
  }

  state.selectedTreeId = treeId;
  updateTreeMarkerStates();
  updateRouteList();
  renderSelectedTree(tree);
  showTreePanel();

  if (panToTree) {
    const targetZoom = clamp(state.map.getZoom(), 17, 19);
    flyToVisibleCenter([tree.latitude, tree.longitude], targetZoom, {
      animate: true,
      duration: 0.7,
    });
  }
}

function renderSelectedTree(tree) {
  elements.treeDetail.innerHTML = "";

  const card = document.createElement("article");
  card.className = "tree-card";

  const media = document.createElement("div");
  media.className = "tree-card-media";
  media.style.minHeight = "10rem";

  const mediaTop = document.createElement("div");
  mediaTop.className = "tree-card-media-top";

  const selectedBadge = document.createElement("span");
  selectedBadge.className = "tree-card-badge is-selected";
  selectedBadge.textContent = "Selected";

  const mediaActions = document.createElement("div");
  mediaActions.className = "tree-media-actions";

  if (tree.photoFilename) {
    const image = document.createElement("img");
    image.src = buildImagePath(tree.photoFilename);
    image.alt = tree.commonName;
    image.loading = "lazy";
    media.classList.add("is-loading");

    const viewImageButton = document.createElement("button");
    viewImageButton.type = "button";
    viewImageButton.className = "tree-expand-action";
    viewImageButton.title = "Expand image";
    viewImageButton.setAttribute("aria-label", "Expand image");
    viewImageButton.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6h-2V7.4l-4.3 4.3-1.4-1.4L16.6 6H14zm-4 16H4v-6h2v2.6l4.3-4.3 1.4 1.4L7.4 18H10z"/></svg>';
    viewImageButton.addEventListener("click", () => {
      openLightbox(tree);
    });

    mediaActions.append(viewImageButton);

    image.addEventListener("load", () => {
      media.classList.remove("is-loading");
      media.classList.add("is-ready");
      media.style.minHeight = "";
    });

    image.addEventListener("error", () => {
      media.classList.remove("is-loading");
      viewImageButton.remove();
      image.remove();
    });

    media.append(image);
  }

  mediaTop.append(selectedBadge, mediaActions);
  media.append(mediaTop);

  const body = document.createElement("div");
  body.className = "tree-body";

  const header = document.createElement("div");
  header.className = "tree-header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "tree-title-wrap";

  const heading = document.createElement("h3");
  heading.textContent = tree.commonName;

  const scientificLine = document.createElement("p");
  scientificLine.className = "tree-scientific-line";
  scientificLine.textContent = tree.scientificName || "Scientific name unavailable";

  titleWrap.append(heading, scientificLine);

  const visitedButton = document.createElement("button");
  visitedButton.type = "button";
  visitedButton.className = "tree-action tree-action-inline";

  if (state.visitedTreeIds.has(tree.id)) {
    visitedButton.classList.add("is-on");
    visitedButton.textContent = "Reset Visited";
  } else {
    visitedButton.textContent = "Mark Visited";
  }

  visitedButton.addEventListener("click", () => {
    toggleVisitedTree(tree.id);
  });

  header.append(titleWrap, visitedButton);

  const metaStack = document.createElement("div");
  metaStack.className = "tree-meta-stack";
  metaStack.append(
    buildMetaItem("Family", tree.family || "Unavailable"),
    buildMetaItem(
      "Route Index",
      state.routeIndexByTreeId.has(tree.id)
        ? `Stop ${state.routeIndexByTreeId.get(tree.id)}`
        : "Not on current route",
    ),
  );

  const locationLine = document.createElement("p");
  locationLine.className = "tree-location-line";

  const locationLabel = document.createElement("span");
  locationLabel.textContent = "Location";

  const locationValue = document.createElement("strong");
  const coordinateLabel = formatCoordinates(tree.latitude, tree.longitude);
  const distanceFromUser = state.currentPosition
    ? `${Math.max(1, Math.round(haversineDistance(state.currentPosition, { lat: tree.latitude, lng: tree.longitude })))}m away`
    : null;
  locationValue.textContent = coordinateLabel;

  if (distanceFromUser) {
    const distanceText = document.createElement("em");
    distanceText.textContent = ` (${distanceFromUser})`;
    locationValue.append(distanceText);
  }

  locationLine.append(locationLabel, locationValue);

  body.append(header, metaStack, locationLine);
  card.append(media, body);

  elements.treeDetail.append(card);
}

function renderSelectedTreePlaceholder() {
  elements.treeDetail.innerHTML =
    '<p class="empty-state">Select a tree marker or route stop to view details.</p>';
}

function rerenderSelectedTree() {
  const selectedTree = getTreeById(state.selectedTreeId);

  if (selectedTree) {
    renderSelectedTree(selectedTree);
  }
}

function updateRouteList() {
  if (!state.tour?.orderedStops?.length) {
    elements.routeList.innerHTML =
      '<li class="empty-state">Use Locate Me or tap the map to generate the tour.</li>';
    elements.routeCount.textContent = "0 stops";
    return;
  }

  elements.routeList.innerHTML = "";
  elements.routeCount.textContent = formatStopCount(state.tour.orderedStops.length);

  const fragment = document.createDocumentFragment();

  state.tour.orderedStops.forEach((tree, index) => {
    const item = document.createElement("li");
    item.className = "route-stop-row";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "route-stop";

    if (tree.id === state.selectedTreeId) {
      button.classList.add("is-active");
    }

    if (state.arrivedTreeIds.has(tree.id)) {
      button.classList.add("is-arrived");
    } else if (state.visitedTreeIds.has(tree.id)) {
      button.classList.add("is-visited");
    }

    const title = document.createElement("strong");
    title.textContent = `${index + 1}. ${tree.commonName}`;

    const subtitle = document.createElement("span");
    subtitle.textContent = [tree.scientificName, tree.family].filter(Boolean).join(" | ");

    button.append(title, subtitle);
    button.addEventListener("click", () => {
      selectTree(tree.id);
    });

    item.append(button);
    fragment.append(item);
  });

  elements.routeList.append(fragment);
}

function updateRouteMetrics() {
  elements.treeCount.textContent = String(state.trees.length);
  elements.arrivedCount.textContent = String(state.visitedTreeIds.size);

  if (!state.tour) {
    elements.routeDistance.textContent = "-";
    elements.routeTime.textContent = "-";
    elements.routeCount.textContent = "0 stops";
    return;
  }

  elements.routeDistance.textContent = formatDistance(state.tour.totalDistanceMeters);
  elements.routeTime.textContent = `${state.tour.estimatedMinutes} min`;
  elements.routeCount.textContent = formatStopCount(state.tour.orderedStops.length);

  if (state.routeLayer) {
    state.routeLayer.setStyle({ opacity: getRouteOpacity() });
  }
}

function updateTreeCount() {
  elements.treeCount.textContent = String(state.trees.length);
}

function updateNextTreeGuide() {
  if (!state.tour) {
    elements.nextTreeName.textContent = "Waiting for route";
    elements.nextTreeDistance.textContent = "-";
    return;
  }

  const nextTree = getNextPendingTree();

  if (!nextTree) {
    elements.nextTreeName.textContent = "Tour complete";
    elements.nextTreeDistance.textContent = "-";
    return;
  }

  elements.nextTreeName.textContent = nextTree.commonName;

  if (state.currentPosition) {
    const distance = haversineDistance(state.currentPosition, {
      lat: nextTree.latitude,
      lng: nextTree.longitude,
    });
    elements.nextTreeDistance.textContent = formatDistance(distance);
    return;
  }

  if (state.startPosition) {
    const distance = haversineDistance(state.startPosition, {
      lat: nextTree.latitude,
      lng: nextTree.longitude,
    });
    elements.nextTreeDistance.textContent = formatDistance(distance);
    return;
  }

  elements.nextTreeDistance.textContent = "-";
}

function updateProgressFromCurrentPosition() {
  if (!state.currentPosition || !state.tour?.orderedStops?.length) {
    updateNextTreeGuide();
    return;
  }

  const nextTree = getNextPendingTree();

  if (!nextTree) {
    state.lastApproachVibrationKey = "";
    updateNextTreeGuide();
    syncStatus();
    return;
  }

  const distance = haversineDistance(state.currentPosition, {
    lat: nextTree.latitude,
    lng: nextTree.longitude,
  });

  if (distance <= ARRIVAL_THRESHOLD_METERS && !state.visitedTreeIds.has(nextTree.id)) {
    markTreeArrived(nextTree.id);
    return;
  }

  maybeVibrateForApproach(nextTree.id, distance);
  updateNextTreeGuide();
}

function markTreeArrived(treeId) {
  state.visitedTreeIds.add(treeId);
  state.arrivedTreeIds.add(treeId);
  state.lastApproachVibrationKey = "";

  if ("vibrate" in navigator) {
    navigator.vibrate([220, 80, 220]);
  }

  updateAfterProgressChange();
}

function toggleVisitedTree(treeId) {
  if (state.visitedTreeIds.has(treeId)) {
    state.visitedTreeIds.delete(treeId);
    state.arrivedTreeIds.delete(treeId);
  } else {
    state.visitedTreeIds.add(treeId);
  }

  state.lastApproachVibrationKey = "";
  updateAfterProgressChange();
}

function resetVisitedTrees() {
  state.visitedTreeIds.clear();
  state.arrivedTreeIds.clear();
  state.lastApproachVibrationKey = "";
  updateAfterProgressChange();
}

function updateAfterProgressChange() {
  updateRouteMetrics();
  updateRouteList();
  updateTreeMarkerStates();
  updateNextTreeGuide();
  rerenderSelectedTree();
  syncStatus();
}

function updateTreeMarkerStates() {
  for (const [treeId, marker] of state.treeMarkers) {
    marker.setIcon(createTreeMarkerIcon(treeId));
  }
}

function createTreeMarkerIcon(treeId) {
  const classNames = ["tree-marker"];

  if (treeId === state.selectedTreeId) {
    classNames.push("is-selected");
  } else if (state.arrivedTreeIds.has(treeId)) {
    classNames.push("is-arrived");
  } else if (state.visitedTreeIds.has(treeId)) {
    classNames.push("is-visited");
  }

  return L.divIcon({
    className: "",
    html: `<span class="${classNames.join(" ")}"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function maybeVibrateForApproach(treeId, distance) {
  if (!("vibrate" in navigator)) {
    return;
  }

  for (const bucket of APPROACH_VIBRATION_BUCKETS) {
    if (distance <= bucket.maxDistance) {
      const vibrationKey = `${treeId}:${bucket.maxDistance}`;

      if (vibrationKey !== state.lastApproachVibrationKey) {
        navigator.vibrate(bucket.pattern);
        state.lastApproachVibrationKey = vibrationKey;
      }

      return;
    }
  }

  state.lastApproachVibrationKey = "";
}

function showTourPanel({ collapsed = false } = {}) {
  state.activePanel = "tour";
  state.isTourCollapsed = collapsed;
  syncPanels();
}

function showTreePanel() {
  state.activePanel = "tree";
  state.isTourCollapsed = false;
  syncPanels();
}

function syncPanels() {
  const showTree = state.activePanel === "tree";
  const isMobile = window.matchMedia("(max-width: 767px)").matches;
  const showMobileTourShell = !showTree && isMobile;
  const showTour = !showTree && (!state.isTourCollapsed || isMobile);
  const showMobileCollapsedTour = showMobileTourShell && state.isTourCollapsed;
  const showDesktopToggle = !showTree && !isMobile;

  elements.tourPanel.hidden = !showTour;
  elements.tourPanel.classList.toggle("is-mobile-collapsed", showMobileCollapsedTour);
  elements.treePanel.hidden = !showTree;
  elements.tourCollapseButton.hidden = showTree || !isMobile;
  elements.tourRestoreButton.hidden = !showDesktopToggle;
  elements.tourRestoreButton.setAttribute("aria-expanded", String(showTour));
  elements.tourRestoreButton.setAttribute("aria-label", showTour ? "Collapse tour panel" : "Open tour panel");
  elements.tourRestoreButton.classList.toggle("is-desktop-open", showDesktopToggle && showTour);
  elements.tourRestoreButton.classList.remove("is-mobile-collapsed");
  elements.sidebar.classList.toggle("is-mobile-tour-collapsed", showMobileCollapsedTour);

  const collapseButtonLabel = showMobileCollapsedTour ? "Open tour panel" : "Collapse tour panel";
  const collapseButtonText = showMobileCollapsedTour ? "Show" : "Hide";
  elements.tourCollapseButton.setAttribute("aria-label", collapseButtonLabel);
  elements.tourCollapseButton.innerHTML = `<span>${collapseButtonText}</span>`;

  elements.mapPanel.classList.toggle(
    "is-sidebar-hidden",
    !showTree && state.isTourCollapsed && !isMobile,
  );

  window.setTimeout(() => {
    state.map?.invalidateSize();
    refreshMapFocusAfterLayoutChange();
  }, 0);
}

function syncMapControls() {
  elements.mapControlGroup.classList.toggle("is-open", state.mapControlsOpen);
  elements.mapControlsToggle.setAttribute("aria-expanded", String(state.mapControlsOpen));
}

function centerOnCurrentLocation() {
  if (!state.currentPosition || !state.map) {
    return;
  }

  const currentZoom = state.map.getZoom();
  const targetZoom =
    currentZoom < MIN_TRACKING_ZOOM || currentZoom > MAX_TRACKING_ZOOM
      ? DEFAULT_TRACKING_ZOOM
      : clamp(currentZoom, MIN_TRACKING_ZOOM, MAX_TRACKING_ZOOM);

  flyToVisibleCenter([state.currentPosition.lat, state.currentPosition.lng], targetZoom, {
    animate: true,
    duration: 0.7,
  });
}

function fitHomeView(animate) {
  if (!state.map) {
    return;
  }

  if (state.tour?.coordinates?.length) {
    fitRouteBounds(animate);
    return;
  }

  if (state.homeBounds?.isValid()) {
    state.map.fitBounds(state.homeBounds.pad(0.05), {
      animate,
      duration: animate ? 0.75 : 0,
      maxZoom: 18,
      ...getVisibleAreaPaddingOptions(),
    });
  }
}

function fitRouteBounds(animate) {
  if (!state.map || !state.tour?.coordinates?.length) {
    return;
  }

  const bounds = L.latLngBounds(
    state.tour.coordinates.map(([lat, lng]) => [lat, lng]),
  );

  if (state.currentPosition) {
    bounds.extend([state.currentPosition.lat, state.currentPosition.lng]);
  } else if (state.startPosition) {
    bounds.extend([state.startPosition.lat, state.startPosition.lng]);
  }

  if (bounds.isValid()) {
    state.map.fitBounds(bounds.pad(0.12), {
      animate,
      duration: animate ? 0.75 : 0,
      maxZoom: 18,
      ...getVisibleAreaPaddingOptions(),
    });
  }
}

function refreshMapFocusAfterLayoutChange() {
  if (!state.map) {
    return;
  }

  const selectedTree = getTreeById(state.selectedTreeId);

  if (state.activePanel === "tree" && selectedTree) {
    const targetZoom = clamp(state.map.getZoom(), 17, 19);
    flyToVisibleCenter([selectedTree.latitude, selectedTree.longitude], targetZoom, {
      animate: false,
    });
    return;
  }

  if (state.currentPosition && state.startMode === "gps") {
    const currentZoom = state.map.getZoom();
    const targetZoom =
      currentZoom < MIN_TRACKING_ZOOM || currentZoom > MAX_TRACKING_ZOOM
        ? DEFAULT_TRACKING_ZOOM
        : clamp(currentZoom, MIN_TRACKING_ZOOM, MAX_TRACKING_ZOOM);

    flyToVisibleCenter([state.currentPosition.lat, state.currentPosition.lng], targetZoom, {
      animate: false,
    });
    return;
  }

  if (state.tour?.coordinates?.length) {
    fitRouteBounds(false);
    return;
  }

  if (state.homeBounds?.isValid()) {
    fitHomeView(false);
  }
}

function flyToVisibleCenter(latlng, zoom, options = {}) {
  if (!state.map) {
    return;
  }

  const visibleCenter = getVisibleAreaCenterOffset();
  const targetPoint = state.map.project(L.latLng(latlng[0], latlng[1]), zoom).subtract(visibleCenter);
  const targetLatLng = state.map.unproject(targetPoint, zoom);
  state.map.flyTo(targetLatLng, zoom, options);
}

function getVisibleAreaPaddingOptions() {
  const insets = getMapOverlayInsets();
  const basePadding = 24;

  return {
    paddingTopLeft: L.point(basePadding + insets.left, basePadding + insets.top),
    paddingBottomRight: L.point(basePadding + insets.right, basePadding + insets.bottom),
  };
}

function getVisibleAreaCenterOffset() {
  if (!state.map) {
    return L.point(0, 0);
  }

  const insets = getMapOverlayInsets();
  return L.point(
    (insets.left - insets.right) / 2,
    (insets.top - insets.bottom) / 2,
  );
}

function getMapOverlayInsets() {
  const mapRect = elements.mapElement?.getBoundingClientRect();

  if (!mapRect) {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }

  const overlayRects = [elements.sidebar]
    .filter((element) => element && !element.hidden)
    .map((element) => element.getBoundingClientRect());

  const insets = { top: 0, right: 0, bottom: 0, left: 0 };

  for (const rect of overlayRects) {
    const overlapWidth = Math.max(0, Math.min(mapRect.right, rect.right) - Math.max(mapRect.left, rect.left));
    const overlapHeight = Math.max(0, Math.min(mapRect.bottom, rect.bottom) - Math.max(mapRect.top, rect.top));

    if (!overlapWidth || !overlapHeight) {
      continue;
    }

    if (rect.top <= mapRect.top + 1) {
      insets.top = Math.max(insets.top, Math.min(mapRect.bottom, rect.bottom) - mapRect.top);
    }

    if (rect.bottom >= mapRect.bottom - 1) {
      insets.bottom = Math.max(insets.bottom, mapRect.bottom - Math.max(mapRect.top, rect.top));
    }

    if (rect.left <= mapRect.left + 1) {
      insets.left = Math.max(insets.left, Math.min(mapRect.right, rect.right) - mapRect.left);
    }

    if (rect.right >= mapRect.right - 1) {
      insets.right = Math.max(insets.right, mapRect.right - Math.max(mapRect.left, rect.left));
    }
  }

  return insets;
}

function buildHomeBounds() {
  const bounds = L.latLngBounds([]);

  for (const tree of state.trees) {
    bounds.extend([tree.latitude, tree.longitude]);
  }

  for (const line of state.graph.walkwayLines) {
    for (const [lat, lng] of line) {
      bounds.extend([lat, lng]);
    }
  }

  return bounds;
}

function getNextPendingTree() {
  return state.tour?.orderedStops.find((tree) => !state.visitedTreeIds.has(tree.id)) ?? null;
}

function getTreeById(treeId) {
  return state.trees.find((tree) => tree.id === treeId) ?? null;
}

function describeTreeStatus(treeId) {
  if (state.arrivedTreeIds.has(treeId)) {
    return "Arrived";
  }

  if (state.visitedTreeIds.has(treeId)) {
    return "Visited";
  }

  return "Pending";
}

function buildMetaItem(label, value) {
  const wrapper = document.createElement("div");
  wrapper.className = "tree-meta-item";

  const title = document.createElement("span");
  title.textContent = label;

  const content = document.createElement("strong");
  content.textContent = value;

  wrapper.append(title, content);
  return wrapper;
}

function openLightbox(tree) {
  if (!tree.photoFilename) {
    return;
  }

  elements.lightboxTitle.textContent = tree.commonName;
  elements.lightboxImage.alt = tree.commonName;
  elements.lightboxImage.src = buildImagePath(tree.photoFilename);
  elements.lightbox.hidden = false;
  elements.lightbox.setAttribute("aria-hidden", "false");
}

function closeLightbox() {
  elements.lightbox.hidden = true;
  elements.lightbox.setAttribute("aria-hidden", "true");
  elements.lightboxImage.removeAttribute("src");
}

function setStatus(text) {
  elements.statusChip.textContent = text;
}

function syncStatus() {
  if (state.tour && !getNextPendingTree()) {
    setStatus("Complete");
    return;
  }

  if (state.startMode === "manual" && state.tour) {
    setStatus("Manual route");
    return;
  }

  if (state.startMode === "gps" && state.tour && state.currentPosition) {
    setStatus("GPS route");
    return;
  }

  if (state.watchId !== null && !state.currentPosition) {
    setStatus("Locating");
    return;
  }

  if (state.currentPosition) {
    setStatus("GPS live");
    return;
  }

  setStatus("Ready");
}

function setGpsReadout(message) {
  elements.gpsReadout.textContent = message;
}

function showError(message) {
  elements.errorText.hidden = false;
  elements.errorText.textContent = message;
}

function clearError() {
  elements.errorText.hidden = true;
  elements.errorText.textContent = "";
}

function buildGpsReadout(position) {
  const accuracy = Math.round(position.accuracy);
  const headingText =
    position.heading === null ? "" : ` | Heading ${Math.round(position.heading)}deg`;

  return `${formatCoordinates(position.lat, position.lng)} | +/-${accuracy}m${headingText}`;
}

function buildUserMarkerHtml(heading) {
  const headingStyle =
    heading === null
      ? 'style="opacity:0;transform:translate(-50%, calc(-100% + 0.16rem)) rotate(0deg)"'
      : `style="opacity:1;transform:translate(-50%, calc(-100% + 0.16rem)) rotate(${heading}deg)"`;

  return `<span class="user-marker"><span class="user-heading-cone" ${headingStyle}></span><span class="user-dot"></span></span>`;
}

function buildImagePath(filename) {
  return encodeURI(`./images/${filename}`);
}

function getRouteOpacity() {
  if (!state.tour?.orderedStops?.length) {
    return ROUTE_BASE_OPACITY;
  }

  const progress = state.visitedTreeIds.size / state.tour.orderedStops.length;
  return clamp(ROUTE_BASE_OPACITY - progress * 0.58, 0.24, ROUTE_BASE_OPACITY);
}

function formatDistance(distanceMeters) {
  return distanceMeters >= 1000
    ? `${(distanceMeters / 1000).toFixed(2)} km`
    : `${Math.round(distanceMeters)} m`;
}

function formatCoordinates(lat, lng) {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function formatStopCount(count) {
  return `${count} ${count === 1 ? "stop" : "stops"}`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getInitialCenter(trees) {
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
