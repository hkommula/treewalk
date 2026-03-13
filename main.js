const STORAGE_KEY = 'tree-trail-collected-v3';
const PANEL_COLLAPSED_KEY = 'tree-trail-panel-collapsed-v1';
const COLLECT_RADIUS_METERS = 16;
const SCAN_RADIUS_METERS = 60;
const DEFAULT_ZOOM = 17;
const FOLLOW_ZOOM = 18;
const FIT_MAX_ZOOM = 17;
const MAX_ZOOM = 19;
const OSRM_BASE_URL = 'https://router.project-osrm.org';
const speciesTotal = new Set(TREES.map(tree => tree.name.trim()).filter(Boolean)).size;

const state = {
  map: null,
  userMarker: null,
  userLatLng: null,
  watchId: null,
  followUser: true,
  route: [],
  routePolyline: null,
  connectorPolyline: null,
  routeMetrics: {
    totalDistance: 0,
    distanceToTree: new Map(),
    source: 'fallback',
  },
  treeLayers: new Map(),
  collected: new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')),
  currentTargetId: null,
  controls: {},
  routeRequestToken: 0,
  panelCollapsed: localStorage.getItem(PANEL_COLLAPSED_KEY) === 'true',
};

const el = {
  fitBtn: document.getElementById('fitBtn'),
  resetBtn: document.getElementById('resetBtn'),
  speciesCount: document.getElementById('speciesCount'),
  speciesTotal: document.getElementById('speciesTotal'),
  collectionPercent: document.getElementById('collectionPercent'),
  progressBar: document.getElementById('progressBar'),
  collectionPanel: document.getElementById('collectionPanel'),
  routeDistance: document.getElementById('routeDistance'),
  routePanel: document.getElementById('routePanel'),
  scannerCount: document.getElementById('scannerCount'),
  scannerHint: document.getElementById('scannerHint'),
  nextTargetName: document.getElementById('nextTargetName'),
  nextTargetMeta: document.getElementById('nextTargetMeta'),
  remainingCount: document.getElementById('remainingCount'),
  mapHud: document.getElementById('mapHud'),
  floatingPanel: document.getElementById('floatingPanel'),
  panelToggleBtn: document.getElementById('panelToggleBtn'),
  panelToggleText: document.querySelector('.panel-toggle-text'),
};

function getMarkerStyle(tree) {
  const collected = state.collected.has(tree.name);
  const active = tree.id === state.currentTargetId;
  return {
    radius: active ? 9 : 6,
    color: active ? '#72dcff' : collected ? 'rgba(104,122,136,0.65)' : '#0c677e',
    weight: active ? 3 : 1.5,
    fillColor: active ? '#72dcff' : collected ? 'rgba(151,165,176,0.35)' : '#51e6b1',
    fillOpacity: collected ? 0.2 : active ? 0.96 : 0.84,
    opacity: collected ? 0.38 : 1,
  };
}

function haversine(a, b) {
  const R = 6371000;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const q = s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
  return 2 * R * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}

function totalRouteDistance(route) {
  let total = 0;
  for (let i = 1; i < route.length; i++) total += haversine(route[i - 1], route[i]);
  return total;
}

function getRemainingTrees() {
  return TREES.filter(tree => !state.collected.has(tree.name));
}

function resetRouteMetrics() {
  state.routeMetrics = {
    totalDistance: state.route.length ? totalRouteDistance(state.route) : 0,
    distanceToTree: new Map(),
    source: 'fallback',
  };

  if (!state.userLatLng || !state.route.length) return;

  let running = haversine({ lat: state.userLatLng.lat, lng: state.userLatLng.lng }, state.route[0]);
  state.routeMetrics.distanceToTree.set(state.route[0].id, running);

  for (let i = 1; i < state.route.length; i++) {
    running += haversine(state.route[i - 1], state.route[i]);
    state.routeMetrics.distanceToTree.set(state.route[i].id, running);
  }
}

function twoOpt(route, startPoint = null) {
  const ordered = [...route];
  let improved = true;

  while (improved) {
    improved = false;
    for (let i = 0; i < ordered.length - 2; i++) {
      for (let k = i + 1; k < ordered.length - 1; k++) {
        const A = i === 0 ? (startPoint || ordered[0]) : ordered[i - 1];
        const B = ordered[i];
        const C = ordered[k];
        const D = ordered[k + 1];
        const currentDist = haversine(A, B) + haversine(C, D);
        const swappedDist = haversine(A, C) + haversine(B, D);
        if (swappedDist + 0.01 < currentDist) {
          const slice = ordered.slice(i, k + 1).reverse();
          ordered.splice(i, k - i + 1, ...slice);
          improved = true;
        }
      }
    }
  }

  return ordered;
}

