/* Leaflet map layer: facility markers, city markers, radius circle. */
(function (global) {
  "use strict";

  var map = null;
  var facilityLayer = null;
  var cityLayer = null;
  var radiusCircle = null;
  var markersByKey = {};
  var activeHighlight = null;

  function initMap(elementId) {
    map = L.map(elementId, {
      center: [52.0693, 19.4803], // center of Poland
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
    return map;
  }

  function clear() {
    if (facilityLayer) facilityLayer.clearLayers();
    if (cityLayer) cityLayer.clearLayers();
    markersByKey = {};
    activeHighlight = null;
    clearRadius();
  }

  function clearRadius() {
    if (radiusCircle) {
      map.removeLayer(radiusCircle);
      radiusCircle = null;
    }
  }

  /* Unique key per facility for marker lookup */
  function markerKey(f) {
    if (f.rspo && f.rspo.trim()) return "rspo:" + f.rspo.trim();
    return "n:" + (f.nazwa || "") + "@" + f.lat + "," + f.lon;
  }

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

  function cityIcon(rank) {
    var label = rank != null ? String(rank) : "";
    return L.divIcon({
      className: "city-marker",
      html:
        '<div style="background:#d97706;color:#fff;font-weight:700;font-size:11px;width:24px;height:24px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;">' +
        label +
        "</div>",
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
  }

  /* Apply small angular jitter to facilities sharing identical coordinates.
   * Returns array of {orig, lat, lon} with adjusted positions for display. */
  function applyJitter(facilities) {
    var coordCount = {};
    facilities.forEach(function (f) {
      if (f.lat == null || f.lon == null) return;
      var k = f.lat.toFixed(5) + "," + f.lon.toFixed(5);
      coordCount[k] = (coordCount[k] || 0) + 1;
    });
    var coordIdx = {};
    return facilities.map(function (f) {
      if (f.lat == null || f.lon == null) return { orig: f, lat: f.lat, lon: f.lon };
      var k = f.lat.toFixed(5) + "," + f.lon.toFixed(5);
      var count = coordCount[k];
      if (count <= 1) return { orig: f, lat: f.lat, lon: f.lon };
      var idx = coordIdx[k] || 0;
      coordIdx[k] = idx + 1;
      var angle = (2 * Math.PI * idx) / count;
      var r = 0.00028; /* ~25–30 m spread */
      return {
        orig: f,
        lat: f.lat + r * Math.cos(angle),
        lon: f.lon + r * Math.sin(angle),
      };
    });
  }

  function plotFacilities(facilities) {
    facilityLayer.clearLayers();
    markersByKey = {};
    activeHighlight = null;

    var jittered = applyJitter(facilities);
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
    fitToFacilities(facilities);
  }

  /* Highlight the marker for a facility (enlarge icon, open popup, bring to front).
   * Returns the marker entry {marker, lat, lon} so the caller can focus the map. */
  function highlightMarker(key) {
    /* Restore previous highlight */
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

  function fitToFacilities(facilities) {
    if (!map || !facilities || facilities.length === 0) return;
    var bounds = [];
    facilities.forEach(function (f) {
      if (f && f.lat != null && f.lon != null) {
        bounds.push([f.lat, f.lon]);
      }
    });
    if (bounds.length > 0) map.fitBounds(bounds, { padding: [30, 30] });
  }

  function plotCityCenters(cities, onClick) {
    cityLayer.clearLayers();
    cities.forEach(function (city, idx) {
      /* zIndexOffset: -100 keeps city discs below facility dots */
      var marker = L.marker([city.center.lat, city.center.lon], {
        icon: cityIcon(idx + 1),
        zIndexOffset: -100,
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
        if (typeof onClick === "function") {
          onClick(city);
        }
      });
      marker.addTo(cityLayer);
    });
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
    if (map) {
      map.setView([lat, lon], zoom || 12, { animate: true });
    }
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
