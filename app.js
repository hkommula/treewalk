import {
  attachNearestGraphNodes,
  buildGraphFromGeoJSON,
  computeOptimizedWalkingTour,
  parseTreesCsv,
} from "./routing.js";

const DEFAULT_VIEW = {
  zoom: 17,
};

const GEOLOCATION_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 15000,
  timeout: 12000,
};

const state = {
  map: null,
  treeLayer: null,
  routeLayer: null,
  userMarker: null,
  trees: [],
  graph: null,
  tour: null,
  treeMarkers: new Map(),
  currentPosition: null,
  watchId: null,
  pendingTourStart: false,
  selectedTreeId: null,
};

const elements = {
  allowLocationButton: document.querySelector("#allow-location-btn"),
  startTourButton: document.querySelector("#start-tour-btn"),
  stopTrackingButton: document.querySelector("#stop-tracking-btn"),
  recenterButton: document.querySelector("#recenter-btn"),
  loadingOverlay: document.querySelector("#map-loading-overlay"),
  loadingMessage: document.querySelector("#loading-message"),
  errorBanner: document.querySelector("#error-banner"),
  permissionCopy: document.querySelector("#permission-copy"),
  appStatusPill: document.querySelector("#app-status-pill"),
  trackingBadge: document.querySelector("#tracking-badge"),
  tourStatus: document.querySelector("#tour-status"),
  gpsStatus: document.querySelector("#gps-status"),
  treeCountBadge: document.querySelector("#tree-count-badge"),
  routeDistance: document.querySelector("#route-distance"),
  routeDuration: document.querySelector("#route-duration"),
  routeStopCount: document.querySelector("#route-stop-count"),
  routeStopList: document.querySelector("#route-stop-list"),
  selectedTreeContent: document.querySelector("#selected-tree-content"),
};

init().catch((error) => {
  console.error(error);
  showError(error.message || "The app could not finish loading.");
  setLoading(false);
});

async function init() {
  bindUi();
  setButtonsDisabled(true);
  setLoading(true, "Loading trees and pathways...");

  if (window.location.protocol === "file:") {
    throw new Error(
      "This app must be served over http://localhost (or another local web server), not opened directly from file://.",
    );
  }

  // Load both datasets up front so the graph and markers are ready before geolocation starts.
  const [treesCsvText, pathwaysGeoJSON] = await Promise.all([
    fetchText("./data/trees.csv", "Unable to load tree CSV data."),
    fetchJson("./data/pathways.geojson", "Unable to load pathway GeoJSON data."),
  ]);

  const parsedTrees = parseTreesCsv(treesCsvText);
  const graph = buildGraphFromGeoJSON(pathwaysGeoJSON);
  const trees = attachNearestGraphNodes(parsedTrees, graph);
  const initialCenter = getInitialCenter(trees);

  state.trees = trees;
  state.graph = graph;

  createMap(initialCenter);
  renderTreeMarkers();
  updateTreeCountBadge();
  updateTourSummary(null);
  updateLocationStatus("Location prompt pending.", false);
  updateTourStatus("Choose Start Tour once a GPS fix is available.");
  setButtonsDisabled(false);
  setLoading(false);
  requestLiveLocation(true);
}

function bindUi() {
  elements.allowLocationButton.addEventListener("click", () => {
    requestLiveLocation(true);
  });

  elements.startTourButton.addEventListener("click", () => {
    handleStartTour();
  });

  elements.stopTrackingButton.addEventListener("click", () => {
    stopTracking();
  });

  elements.recenterButton.addEventListener("click", () => {
    if (!state.map || !state.currentPosition) {
      showError("A live location fix is needed before the map can recenter.");
      return;
    }

    state.map.flyTo([state.currentPosition.lat, state.currentPosition.lng], 18, {
      animate: true,
      duration: 0.75,
    });
  });
}

async function handleStartTour() {
  clearError();

  if (!state.graph || !state.trees.length) {
    showError("Tour data is still loading.");
    return;
  }

  if (!state.currentPosition) {
    state.pendingTourStart = true;
    updateTourStatus("Waiting for a location fix before building the route...");
    requestLiveLocation(false);
    return;
  }

  try {
    setLoading(true, "Computing an optimized walking tour...");
    // Tour generation stays in the routing module so map code only deals with rendering.
    const tour = computeOptimizedWalkingTour({
      startPosition: state.currentPosition,
      trees: state.trees,
      graph: state.graph,
    });

    state.tour = tour;
    renderRoute(tour);
    updateTourSummary(tour);
    updateTourStatus(`Tour ready. ${tour.orderedStops.length} trees arranged from your current location.`);

    if (tour.orderedStops[0]) {
      selectTree(tour.orderedStops[0].id, true);
    }

    const routeBounds = L.latLngBounds(tour.coordinates.map(([lat, lng]) => [lat, lng]));
    state.map.fitBounds(routeBounds.pad(0.15), { animate: true, duration: 0.8 });
  } catch (error) {
    console.error(error);
    showError(error.message || "Route computation failed.");
    updateTourStatus("Route computation failed. Please try again.");
  } finally {
    state.pendingTourStart = false;
    setLoading(false);
  }
}