function buildOptimizedRoute(startPoint = null) {
  const remaining = getRemainingTrees();
  if (!remaining.length) {
    state.route = [];
    state.currentTargetId = null;
    resetRouteMetrics();
    return;
  }

  let current = startPoint || remaining[0];
  const ordered = [];
  const pool = [...remaining];

  while (pool.length) {
    let bestIndex = 0;
    let bestDist = Infinity;

    pool.forEach((tree, idx) => {
      const dist = haversine(current, tree);
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = idx;
      }
    });

    const next = pool.splice(bestIndex, 1)[0];
    ordered.push(next);
    current = next;
  }

  state.route = ordered.length > 2 ? twoOpt(ordered, startPoint) : ordered;
  state.currentTargetId = state.route[0]?.id || null;
  resetRouteMetrics();
}

function getLocalImagePath(tree) {
  return `images/${encodeURIComponent(tree.name)}_01.png`;
}

function getTreePhotoUrl(tree) {
  return getLocalImagePath(tree);
}

function routeDistanceFromUser(tree) {
  if (!state.userLatLng || !tree) return null;
  return haversine({ lat: state.userLatLng.lat, lng: state.userLatLng.lng }, tree);
}

function routeDistanceForTree(tree) {
  if (!tree) return null;
  if (state.routeMetrics.distanceToTree.has(tree.id)) {
    return state.routeMetrics.distanceToTree.get(tree.id);
  }
  return routeDistanceFromUser(tree);
}

function buildRouteFromMatrix(remaining, distances) {
  const ordered = [];
  const pending = new Set(remaining.map((_, idx) => idx + 1));
  let currentIdx = 0;

  while (pending.size) {
    let bestIdx = null;
    let bestDist = Infinity;

    pending.forEach(candidateIdx => {
      const dist = distances[currentIdx]?.[candidateIdx];
      if (Number.isFinite(dist) && dist < bestDist) {
        bestDist = dist;
        bestIdx = candidateIdx;
      }
    });

    if (bestIdx == null) break;
    ordered.push(remaining[bestIdx - 1]);
    pending.delete(bestIdx);
    currentIdx = bestIdx;
  }

  return ordered.length === remaining.length ? ordered : null;
}

async function fetchOsrmJson(path) {
  const response = await fetch(`${OSRM_BASE_URL}${path}`);
  if (!response.ok) throw new Error(`OSRM request failed: ${response.status}`);

  const data = await response.json();
  if (data.code !== 'Ok') throw new Error(`OSRM error: ${data.code}`);
  return data;
}

function bearingBetween(a, b) {
  const toRad = deg => deg * Math.PI / 180;
  const toDeg = rad => (rad * 180 / Math.PI + 360) % 360;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat))
    - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return toDeg(Math.atan2(y, x));
}

