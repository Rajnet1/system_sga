/* Leaflet map layer: facility markers, city markers, radius circle. */
(function (global) {
  "use strict";

  var map = null;
  var facilityLayer = null;
  var cityLayer = null;
  var radiusCircle = null;
  var markersByKey = {};
  var activeHighlight = null;
  var storedFacilities = []; /* kept to re-jitter on zoom changes */

  function initMap(elementId) {
    map = L.map(elementId, {
      center: [52.0693, 19.4803],
      zoom: 6,
      zoomControl: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    facilityLayer = L.layerGroup().addTo(map);
    cityLayer = L.layerGroup().addTo(map);

    /* Re-jitter whenever zoom changes so pixel spread stays constant */
    map.on("zoomend", function () {
      if (storedFacilities.length > 0) rerenderFacilities(storedFacilities);
    });

    return map;
  }

  function clear() {
    if (facilityLayer) facilityLayer.clearLayers();
    if (cityLayer) cityLayer.clearLayers();
    markersByKey = {};
    activeHighlight = null;
    storedFacilities = [];
    clearRadius();
  }

  function clearRadius() {
    if (radiusCircle) {
      map.removeLayer(radiusCircle);
      radiusCircle = null;
    }
  }

  /* Unique key per facility — used for marker lookup from the sidebar list */
  function markerKey(f) {
    if (f.rspo && f.rspo.trim()) return "rspo:" + f.rspo.trim();
    return "n:" + (f.nazwa || "") + "@" + f.lat + "," + f.lon;
  }

  /* -----------------------------------------------------------------------
   * Icons
   * --------------------------------------------------------------------- */

  function facilityIcon(typ) {
    if (typ === "DK") {
      return L.divIcon({
        className: "facility-marker",
        html: '<div style="color:#d97706;font-size:20px;font-weight:bold;text-shadow:0 0 3px rgba(255,255,255,0.9),0 0 6px rgba(0,0,0,0.4);">★</div>',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
    }
    var color = typ === "SP" ? "#1565c0" : "#2e7d32";
    return L.divIcon({
      className: "facility-marker",
      html:
        '<div style="background:' + color +
        ';width:16px;height:16px;border-radius:50%;border:2.5px solid #fff;box-shadow:0 0 4px rgba(0,0,0,0.6),0 0 1px rgba(0,0,0,0.3);"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });
  }

  function facilityIconHighlighted(typ) {
    if (typ === "DK") {
      return L.divIcon({
        className: "facility-marker",
        html: '<div style="color:#d97706;font-size:30px;font-weight:bold;text-shadow:0 0 5px rgba(255,255,255,1),0 0 10px rgba(0,0,0,0.5);">★</div>',
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      });
    }
    var color = typ === "SP" ? "#1565c0" : "#2e7d32";
    return L.divIcon({
      className: "facility-marker",
      html:
        '<div style="background:' + color +
        ';width:24px;height:24px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 8px rgba(0,0,0,0.75),0 0 2px rgba(0,0,0,0.4);"></div>',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
  }

  /* Callout balloon with downward arrow.
   * iconAnchor is at the arrow tip so the box floats above the coordinate
   * and doesn't cover facility dots sitting at the same point. */
  function cityIcon(rank) {
    var label = rank != null ? String(rank) : "";
    return L.divIcon({
      className: "city-marker",
      html:
        '<div style="width:34px;display:flex;flex-direction:column;align-items:center;">' +
          '<div style="background:#d97706;color:#fff;font-weight:700;font-size:12px;' +
               'height:24px;width:34px;border-radius:5px;' +
               'box-shadow:0 2px 6px rgba(0,0,0,0.45);' +
               'display:flex;align-items:center;justify-content:center;">' +
            label +
          '</div>' +
          '<div style="width:0;height:0;' +
               'border-left:6px solid transparent;' +
               'border-right:6px solid transparent;' +
               'border-top:8px solid #d97706;"></div>' +
        '</div>',
      iconSize: [34, 32],
      iconAnchor: [17, 32], /* tip of the downward arrow */
    });
  }

  /* -----------------------------------------------------------------------
   * Zoom-responsive jitter
   *
   * Groups of facilities sharing the same rounded lat/lon get spread out
   * so they don't overlap regardless of zoom. Small groups use a ring;
   * large groups (e.g. dozens of facilities snapped to one place_center
   * fallback) use a phyllotactic spiral so the outer radius grows like
   * sqrt(count) instead of count, keeping the cluster compact.
   * --------------------------------------------------------------------- */
  function metersPerPixel(zoom) {
    /* Web Mercator: meters/px at latitude ~51°N (central Poland) */
    return (40075016.686 * Math.cos(51.0 * Math.PI / 180)) / Math.pow(2, zoom + 8);
  }

  var GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

  function applyJitter(facilities, zoom) {
    var coordCount = {};
    facilities.forEach(function (f) {
      if (f.lat == null || f.lon == null) return;
      var k = f.lat.toFixed(5) + "," + f.lon.toFixed(5);
      coordCount[k] = (coordCount[k] || 0) + 1;
    });

    var coordIdx = {};
    var mpp = metersPerPixel(zoom);

    return facilities.map(function (f) {
      if (f.lat == null || f.lon == null) return { orig: f, lat: f.lat, lon: f.lon };
      var k = f.lat.toFixed(5) + "," + f.lon.toFixed(5);
      var count = coordCount[k];
      if (count <= 1) return { orig: f, lat: f.lat, lon: f.lon };

      var idx = coordIdx[k] || 0;
      coordIdx[k] = idx + 1;

      var radiusPx, angle;
      if (count <= 8) {
        /* Ring: ~20 px between adjacent dot centres */
        radiusPx = Math.max(14, (20 * count) / (2 * Math.PI));
        angle = (2 * Math.PI * idx) / count;
      } else {
        /* Phyllotactic spiral: r grows like sqrt(idx), outer radius stays
         * compact even for ~100 co-located facilities (~70 px instead of
         * ~315 px from the linear ring formula). */
        radiusPx = 7 * Math.sqrt(idx + 1);
        angle = idx * GOLDEN_ANGLE;
      }

      var radiusMeters = radiusPx * mpp;
      var radiusDeg = radiusMeters / 111319.9;
      return {
        orig: f,
        lat: f.lat + radiusDeg * Math.cos(angle),
        lon: f.lon + radiusDeg * Math.sin(angle),
      };
    });
  }

  /* -----------------------------------------------------------------------
   * Rendering facilities
   * --------------------------------------------------------------------- */

  function rerenderFacilities(facilities) {
    facilityLayer.clearLayers();
    markersByKey = {};
    activeHighlight = null;

    var zoom = map ? map.getZoom() : 12;
    var jittered = applyJitter(facilities, zoom);

    jittered.forEach(function (item) {
      var f = item.orig;
      if (item.lat == null || item.lon == null) return;

      var marker = L.marker([item.lat, item.lon], { icon: facilityIcon(f.typ) });
      var key = markerKey(f);
      markersByKey[key] = { marker: marker, typ: f.typ, lat: item.lat, lon: item.lon };

      var typLabel = f.typ === "SP" ? "Szkoła podstawowa" : f.typ === "PRZ" ? "Przedszkole" : "Dom / Ośrodek Kultury";
      var approxNote =
        f.coords_source === "place_center"
          ? '<br/><span style="color:#b45309;font-size:11px;">Lokalizacja przyblizona (srodek miejscowosci)</span>'
          : "";
      var uczniowieNote = (f.typ !== "DK" && f.uczniowie && f.uczniowie > 0)
        ? '<br/><span style="color:#1565c0;font-size:11px;">' + f.uczniowie + " uczniów</span>"
        : "";
      marker.bindPopup(
        "<strong>" + escapeHtml(f.nazwa) + "</strong><br/>" +
        '<em style="color:#52606d;">' + typLabel + "</em><br/>" +
        escapeHtml(f.adres || f.miejscowosc || "") +
        uczniowieNote +
        approxNote
      );
      marker.addTo(facilityLayer);
    });
  }

  function plotFacilities(facilities) {
    storedFacilities = facilities.slice();
    rerenderFacilities(facilities);
    fitToFacilities(facilities);
  }

  /* Enlarge the marker for a given facility key, pan map to it.
   * Returns the marker entry so the caller gets the (jittered) lat/lon. */
  function highlightMarker(key) {
    if (activeHighlight) {
      activeHighlight.marker.setIcon(facilityIcon(activeHighlight.typ));
      activeHighlight.marker.setZIndexOffset(0);
      activeHighlight = null;
    }
    var entry = markersByKey[key];
    if (!entry) return null;
    entry.marker.setIcon(facilityIconHighlighted(entry.typ));
    entry.marker.setZIndexOffset(1000);
    entry.marker.openPopup();
    activeHighlight = entry;
    return entry;
  }

  /* -----------------------------------------------------------------------
   * City centres
   * --------------------------------------------------------------------- */

  function plotCityCenters(cities, onClick) {
    cityLayer.clearLayers();
    cities.forEach(function (city, idx) {
      var marker = L.marker([city.center.lat, city.center.lon], {
        icon: cityIcon(idx + 1),
        zIndexOffset: 0,
      });
      marker.bindTooltip(
        city.name +
          " - " +
          city.total +
          " placowek (" +
          city.sp +
          " SP + " +
          city.prz +
          " PRZ" +
          (city.dk > 0 ? " + " + city.dk + " DK" : "") +
          ")",
        { direction: "top" }
      );
      marker.on("click", function () {
        if (typeof onClick === "function") onClick(city);
      });
      marker.addTo(cityLayer);
    });
  }

  /* -----------------------------------------------------------------------
   * Misc
   * --------------------------------------------------------------------- */

  function fitToFacilities(facilities) {
    if (!map || !facilities || facilities.length === 0) return;
    var bounds = [];
    facilities.forEach(function (f) {
      if (f && f.lat != null && f.lon != null) bounds.push([f.lat, f.lon]);
    });
    if (bounds.length > 0) map.fitBounds(bounds, { padding: [30, 30] });
  }

  function drawRadius(center, radiusKm) {
    clearRadius();
    radiusCircle = L.circle([center.lat, center.lon], {
      radius: radiusKm * 1000,
      color: "#d97706",
      weight: 2,
      fillColor: "#fbbf24",
      fillOpacity: 0.12,
    }).addTo(map);
  }

  function focusOn(lat, lon, zoom) {
    if (map) map.setView([lat, lon], zoom || 12, { animate: true });
  }

  function escapeHtml(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  global.MapLayer = {
    initMap: initMap,
    clear: clear,
    plotFacilities: plotFacilities,
    fitToFacilities: fitToFacilities,
    plotCityCenters: plotCityCenters,
    clearRadius: clearRadius,
    drawRadius: drawRadius,
    focusOn: focusOn,
    highlightMarker: highlightMarker,
    markerKey: markerKey,
  };
})(window);
