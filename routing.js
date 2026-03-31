const REQUIRED_COLUMNS = [
  "Common Name",
  "Photo Filename",
  "Scientific Name",
  "Family",
  "Latitude",
  "Longitude",
];

const WALKING_SPEED_METERS_PER_MINUTE = 80;

export function parseTreesCsv(csvText) {
  const rows = parseCsv(csvText);
  const header = rows[0] ?? [];

  for (const column of REQUIRED_COLUMNS) {
    if (!header.includes(column)) {
      throw new Error(`Tree CSV is missing required column: ${column}`);
    }
  }

  return rows.slice(1).filter(hasData).map((row, index) => {
    const record = Object.fromEntries(header.map((column, cellIndex) => [column, row[cellIndex] ?? ""]));
    const latitude = Number.parseFloat(record["Latitude"]);
    const longitude = Number.parseFloat(record["Longitude"]);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error(`Invalid coordinates for tree row ${index + 2}.`);
    }

    return {
      id: `tree-${index + 1}`,
      commonName: record["Common Name"].trim(),
      photoFilename: record["Photo Filename"].trim(),
      scientificName: record["Scientific Name"].trim(),
      family: record["Family"].trim(),
      latitude,
      longitude,
    };
  });
}

export function buildGraphFromGeoJSON(geojson) {
  if (!geojson || geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    throw new Error("Pathway data is not a valid GeoJSON FeatureCollection.");
  }

  const nodes = new Map();
  const adjacency = new Map();
  let segmentCount = 0;

  const registerNode = (lng, lat) => {
    const id = coordKey(lat, lng);

    if (!nodes.has(id)) {
      nodes.set(id, { id, lat, lng });
      adjacency.set(id, []);
    }

    return nodes.get(id);
  };

  const addEdge = (fromNode, toNode) => {
    // Each pathway segment becomes a bidirectional weighted edge for walking.
    const distance = haversineDistance(fromNode, toNode);
    adjacency.get(fromNode.id).push({ to: toNode.id, distance });
    adjacency.get(toNode.id).push({ to: fromNode.id, distance });
    segmentCount += 1;
  };

  for (const feature of geojson.features) {
    const { geometry } = feature ?? {};

    if (!geometry) {
      continue;
    }

    const lineSets = geometry.type === "LineString"
      ? [geometry.coordinates]
      : geometry.type === "MultiLineString"
        ? geometry.coordinates
        : [];

    for (const coordinates of lineSets) {
      if (!Array.isArray(coordinates) || coordinates.length < 2) {
        continue;
      }

      for (let index = 0; index < coordinates.length - 1; index += 1) {
        const [fromLng, fromLat] = coordinates[index] ?? [];
        const [toLng, toLat] = coordinates[index + 1] ?? [];

        if (![fromLng, fromLat, toLng, toLat].every(Number.isFinite)) {
          continue;
        }

        const fromNode = registerNode(fromLng, fromLat);
        const toNode = registerNode(toLng, toLat);
        addEdge(fromNode, toNode);
      }
    }
  }

  if (!nodes.size || !segmentCount) {
    throw new Error("No usable pathways were found in the GeoJSON data.");
  }

  return {
    nodes,
    adjacency,
    nodeList: Array.from(nodes.values()),
    segmentCount,
  };
}

export function attachNearestGraphNodes(items, graph) {
  return items.map((item) => {
    const nearestNode = findNearestGraphNode(
      { lat: item.latitude, lng: item.longitude },
      graph,
    );

    return {
      ...item,
      nearestNodeId: nearestNode.id,
      graphOffsetMeters: nearestNode.distance,
    };
  });
}

export function computeOptimizedWalkingTour({ startPosition, trees, graph }) {
  if (!startPosition) {
    throw new Error("A valid start position is required to compute a tour.");
  }

  if (!trees.length) {
    throw new Error("No tree data is available for route generation.");
  }

  const startNode = findNearestGraphNode(startPosition, graph);
  const unvisited = new Map(trees.map((tree) => [tree.id, tree]));
  const orderedStops = [];
  const pathSegments = [];
  let currentNodeId = startNode.id;

  while (unvisited.size) {
    let bestCandidate = null;

    for (const tree of unvisited.values()) {
      // Use shortest-path distance on the graph to decide the next nearest unvisited tree.
      const result = dijkstra(graph, currentNodeId, tree.nearestNodeId);

      if (!Number.isFinite(result.distance)) {
        continue;
      }

      if (!bestCandidate || result.distance < bestCandidate.path.distance) {
        bestCandidate = { tree, path: result };
      }
    }

    if (!bestCandidate) {
      throw new Error("A complete walking route could not be computed on the pathway network.");
    }

    orderedStops.push(bestCandidate.tree);
    pathSegments.push(bestCandidate.path);
    currentNodeId = bestCandidate.tree.nearestNodeId;
    unvisited.delete(bestCandidate.tree.id);
  }

  const coordinates = [];
  const pushCoordinate = (coordinate) => {
    const last = coordinates[coordinates.length - 1];

    if (!last || last[0] !== coordinate[0] || last[1] !== coordinate[1]) {
      coordinates.push(coordinate);
    }
  };

  pushCoordinate([startPosition.lat, startPosition.lng]);
  pushCoordinate([startNode.lat, startNode.lng]);

  let totalNetworkMeters = 0;
  let totalConnectorMeters = startNode.distance;

  orderedStops.forEach((tree, index) => {
    const segment = pathSegments[index];
    const pathCoordinates = segment.path.map((nodeId) => {
      const node = graph.nodes.get(nodeId);
      return [node.lat, node.lng];
    });

    // The rendered route includes the graph path plus a short connector to the tree itself.
    pathCoordinates.forEach(pushCoordinate);
    pushCoordinate([tree.latitude, tree.longitude]);

    const isLastStop = index === orderedStops.length - 1;

    totalNetworkMeters += segment.distance;
    totalConnectorMeters += tree.graphOffsetMeters * (isLastStop ? 1 : 2);

    if (!isLastStop) {
      const anchorNode = graph.nodes.get(tree.nearestNodeId);
      pushCoordinate([anchorNode.lat, anchorNode.lng]);
    }
  });

  const totalDistanceMeters = totalNetworkMeters + totalConnectorMeters;
  const estimatedMinutes = Math.max(1, Math.round(totalDistanceMeters / WALKING_SPEED_METERS_PER_MINUTE));

  return {
    startNode,
    orderedStops,
    coordinates,
    pathSegments,
    totalDistanceMeters,
    estimatedMinutes,
  };
}