function bearingLabel(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

function formatMeters(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

function isMobileLayout() {
  return window.matchMedia('(max-width: 899px)').matches;
}

function syncPanelState() {
  if (!el.floatingPanel || !el.panelToggleBtn || !el.panelToggleText) return;

  el.floatingPanel.dataset.collapsed = state.panelCollapsed ? 'true' : 'false';
  el.panelToggleBtn.setAttribute('aria-expanded', state.panelCollapsed ? 'false' : 'true');
  el.panelToggleText.textContent = state.panelCollapsed ? 'Expand' : 'Collapse';
  localStorage.setItem(PANEL_COLLAPSED_KEY, String(state.panelCollapsed));
}

function collapseTransientUi() {
  state.map?.closePopup();
  state.panelCollapsed = true;
  syncPanelState();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

function updateNextTargetSummary() {
  if (!state.userLatLng) {
    el.nextTargetName.textContent = state.route[0]?.name || 'Awaiting position';
    el.nextTargetMeta.textContent = state.route[0]
      ? `${state.route[0].family || 'family unknown'} - route prepared`
      : 'Distance and direction appear here while walking.';
    return;
  }

  const user = { lat: state.userLatLng.lat, lng: state.userLatLng.lng };
  const next = state.route[0] || null;

  if (!next) {
    el.nextTargetName.textContent = 'Trail complete';
    el.nextTargetMeta.textContent = 'Every species on the route has been collected.';
    return;
  }

  const dist = routeDistanceForTree(next) ?? haversine(user, next);
  const bearing = bearingBetween(user, next);
  el.nextTargetName.textContent = next.name;
  el.nextTargetMeta.textContent = `${formatMeters(dist)} - ${bearingLabel(bearing)} - ${next.family || 'family unknown'}`;
}

async function updateRouteFromOsm() {
  if (!state.userLatLng) return;

  const remaining = getRemainingTrees();
  if (!remaining.length) {
    state.route = [];
    state.currentTargetId = null;
    resetRouteMetrics();
    renderRoutePanel();
    updatePolylines();
    updateNextTargetSummary();
    return;
  }

  const token = ++state.routeRequestToken;
  const userPoint = { lat: state.userLatLng.lat, lng: state.userLatLng.lng };

  try {
    const tableCoords = [userPoint, ...remaining].map(point => `${point.lng},${point.lat}`).join(';');
    const tableData = await fetchOsrmJson(`/table/v1/foot/${tableCoords}?annotations=distance`);
    if (token !== state.routeRequestToken) return;

    const ordered = buildRouteFromMatrix(remaining, tableData.distances) || state.route;
    if (!ordered.length) return;

    state.route = ordered;
    state.currentTargetId = state.route[0]?.id || null;

    const routeCoords = [userPoint, ...state.route].map(point => `${point.lng},${point.lat}`).join(';');
    const routeData = await fetchOsrmJson(`/route/v1/foot/${routeCoords}?overview=full&geometries=geojson&steps=false`);
    if (token !== state.routeRequestToken) return;

    const bestRoute = routeData.routes[0];
    const distanceToTree = new Map();
    let running = 0;

    bestRoute.legs.forEach((leg, idx) => {
      running += leg.distance;
      const tree = state.route[idx];
      if (tree) distanceToTree.set(tree.id, running);
    });

    state.routeMetrics = {
      totalDistance: bestRoute.distance,
      distanceToTree,
      source: 'osm',
    };

    if (state.routePolyline) state.routePolyline.remove();
    state.routePolyline = L.polyline(
      bestRoute.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      {
        color: '#72dcff',
        weight: 4,
        opacity: 0.72,
      }
    ).addTo(state.map);

    if (state.connectorPolyline) {
      state.connectorPolyline.remove();
      state.connectorPolyline = null;
    }

    updateMarkers();
    renderRoutePanel();
    updateNextTargetSummary();
  } catch (error) {
    if (token !== state.routeRequestToken) return;
    console.error(error);
    resetRouteMetrics();
    updatePolylines();
    renderRoutePanel();
    updateNextTargetSummary();
    el.mapHud.textContent = 'Using fallback route lines. OSM walking directions were unavailable.';
  }
}

function saveCollection() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.collected]));
}

function renderCollection() {
  const names = [...state.collected].sort((a, b) => a.localeCompare(b));
  const percent = speciesTotal ? Math.round((names.length / speciesTotal) * 100) : 0;
  el.speciesTotal.textContent = speciesTotal;
  el.speciesCount.textContent = names.length;
  el.collectionPercent.textContent = `${percent}%`;
  el.progressBar.style.width = `${percent}%`;
  el.collectionPanel.innerHTML = names.length
    ? names.map(name => `<span class="species-chip">${name}</span>`).join('')
    : '<span class="status-note">No species collected yet.</span>';
}

function popupHtml(tree) {
  const photoUrl = getTreePhotoUrl(tree);
  const photo = photoUrl ? `<img src="${photoUrl}" alt="${tree.name}" onerror="this.style.display='none'">` : '';
  const collected = state.collected.has(tree.name);

  return `
    <div class="tree-popup">
      ${photo}
      <div class="popup-name">${tree.name}</div>
      <div class="popup-meta">
        <div><em>${tree.scientific || 'Unknown scientific name'}</em></div>
        <div>${tree.family || 'Unknown family'}</div>
      </div>
      <div class="popup-actions">
        <button type="button" data-collect="${tree.id}">${collected ? 'Completed' : 'Complete'}</button>
        ${photoUrl ? `<a href="${photoUrl}" target="_blank" rel="noreferrer noopener">View photo</a>` : ''}
      </div>
    </div>
  `;
}

function updateMarkers() {
  TREES.forEach(tree => {
    const layer = state.treeLayers.get(tree.id);
    if (layer) layer.setStyle(getMarkerStyle(tree));
  });
}

