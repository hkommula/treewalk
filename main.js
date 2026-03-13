const STORAGE_KEY = 'tree-trail-collected-v3';
const PANEL_COLLAPSED_KEY = 'tree-trail-panel-collapsed-v1';
const COLLECT_RADIUS_METERS = 16;
const SCAN_RADIUS_METERS = 60;
const DEFAULT_ZOOM = 17;
const FOLLOW_ZOOM = 18;
const FIT_MAX_ZOOM = 17;
const MAX_ZOOM = 19;
const OSRM_BASE_URL = 'https://router.project-osrm.org';
const OSRM_PROFILE = 'foot';
const routingClient = new window.OsrmRoutingClient({
  baseUrl: OSRM_BASE_URL,
  profile: OSRM_PROFILE,
});
const MAP_ICONS = {
  locate: `
    <svg viewBox="0 0 24 24" role="presentation" aria-hidden="true">
      <path d="M12 3.5v3.2M20.5 12h-3.2M12 20.5v-3.2M3.5 12h3.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <circle cx="12" cy="12" r="5.1" fill="none" stroke="currentColor" stroke-width="1.8"/>
      <circle cx="12" cy="12" r="1.7" fill="currentColor"/>
    </svg>
  `,
  follow: `
    <svg viewBox="0 0 24 24" role="presentation" aria-hidden="true">
      <path d="M5 18 18.7 5.3M11.6 5H19v7.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M6 6.5h4.1M6 6.5v4.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>
  `,
};
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
  nextTargetName: document.getElementById('nextTargetName'),
  nextTargetMeta: document.getElementById('nextTargetMeta'),
  remainingCount: document.getElementById('remainingCount'),
  panelNote: document.getElementById('panelNote'),
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
  const label = state.panelCollapsed ? 'Open panel' : 'Collapse panel';
  el.panelToggleBtn.setAttribute('aria-label', label);
  el.panelToggleBtn.setAttribute('title', label);
  el.panelToggleText.textContent = label;
  localStorage.setItem(PANEL_COLLAPSED_KEY, String(state.panelCollapsed));
}

function collapseTransientUi(evt = null) {
  const rawTarget = evt?.originalEvent?.target;
  if (rawTarget instanceof Element && rawTarget.closest('.leaflet-interactive, .leaflet-popup, .leaflet-control-container')) {
    return;
  }

  state.map?.closePopup();
  state.panelCollapsed = true;
  syncPanelState();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

function getFocusTargetPoint() {
  const size = state.map.getSize();
  const defaultTarget = L.point(size.x / 2, size.y / 2);

  if (!isMobileLayout() || !el.floatingPanel) return defaultTarget;

  const mapRect = state.map.getContainer().getBoundingClientRect();
  const panelRect = el.floatingPanel.getBoundingClientRect();
  const occupiedTop = Math.max(0, panelRect.top - mapRect.top);

  if (occupiedTop <= 0) return defaultTarget;

  return L.point(size.x / 2, Math.max(48, occupiedTop / 2));
}

function focusTreeInView(tree, marker) {
  if (!tree || !marker || !state.map) return;

  const latLng = L.latLng(tree.lat, tree.lng);
  const currentZoom = state.map.getZoom();
  const targetZoom = Math.max(currentZoom, DEFAULT_ZOOM);

  state.map.setView(latLng, targetZoom, { animate: true });
  marker.openPopup();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const zoom = state.map.getZoom();
      const targetPoint = getFocusTargetPoint();
      const size = state.map.getSize();
      const currentCenterProjected = state.map.project(state.map.getCenter(), zoom);
      const latLngProjected = state.map.project(latLng, zoom);
      const currentContainerPoint = latLngProjected
        .subtract(currentCenterProjected)
        .add(L.point(size.x / 2, size.y / 2));
      const adjustedCenterProjected = currentCenterProjected.add(currentContainerPoint.subtract(targetPoint));
      state.map.panTo(state.map.unproject(adjustedCenterProjected, zoom), { animate: true });
    });
  });
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
    const tableData = {
      distances: await routingClient.getDistanceMatrix([userPoint, ...remaining]),
    };
    if (token !== state.routeRequestToken) return;

    const ordered = buildRouteFromMatrix(remaining, tableData.distances) || state.route;
    if (!ordered.length) return;

    state.route = ordered;
    state.currentTargetId = state.route[0]?.id || null;

    const bestRoute = await routingClient.getWalkingRoute([userPoint, ...state.route]);
    if (token !== state.routeRequestToken) return;
    if (!bestRoute) throw new Error('OSRM route response did not include a route.');
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
    if (el.panelNote) el.panelNote.textContent = 'Using fallback route lines. Walking directions were unavailable.';
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
    if (el.panelNote) el.panelNote.textContent = 'Tap the location button on the map to begin.';
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
  if (el.panelNote) {
    el.panelNote.textContent = nearest
      ? `${nearest.tree.name} is ${formatMeters(nearest.dist)} away.`
      : `No uncollected trees inside ${SCAN_RADIUS_METERS} m.`;
  }

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
    if (el.panelNote) el.panelNote.textContent = 'Geolocation is not available in this browser.';
    return;
  }

  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = navigator.geolocation.watchPosition(
    pos => {
      moveUser(pos.coords.latitude, pos.coords.longitude);
      if (el.panelNote) el.panelNote.textContent = 'Following your position. Trees collect automatically when you move close enough.';
    },
    err => {
      if (el.panelNote) el.panelNote.textContent = 'Location access was blocked, so the trail stays in preview mode.';
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
    label: MAP_ICONS.locate,
    onClick: startLocation,
  });

  state.controls.follow = createMapButtonControl({
    title: 'Toggle follow mode',
    label: MAP_ICONS.follow,
    onClick: () => {
      state.followUser = !state.followUser;
      document.querySelectorAll('.map-control-btn').forEach(btn => {
        if (btn.title === 'Toggle follow mode') btn.classList.toggle('active', state.followUser);
      });
      if (state.followUser && state.userLatLng) {
        state.map.setView(state.userLatLng, FOLLOW_ZOOM, { animate: true });
      }
      if (el.panelNote) el.panelNote.textContent = state.followUser ? 'Follow mode is on.' : 'Follow mode is off.';
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
    zoomControl: false,
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
    marker.on('click', evt => {
      if (evt?.originalEvent) L.DomEvent.stop(evt.originalEvent);
      state.panelCollapsed = false;
      syncPanelState();
      state.currentTargetId = tree.id;
      updateMarkers();
      focusTreeInView(tree, marker);
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
  state.map.on('click', evt => collapseTransientUi(evt));

  el.routePanel.addEventListener('click', evt => {
    const stop = evt.target.closest('.route-stop');
    if (!stop) return;

    const tree = TREES.find(item => item.id === Number(stop.dataset.treeId));
    if (!tree) return;

    state.panelCollapsed = false;
    syncPanelState();
    state.currentTargetId = tree.id;
    updateMarkers();
    const marker = state.treeLayers.get(tree.id);
    if (marker) focusTreeInView(tree, marker);
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
  if (el.panelNote) el.panelNote.textContent = 'Collection reset. Route rebuilt for all trees.';
});

initMap();