export function findNearestGraphNode(position, graph) {
  if (!graph?.nodeList?.length) {
    throw new Error("The pathway graph is empty.");
  }

  let nearestNode = null;

  for (const node of graph.nodeList) {
    const distance = haversineDistance(position, node);

    if (!nearestNode || distance < nearestNode.distance) {
      nearestNode = { ...node, distance };
    }
  }

  return nearestNode;
}

export function dijkstra(graph, startId, endId) {
  if (startId === endId) {
    return { distance: 0, path: [startId] };
  }

  const distances = new Map([[startId, 0]]);
  const previous = new Map();
  const visited = new Set();
  const queue = new PriorityQueue();

  queue.push(startId, 0);

  while (!queue.isEmpty()) {
    const current = queue.pop();

    if (!current || visited.has(current.value)) {
      continue;
    }

    visited.add(current.value);

    if (current.value === endId) {
      break;
    }

    for (const edge of graph.adjacency.get(current.value) ?? []) {
      if (visited.has(edge.to)) {
        continue;
      }

      const nextDistance = (distances.get(current.value) ?? Number.POSITIVE_INFINITY) + edge.distance;

      if (nextDistance < (distances.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        distances.set(edge.to, nextDistance);
        previous.set(edge.to, current.value);
        queue.push(edge.to, nextDistance);
      }
    }
  }

  const finalDistance = distances.get(endId);

  if (!Number.isFinite(finalDistance)) {
    return { distance: Number.POSITIVE_INFINITY, path: [] };
  }

  const path = [];
  let currentNodeId = endId;

  while (currentNodeId) {
    path.unshift(currentNodeId);
    currentNodeId = previous.get(currentNodeId);
  }

  if (path[0] !== startId) {
    return { distance: Number.POSITIVE_INFINITY, path: [] };
  }

  return { distance: finalDistance, path };
}

export function haversineDistance(from, to) {
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

function parseCsv(csvText) {
  const rows = [];
  let row = [];
  let value = "";
  let insideQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const character = csvText[index];
    const nextCharacter = csvText[index + 1];

    if (character === '"') {
      if (insideQuotes && nextCharacter === '"') {
        value += '"';
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
      continue;
    }

    if (character === "," && !insideQuotes) {
      row.push(value);
      value = "";
      continue;
    }

    if ((character === "\n" || character === "\r") && !insideQuotes) {
      if (character === "\r" && nextCharacter === "\n") {
        index += 1;
      }

      row.push(value);
      rows.push(row);
      row = [];
      value = "";
      continue;
    }

    value += character;
  }

  if (value.length || row.length) {
    row.push(value);
    rows.push(row);
  }

  return rows;
}

function hasData(row) {
  return row.some((cell) => cell.trim().length > 0);
}

function coordKey(lat, lng) {
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

class PriorityQueue {
  constructor() {
    this.items = [];
  }

  push(value, priority) {
    this.items.push({ value, priority });
    this.bubbleUp(this.items.length - 1);
  }

  pop() {
    if (!this.items.length) {
      return null;
    }

    const top = this.items[0];
    const end = this.items.pop();

    if (this.items.length && end) {
      this.items[0] = end;
      this.bubbleDown(0);
    }

    return top;
  }

  isEmpty() {
    return this.items.length === 0;
  }

  bubbleUp(index) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);

      if (this.items[parentIndex].priority <= this.items[index].priority) {
        break;
      }

      [this.items[parentIndex], this.items[index]] = [this.items[index], this.items[parentIndex]];
      index = parentIndex;
    }
  }

  bubbleDown(index) {
    const lastIndex = this.items.length - 1;

    while (true) {
      const leftIndex = index * 2 + 1;
      const rightIndex = index * 2 + 2;
      let smallest = index;

      if (leftIndex <= lastIndex && this.items[leftIndex].priority < this.items[smallest].priority) {
        smallest = leftIndex;
      }

      if (rightIndex <= lastIndex && this.items[rightIndex].priority < this.items[smallest].priority) {
        smallest = rightIndex;
      }

      if (smallest === index) {
        break;
      }

      [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
      index = smallest;
    }
  }
}
