const REQUIRED_COLUMNS = [
  "Common Name",
  "Photo Filename",
  "Scientific Name",
  "Family",
  "Latitude",
  "Longitude",
];

const WALKWAY_HIGHWAYS = new Set(["footway", "path", "pedestrian", "steps"]);
const WALKING_SPEED_METERS_PER_MINUTE = 78;

export function parseTreesCsv(csvText) {
  const rows = parseCsv(csvText);
  const header = rows[0] ?? [];

  for (const column of REQUIRED_COLUMNS) {
    if (!header.includes(column)) {
      throw new Error(`Tree CSV is missing required column: ${column}`);
    }
  }

  return rows.slice(1).filter(rowHasData).map((row, index) => {
    const record = Object.fromEntries(header.map((column, cellIndex) => [column, row[cellIndex] ?? ""]));
    const latitude = Number.parseFloat(record["Latitude"]);
    const longitude = Number.parseFloat(record["Longitude"]);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error(`Tree CSV has invalid coordinates on row ${index + 2}.`);
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

export function buildWalkwayGraph(geojson) {
  if (!geojson || geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    throw new Error("Pathway data is not a valid GeoJSON FeatureCollection.");
  }

  const nodes = new Map();
  const adjacency = new Map();
  const walkwayLines = [];
  let segmentCount = 0;

  for (const feature of geojson.features) {
    // Keep routing strictly on walkable OSM highway features.
    if (!isWalkwayFeature(feature)) {
      continue;
    }

    const geometry = feature.geometry;
    const lines = geometry.type === "LineString"
      ? [geometry.coordinates]
      : geometry.type === "MultiLineString"
        ? geometry.coordinates
        : [];

    for (const line of lines) {
      if (!Array.isArray(line) || line.length < 2) {
        continue;
      }

      const walkwayLine = [];

      for (let index = 0; index < line.length; index += 1) {
        const [lng, lat] = line[index] ?? [];

        if (![lng, lat].every(Number.isFinite)) {
          continue;
        }

        const node = registerNode(nodes, adjacency, lat, lng);
        walkwayLine.push([lat, lng]);

        if (index === 0) {
          continue;
        }

        const [prevLng, prevLat] = line[index - 1] ?? [];

        if (![prevLng, prevLat].every(Number.isFinite)) {
          continue;
        }

        const previousNode = registerNode(nodes, adjacency, prevLat, prevLng);
        const distance = haversineDistance(previousNode, node);

        adjacency.get(previousNode.id).push({ to: node.id, distance });
        adjacency.get(node.id).push({ to: previousNode.id, distance });
        segmentCount += 1;
      }

      if (walkwayLine.length > 1) {
        walkwayLines.push(walkwayLine);
      }
    }
  }

  if (!nodes.size || !segmentCount) {
    throw new Error("No OSM walkway features were found in the pathway GeoJSON.");
  }

  return {
    nodes,
    adjacency,
    componentIds: assignConnectedComponents(nodes, adjacency),
    nodeList: Array.from(nodes.values()),
    walkwayLines,
    segmentCount,
  };
}

export function attachTreeNodes(trees, graph) {
  return trees.map((tree) => {
    const nearest = findNearestGraphNode({ lat: tree.latitude, lng: tree.longitude }, graph);

    return {
      ...tree,
      componentId: graph.componentIds.get(nearest.id),
      nearestNodeId: nearest.id,
      offsetMeters: nearest.distance,
    };
  });
}

export function buildTour({ start, trees, graph }) {
  if (!start) {
    throw new Error("A start position is required before building the route.");
  }

  if (!trees.length) {
    throw new Error("No trees are available for routing.");
  }

  const startNode = findNearestGraphNode(start, graph);
  const unvisited = new Map(trees.map((tree) => [tree.id, tree]));
  const orderedStops = [];
  const coordinates = [];
  let currentNodeId = startNode.id;
  let totalDistanceMeters = startNode.distance;
  let directBridgeMeters = 0;

  pushUniqueCoordinate(coordinates, [start.lat, start.lng]);
  pushUniqueCoordinate(coordinates, [startNode.lat, startNode.lng]);

  while (unvisited.size) {
    // Use nearest-neighbour over network distance, not straight-line distance.
    const pathsFromCurrent = dijkstraAll(graph, currentNodeId);
    let nextTree = null;
    let nextDistance = Number.POSITIVE_INFINITY;
    let nextUsesBridge = false;

    for (const tree of unvisited.values()) {
      const networkDistance = pathsFromCurrent.distances.get(tree.nearestNodeId) ?? Number.POSITIVE_INFINITY;
      const targetNode = graph.nodes.get(tree.nearestNodeId);
      const currentNode = graph.nodes.get(currentNodeId);
      const usesBridge = !Number.isFinite(networkDistance);
      const travelDistance = usesBridge
        ? haversineDistance(currentNode, targetNode)
        : networkDistance;
      const totalCandidateDistance = travelDistance + tree.offsetMeters;

      if (totalCandidateDistance < nextDistance) {
        nextDistance = totalCandidateDistance;
        nextTree = tree;
        nextUsesBridge = usesBridge;
      }
    }

    if (!nextTree || !Number.isFinite(nextDistance)) {
      throw new Error("A route could not be built from the current data.");
    }

    const targetNode = graph.nodes.get(nextTree.nearestNodeId);

    if (nextUsesBridge) {
      // Some footway components are isolated, so bridge directly to the nearest target anchor.
      pushUniqueCoordinate(coordinates, [targetNode.lat, targetNode.lng]);
      directBridgeMeters += haversineDistance(graph.nodes.get(currentNodeId), targetNode);
    } else {
      const nodePath = rebuildPath(pathsFromCurrent.previous, currentNodeId, nextTree.nearestNodeId);

      for (const nodeId of nodePath) {
        const node = graph.nodes.get(nodeId);
        pushUniqueCoordinate(coordinates, [node.lat, node.lng]);
      }
    }

    pushUniqueCoordinate(coordinates, [nextTree.latitude, nextTree.longitude]);
    orderedStops.push(nextTree);
    totalDistanceMeters += nextDistance;
    currentNodeId = nextTree.nearestNodeId;
    unvisited.delete(nextTree.id);

    if (unvisited.size) {
      const anchor = graph.nodes.get(nextTree.nearestNodeId);
      pushUniqueCoordinate(coordinates, [anchor.lat, anchor.lng]);
      totalDistanceMeters += nextTree.offsetMeters;
    }
  }

  return {
    orderedStops,
    coordinates,
    totalDistanceMeters,
    directBridgeMeters,
    usedDirectBridge: directBridgeMeters > 0,
    estimatedMinutes: Math.max(1, Math.round(totalDistanceMeters / WALKING_SPEED_METERS_PER_MINUTE)),
    startNode,
  };
}

export function findNearestGraphNode(position, graph) {
  if (!graph?.nodeList?.length) {
    throw new Error("The walkway graph is empty.");
  }

  let nearest = null;

  for (const node of graph.nodeList) {
    const distance = haversineDistance(position, node);

    if (!nearest || distance < nearest.distance) {
      nearest = { ...node, distance };
    }
  }

  return nearest;
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

function isWalkwayFeature(feature) {
  const geometryType = feature?.geometry?.type;
  const highway = String(feature?.properties?.highway ?? "").trim().toLowerCase();

  return (
    (geometryType === "LineString" || geometryType === "MultiLineString") &&
    WALKWAY_HIGHWAYS.has(highway)
  );
}

function registerNode(nodes, adjacency, lat, lng) {
  const id = coordinateKey(lat, lng);

  if (!nodes.has(id)) {
    nodes.set(id, { id, lat, lng });
    adjacency.set(id, []);
  }

  return nodes.get(id);
}

function assignConnectedComponents(nodes, adjacency) {
  const componentIds = new Map();
  let componentId = 0;

  for (const nodeId of nodes.keys()) {
    if (componentIds.has(nodeId)) {
      continue;
    }

    const queue = [nodeId];
    componentIds.set(nodeId, componentId);

    while (queue.length) {
      const current = queue.shift();

      for (const edge of adjacency.get(current) ?? []) {
        if (!componentIds.has(edge.to)) {
          componentIds.set(edge.to, componentId);
          queue.push(edge.to);
        }
      }
    }

    componentId += 1;
  }

  return componentIds;
}

function dijkstraAll(graph, startId) {
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

  return { distances, previous };
}

function rebuildPath(previous, startId, endId) {
  const path = [];
  let currentId = endId;

  while (currentId) {
    path.unshift(currentId);

    if (currentId === startId) {
      return path;
    }

    currentId = previous.get(currentId);
  }

  return [];
}

function pushUniqueCoordinate(coordinates, coordinate) {
  const last = coordinates[coordinates.length - 1];

  if (!last || last[0] !== coordinate[0] || last[1] !== coordinate[1]) {
    coordinates.push(coordinate);
  }
}

function parseCsv(csvText) {
  const rows = [];
  let row = [];
  let cell = "";
  let insideQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const character = csvText[index];
    const nextCharacter = csvText[index + 1];

    if (character === '"') {
      if (insideQuotes && nextCharacter === '"') {
        cell += '"';
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
      continue;
    }

    if (character === "," && !insideQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((character === "\n" || character === "\r") && !insideQuotes) {
      if (character === "\r" && nextCharacter === "\n") {
        index += 1;
      }

      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += character;
  }

  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function rowHasData(row) {
  return row.some((cell) => cell.trim().length > 0);
}

function coordinateKey(lat, lng) {
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
    const tail = this.items.pop();

    if (this.items.length && tail) {
      this.items[0] = tail;
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