function renderRoutePanel() {
  const remainingCount = getRemainingTrees().length;
  el.remainingCount.textContent = `${remainingCount} left`;

  el.routePanel.innerHTML = state.route.length
    ? state.route.map((tree, idx) => {
        const active = tree.id === state.currentTargetId;
        const distance = routeDistanceForTree(tree);
        return `
          <div class="route-stop ${active ? 'active' : ''}" data-tree-id="${tree.id}">
            <div class="stop-index">${idx + 1}</div>
            <div>
              <p class="stop-name">${tree.name}</p>
              <p class="stop-meta">${tree.family || 'Unknown family'}${distance != null ? ` - ${formatMeters(distance)}` : ''}</p>
            </div>
          </div>
        `;
      }).join('')
    : '<div class="status-note">Trail complete. Every species has been collected.</div>';

  const totalDistance = state.routeMetrics.totalDistance || 0;
  el.routeDistance.textContent = state.route.length ? `${(totalDistance / 1000).toFixed(2)} km walk` : 'Trail complete';
}

function updatePolylines() {
  if (state.routePolyline) state.routePolyline.remove();
  if (state.connectorPolyline) state.connectorPolyline.remove();
  state.routePolyline = null;
  state.connectorPolyline = null;

  if (state.route.length) {
    const latlngs = state.route.map(tree => [tree.lat, tree.lng]);
    state.routePolyline = L.polyline(latlngs, {
      color: '#72dcff',
      weight: 4,
      opacity: 0.52,
      dashArray: '8 10',
    }).addTo(state.map);
  }

  const next = state.route[0];
  if (state.userLatLng && next) {
    state.connectorPolyline = L.polyline([
      [state.userLatLng.lat, state.userLatLng.lng],
      [next.lat, next.lng],
    ], {
      color: '#51e6b1',
      weight: 4,
      opacity: 0.9,
    }).addTo(state.map);
  }
}

function fitRoute() {
  const points = state.route.map(tree => [tree.lat, tree.lng]);
  if (state.userLatLng) points.unshift([state.userLatLng.lat, state.userLatLng.lng]);
  if (!points.length) return;
  state.map.fitBounds(points, { padding: [40, 40], maxZoom: FIT_MAX_ZOOM });
}

function refreshRouteFromLocation() {
  buildOptimizedRoute(state.userLatLng ? { lat: state.userLatLng.lat, lng: state.userLatLng.lng } : null);
  updateMarkers();
  renderRoutePanel();
  updatePolylines();
  updateRouteFromOsm();
}

function collectTree(tree) {
  if (!tree || state.collected.has(tree.name)) return false;
  state.collected.add(tree.name);
  saveCollection();
  renderCollection();
  refreshRouteFromLocation();
  updateScanner();
  return true;
}

function updateScanner() {
  if (!state.userLatLng) {
    el.scannerCount.textContent = 'Preview mode';
    el.scannerHint.textContent = 'Tap the location button on the map to begin.';
    updateNextTargetSummary();
    return;
  }

  const user = { lat: state.userLatLng.lat, lng: state.userLatLng.lng };
  const nearby = getRemainingTrees()
    .map(tree => ({ tree, dist: haversine(user, tree) }))
    .filter(item => item.dist <= SCAN_RADIUS_METERS)
    .sort((a, b) => a.dist - b.dist);

  nearby.forEach(item => {
    if (item.dist <= COLLECT_RADIUS_METERS) collectTree(item.tree);
  });

  const nearest = nearby[0];
  el.scannerCount.textContent = nearby.length ? `${nearby.length} in range` : 'Scanning';
  el.scannerHint.textContent = nearest
    ? `${nearest.tree.name} is ${formatMeters(nearest.dist)} away.`
    : `No uncollected trees inside ${SCAN_RADIUS_METERS} m.`;

  const next = state.route[0] || null;
  state.currentTargetId = next?.id || null;
  updateMarkers();
  updateNextTargetSummary();
  renderRoutePanel();
  updatePolylines();
}

function moveUser(lat, lng) {
  state.userLatLng = L.latLng(lat, lng);

  if (!state.userMarker) {
    state.userMarker = L.circleMarker(state.userLatLng, {
      radius: 8,
      color: '#071018',
      weight: 3,
      fillColor: '#58a6ff',
      fillOpacity: 1,
    }).addTo(state.map).bindTooltip('You', { direction: 'top', offset: [0, -8] });
  } else {
    state.userMarker.setLatLng(state.userLatLng);
  }

  refreshRouteFromLocation();
  updateScanner();

  if (state.followUser) {
    state.map.setView(state.userLatLng, FOLLOW_ZOOM, { animate: true });
  }
}

