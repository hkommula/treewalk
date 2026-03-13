class OsrmRoutingClient {
  constructor({ baseUrl = 'https://router.project-osrm.org', profile = 'foot' } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.profile = profile;
  }

  buildCoordinates(points) {
    return points.map(point => `${point.lng},${point.lat}`).join(';');
  }

  async request(path) {
    const response = await fetch(`${this.baseUrl}${path}`);
    if (!response.ok) throw new Error(`OSRM request failed: ${response.status}`);

    const data = await response.json();
    if (data.code !== 'Ok') throw new Error(`OSRM error: ${data.code}`);
    return data;
  }

  async getDistanceMatrix(points) {
    const coords = this.buildCoordinates(points);
    const data = await this.request(`/table/v1/${this.profile}/${coords}?annotations=distance`);
    return data.distances;
  }

  async getWalkingRoute(points) {
    const coords = this.buildCoordinates(points);
    const data = await this.request(`/route/v1/${this.profile}/${coords}?overview=full&geometries=geojson&steps=false`);
    return data.routes[0] || null;
  }
}

window.OsrmRoutingClient = OsrmRoutingClient;