function requestLiveLocation(showPromptMessage) {
  if (!("geolocation" in navigator)) {
    showError("This browser does not support geolocation.");
    elements.permissionCopy.textContent = "Geolocation is unavailable in this browser.";
    updateLocationStatus("Browser geolocation unsupported.", false);
    return;
  }

  clearError();

  if (showPromptMessage) {
    elements.permissionCopy.textContent =
      "Please allow location access so the tour can start from your current position and update live as you walk.";
  }

  if (state.watchId === null) {
    updateLocationStatus("Requesting live location access...", true);
    state.watchId = navigator.geolocation.watchPosition(
      handleLocationSuccess,
      handleLocationError,
      GEOLOCATION_OPTIONS,
    );
  }
}

function stopTracking(statusMessage = "Tracking paused.") {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }

  updateLocationStatus(statusMessage, false);
}

function handleLocationSuccess(position) {
  state.currentPosition = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: position.coords.accuracy,
    timestamp: position.timestamp,
  };

  updateUserMarker();
  updateLocationStatus(
    `${formatCoordinates(state.currentPosition.lat, state.currentPosition.lng)} | +/-${Math.round(
      state.currentPosition.accuracy,
    )}m`,
    true,
  );
  elements.permissionCopy.textContent =
    "Location active. The app will keep your position marker updated while tracking remains on.";

  if (state.pendingTourStart) {
    handleStartTour();
  }
}

function handleLocationError(error) {
  state.pendingTourStart = false;

  if (error.code === error.PERMISSION_DENIED) {
    showError("Location access was denied. Enable it in your browser settings to build a tour from your position.");
    elements.permissionCopy.textContent =
      "Location permission is currently denied. You can retry or enable it from browser settings.";
    stopTracking("Location denied.");
    return;
  }

  if (error.code === error.TIMEOUT) {
    showError("Location lookup timed out. Try moving to an area with better GPS coverage.");
    stopTracking("Location lookup timed out.");
    return;
  }

  showError("A live location fix could not be retrieved.");
  stopTracking("Location unavailable.");
}

