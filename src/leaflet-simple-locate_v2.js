/**
 * Leaflet SimpleLocate v2 - A lightweight geolocation control for Leaflet
 * Provides user location tracking with customizable styling and events
 */

(function(global, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('leaflet'));
    } else if (typeof define === 'function' && define.amd) {
        define(['leaflet'], factory);
    } else {
        global.SimpleLocate = factory(global.L);
    }
}(typeof self !== 'undefined' ? self : this, function(L) {
    'use strict';

    const SimpleLocate = L.Control.extend({
        options: {
            position: 'topright',
            className: 'button-locate',
            drawCircle: true,
            circleRadius: 8,
            circleColor: '#3b82f6',
            circleWeight: 2.5,
            circleFill: true,
            circleFillColor: '#3b82f6',
            circleFillOpacity: 1,
            zIndexOffset: 1000,
            highAccuracy: true,
            timeout: 15000,
            maximumAge: 5000,
            geofenceRadius: 2000, // 2km geofence
            geofenceCenter: null,  // [lat, lng]
            onLocationFound: null,
            onLocationError: null,
            onGeofenceViolation: null
        },

        initialize: function(options) {
            L.Util.setOptions(this, options);
            this.tracking = false;
            this.userMarker = null;
            this.watchId = null;
            this.userLocation = null;
        },

        onAdd: function(map) {
            this.map = map;
            this._createButton();
            return this._container;
        },

        onRemove: function() {
            this._stopTracking();
        },

        _createButton: function() {
            this._container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
            this._button = L.DomUtil.create('button', this.options.className, this._container);
            this._button.innerHTML = '<i class="bi bi-crosshair"></i>';
            this._button.title = 'Track my location';
            this._button.setAttribute('aria-label', 'Track my location');
            
            // Add status light indicator
            this._statusLight = L.DomUtil.create('span', 'gps-status-light', this._button);
            
            L.DomEvent.on(this._button, 'click', this._toggle, this);
            L.DomEvent.disableClickPropagation(this._button);
            
            return this._container;
        },

        _toggle: function() {
            if (this.tracking) {
                this._stopTracking();
            } else {
                this._startTracking();
            }
        },

        _startTracking: function() {
            if (!navigator.geolocation) {
                this._handleError({ message: 'Geolocation not supported.' });
                return;
            }

            this.tracking = true;
            this._updateButtonState('locating');

            this.watchId = navigator.geolocation.watchPosition(
                (position) => this._onLocationFound(position),
                (error) => this._onLocationError(error),
                {
                    enableHighAccuracy: this.options.highAccuracy,
                    timeout: this.options.timeout,
                    maximumAge: this.options.maximumAge
                }
            );
        },

        _stopTracking: function() {
            this.tracking = false;
            this._updateButtonState('off');
            this.userLocation = null;

            if (this.watchId !== null) {
                navigator.geolocation.clearWatch(this.watchId);
                this.watchId = null;
            }

            if (this.userMarker) {
                this.map.removeLayer(this.userMarker);
                this.userMarker = null;
            }

            if (typeof this.options.onLocationError === 'function') {
                this.options.onLocationError({ type: 'stopped' });
            }
        },

        _onLocationFound: function(position) {
            this.userLocation = {
                lat: position.coords.latitude,
                lng: position.coords.longitude,
                accuracy: position.coords.accuracy
            };

            // Check geofence
            if (this.options.geofenceCenter && this.options.geofenceRadius) {
                const distance = this._getDistance(
                    this.userLocation.lat, 
                    this.userLocation.lng,
                    this.options.geofenceCenter[0],
                    this.options.geofenceCenter[1]
                );

                if (distance > this.options.geofenceRadius) {
                    if (typeof this.options.onGeofenceViolation === 'function') {
                        this.options.onGeofenceViolation({
                            distance: distance,
                            limit: this.options.geofenceRadius,
                            location: this.userLocation
                        });
                    }
                    return;
                }
            }

            this._updateButtonState('active');
            this._updateUserMarker();

            if (typeof this.options.onLocationFound === 'function') {
                this.options.onLocationFound(this.userLocation);
            }
        },

        _onLocationError: function(error) {
            this.tracking = false;
            this._updateButtonState('off');
            this.userLocation = null;

            if (this.userMarker) {
                this.map.removeLayer(this.userMarker);
                this.userMarker = null;
            }

            if (typeof this.options.onLocationError === 'function') {
                this.options.onLocationError(error);
            }

            if (this.watchId !== null) {
                navigator.geolocation.clearWatch(this.watchId);
                this.watchId = null;
            }
        },

        _updateUserMarker: function() {
            if (!this.userLocation) return;

            if (!this.userMarker && this.options.drawCircle) {
                this.userMarker = L.circleMarker(
                    [this.userLocation.lat, this.userLocation.lng],
                    {
                        radius: this.options.circleRadius,
                        color: this.options.circleColor,
                        weight: this.options.circleWeight,
                        fillColor: this.options.circleFillColor,
                        fillOpacity: this.options.circleFillOpacity,
                        zIndexOffset: this.options.zIndexOffset
                    }
                ).addTo(this.map);
            } else if (this.userMarker) {
                this.userMarker.setLatLng([this.userLocation.lat, this.userLocation.lng]);
            }
        },

        _updateButtonState: function(state) {
            this._button.classList.remove('active', 'locating', 'gps-active');
            
            if (state === 'locating') {
                this._button.classList.add('locating');
            } else if (state === 'active') {
                this._button.classList.add('gps-active');
            }
        },

        _getDistance: function(lat1, lon1, lat2, lon2) {
            const DEG = Math.PI / 180;
            const p1 = lat1 * DEG, p2 = lat2 * DEG;
            const dp = (lat2 - lat1) * DEG, dl = (lon2 - lon1) * DEG;
            const a = Math.sin(dp/2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl/2) ** 2;
            return 6371e3 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        },

        // Public methods
        isTracking: function() {
            return this.tracking;
        },

        getLocation: function() {
            return this.userLocation;
        },

        setGeofenceCenter: function(latlng) {
            this.options.geofenceCenter = [latlng.lat || latlng[0], latlng.lng || latlng[1]];
        },

        stop: function() {
            this._stopTracking();
        }
    });

    return SimpleLocate;
}));