function startLocation() {
  if (!navigator.geolocation) {
    el.mapHud.textContent = 'Geolocation is not available in this browser.';
    return;
  }

  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = navigator.geolocation.watchPosition(
    pos => {
      moveUser(pos.coords.latitude, pos.coords.longitude);
      el.mapHud.textContent = 'Following your position. Trees collect automatically when you move close enough.';
    },
    err => {
      el.mapHud.textContent = 'Location access was blocked, so the trail stays in preview mode.';
      console.error(err);
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 12000 }
  );
}

function createMapButtonControl({ position = 'topleft', title, label, onClick, className = '' }) {
  const Control = L.Control.extend({
    options: { position },
    onAdd() {
      const container = L.DomUtil.create('div', 'leaflet-bar map-actions');
      const button = L.DomUtil.create('button', `map-control-btn ${className}`.trim(), container);
      button.type = 'button';
      button.title = title;
      button.setAttribute('aria-label', title);
      button.innerHTML = label;
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.on(button, 'click', L.DomEvent.stop);
      L.DomEvent.on(button, 'click', onClick);
      return container;
    },
  });

  const control = new Control();
  state.map.addControl(control);
  return control;
}

function initMapControls() {
  state.controls.locate = createMapButtonControl({
    title: 'Use my location',
    label: 'LOC',
    onClick: startLocation,
  });

  state.controls.follow = createMapButtonControl({
    title: 'Toggle follow mode',
    label: 'FOL',
    onClick: () => {
      state.followUser = !state.followUser;
      document.querySelectorAll('.map-control-btn').forEach(btn => {
        if (btn.title === 'Toggle follow mode') btn.classList.toggle('active', state.followUser);
      });
      if (state.followUser && state.userLatLng) {
        state.map.setView(state.userLatLng, FOLLOW_ZOOM, { animate: true });
      }
      el.mapHud.textContent = state.followUser ? 'Follow mode is on.' : 'Follow mode is off.';
    },
    className: 'active',
  });
}

function initPanelControls() {
  syncPanelState();
  el.panelToggleBtn?.addEventListener('click', () => {
    state.panelCollapsed = !state.panelCollapsed;
    syncPanelState();
  });
}

function initMap() {
  const center = [TREES[0].lat, TREES[0].lng];
  state.map = L.map('map', {
    zoomControl: true,
    minZoom: 3,
    maxZoom: MAX_ZOOM,
    zoomSnap: 1,
  }).setView(center, DEFAULT_ZOOM);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: MAX_ZOOM,
  }).addTo(state.map);

  TREES.forEach(tree => {
    const marker = L.circleMarker([tree.lat, tree.lng], {
      ...getMarkerStyle(tree),
      bubblingMouseEvents: false,
    }).addTo(state.map);
    marker.bindPopup(popupHtml(tree));
    marker.on('popupopen', () => {
      setTimeout(() => {
        const btn = document.querySelector(`[data-collect="${tree.id}"]`);
        if (btn) {
          btn.onclick = () => {
            collectTree(tree);
            marker.setPopupContent(popupHtml(tree));
          };
        }
      }, 20);
    });
    marker.on('click', () => {
      state.panelCollapsed = isMobileLayout() ? false : state.panelCollapsed;
      syncPanelState();
      state.currentTargetId = tree.id;
      updateMarkers();
      renderRoutePanel();
    });
    state.treeLayers.set(tree.id, marker);
  });

  renderCollection();
  refreshRouteFromLocation();
  updateScanner();
  fitRoute();
  initMapControls();
  initPanelControls();
  state.map.on('click', collapseTransientUi);

  el.routePanel.addEventListener('click', evt => {
    const stop = evt.target.closest('.route-stop');
    if (!stop) return;

    const tree = TREES.find(item => item.id === Number(stop.dataset.treeId));
    if (!tree) return;

    state.panelCollapsed = false;
    syncPanelState();
    state.currentTargetId = tree.id;
    updateMarkers();
    state.map.setView([tree.lat, tree.lng], DEFAULT_ZOOM, { animate: true });
    state.treeLayers.get(tree.id)?.openPopup();
    renderRoutePanel();
  });
}

el.fitBtn.addEventListener('click', fitRoute);
el.resetBtn.addEventListener('click', () => {
  state.collected.clear();
  saveCollection();
  renderCollection();
  refreshRouteFromLocation();
  updateScanner();
  el.mapHud.textContent = 'Collection reset. Route rebuilt for all trees.';
});

initMap();