function createMap(center) {
  state.map = L.map("map", {
    zoomControl: false,
    preferCanvas: true,
  }).setView([center.lat, center.lng], DEFAULT_VIEW.zoom);

  L.control.zoom({ position: "bottomright" }).addTo(state.map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(state.map);
}

function renderTreeMarkers() {
  if (state.treeLayer) {
    state.treeLayer.remove();
  }

  const treeIcon = L.divIcon({
    className: "",
    html: '<span class="tree-pin"></span>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });

  const markers = state.trees.map((tree) => {
    const marker = L.marker([tree.latitude, tree.longitude], { icon: treeIcon });
    marker.bindPopup(buildTreePopup(tree), { maxWidth: 280 });
    marker.on("click", () => {
      selectTree(tree.id, false);
    });
    state.treeMarkers.set(tree.id, marker);
    return marker;
  });

  state.treeLayer = L.layerGroup(markers).addTo(state.map);
}

function renderRoute(tour) {
  if (state.routeLayer) {
    state.routeLayer.remove();
  }

  state.routeLayer = L.polyline(tour.coordinates, {
    color: "#23694a",
    weight: 5,
    opacity: 0.88,
    lineJoin: "round",
  }).addTo(state.map);
}

function updateUserMarker() {
  if (!state.map || !state.currentPosition) {
    return;
  }

  if (!state.userMarker) {
    // A lightweight div icon keeps the live position marker easy to theme with CSS.
    const userIcon = L.divIcon({
      className: "",
      html: '<span class="user-pin"></span>',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

    state.userMarker = L.marker([state.currentPosition.lat, state.currentPosition.lng], {
      icon: userIcon,
      zIndexOffset: 1000,
    }).addTo(state.map);
  } else {
    state.userMarker.setLatLng([state.currentPosition.lat, state.currentPosition.lng]);
  }
}

function selectTree(treeId, openPopup) {
  state.selectedTreeId = treeId;
  const tree = state.trees.find((item) => item.id === treeId);

  if (!tree) {
    return;
  }

  renderSelectedTree(tree);
  updateRouteStopSelection(treeId);

  if (openPopup) {
    state.treeMarkers.get(treeId)?.openPopup();
  }
}

function renderSelectedTree(tree) {
  elements.selectedTreeContent.innerHTML = "";
  elements.selectedTreeContent.append(buildTreeCard(tree));
}

function updateTourSummary(tour) {
  if (!tour) {
    elements.routeDistance.textContent = "-";
    elements.routeDuration.textContent = "-";
    elements.routeStopCount.textContent = "-";
    elements.routeStopList.innerHTML =
      '<li class="empty-state">Start a tour to see the optimized visit order.</li>';
    return;
  }

  elements.routeDistance.textContent = formatDistance(tour.totalDistanceMeters);
  elements.routeDuration.textContent = `${tour.estimatedMinutes} min`;
  elements.routeStopCount.textContent = String(tour.orderedStops.length);
  elements.routeStopList.innerHTML = "";

  const fragment = document.createDocumentFragment();

  tour.orderedStops.forEach((tree, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "route-stop-button";
    button.dataset.treeId = tree.id;
    button.innerHTML = `
      <strong>${index + 1}. ${tree.commonName}</strong>
      <small>${tree.scientificName} | ${tree.family}</small>
    `;
    button.addEventListener("click", () => {
      selectTree(tree.id, true);
      const marker = state.treeMarkers.get(tree.id);

      if (marker) {
        state.map.flyTo(marker.getLatLng(), 19, { animate: true, duration: 0.7 });
      }
    });
    item.append(button);
    fragment.append(item);
  });

  elements.routeStopList.append(fragment);
  updateRouteStopSelection(state.selectedTreeId);
}

function updateRouteStopSelection(activeTreeId) {
  elements.routeStopList.querySelectorAll(".route-stop-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.treeId === activeTreeId);
  });
}

function updateTreeCountBadge() {
  elements.treeCountBadge.textContent = `${state.trees.length} trees`;
}

function updateTourStatus(message) {
  elements.tourStatus.textContent = message;
}

function updateLocationStatus(message, isTracking) {
  elements.gpsStatus.textContent = message;
  elements.trackingBadge.textContent = isTracking ? "Tracking on" : "Tracking off";
  elements.appStatusPill.textContent = isTracking
    ? state.currentPosition
      ? "Location live"
      : "Locating"
    : "Ready";
}

function setButtonsDisabled(isDisabled) {
  elements.allowLocationButton.disabled = isDisabled;
  elements.startTourButton.disabled = isDisabled;
  elements.stopTrackingButton.disabled = isDisabled;
  elements.recenterButton.disabled = isDisabled;
}

function setLoading(isLoading, message = "Working...") {
  elements.loadingOverlay.classList.toggle("is-hidden", !isLoading);
  elements.loadingMessage.textContent = message;
}

function showError(message) {
  elements.errorBanner.textContent = message;
  elements.errorBanner.classList.remove("is-hidden");
}

function clearError() {
  elements.errorBanner.textContent = "";
  elements.errorBanner.classList.add("is-hidden");
}

function buildTreePopup(tree) {
  return buildTreeCard(tree, true);
}

function buildTreeCard(tree, compact = false) {
  const card = document.createElement("article");
  card.className = compact ? "popup-card" : "tree-card";

  const media = document.createElement("div");
  media.className = "tree-media";

  const image = document.createElement("img");
  image.alt = `${tree.commonName}`;
  image.loading = "lazy";
  image.src = buildImagePath(tree.photoFilename);

  const fallback = document.createElement("div");
  fallback.className = "tree-media-fallback";
  fallback.textContent = "Tree image unavailable";
  fallback.hidden = true;

  image.addEventListener("error", () => {
    image.remove();
    fallback.hidden = false;
  });

  media.append(image, fallback);

  const body = document.createElement("div");
  body.className = "tree-card-body";
  body.innerHTML = `
    <h3>${tree.commonName}</h3>
    <p><strong>${tree.scientificName}</strong></p>
    <p class="tree-card-meta">${tree.family}</p>
    <p class="tree-card-meta">Lat ${tree.latitude.toFixed(6)}, Lng ${tree.longitude.toFixed(6)}</p>
  `;

  card.append(media, body);
  return card;
}

function buildImagePath(filename) {
  return encodeURI(`./images/${filename}`);
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

function formatDistance(distanceMeters) {
  return distanceMeters >= 1000
    ? `${(distanceMeters / 1000).toFixed(2)} km`
    : `${Math.round(distanceMeters)} m`;
}

function formatCoordinates(lat, lng) {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
