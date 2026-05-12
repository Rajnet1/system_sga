/* Leaflet map layer: facility markers, city markers, radius circle. */
(function (global) {
  "use strict";

  var map = null;
  var facilityLayer = null;
  var cityLayer = null;
  var radiusCircle = null;

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
    clearRadius();
  }

  function clearRadius() {
    if (radiusCircle) {
      map.removeLayer(radiusCircle);
      radiusCircle = null;
    }
  }

  function facilityIcon(typ) {
    if (typ === "DK") {
      /* Community centre - star icon */
      return L.divIcon({
        className: "facility-marker",
        html:
          '<div style="color:#d97706;font-size:16px;font-weight:bold;text-shadow:0 0 2px rgba(255,255,255,0.8),0 0 4px rgba(0,0,0,0.3);">★</div>',
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
    }
    var color = typ === "SP" ? "#1565c0" : "#2e7d32";
    return L.divIcon({
      className: "facility-marker",
      html:
        '<div style="background:' +
        color +
        ';width:12px;height:12px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 2px rgba(0,0,0,0.5);"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
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

  function plotFacilities(facilities) {
    facilityLayer.clearLayers();
    facilities.forEach(function (f) {
      /* Skip facilities without coordinates */
      if (f.lat == null || f.lon == null) return;

      var marker = L.marker([f.lat, f.lon], { icon: facilityIcon(f.typ) });
      var typLabel = f.typ === "SP" ? "Szkoła podstawowa" : f.typ === "PRZ" ? "Przedszkole" : "Dom / Ośrodek Kultury";
      var approxNote =
        f.coords_source === "place_center"
          ? '<br/><span style="color:#b45309;font-size:11px;">Lokalizacja przyblizona (srodek miejscowosci)</span>'
          : "";
      var uczniowieNote = (f.typ !== "DK" && f.uczniowie && f.uczniowie > 0)
        ? '<br/><span style="color:#1565c0;font-size:11px;">' + f.uczniowie + ' uczniów</span>'
        : "";
      marker.bindPopup(
        '<strong>' +
          escapeHtml(f.nazwa) +
          "</strong><br/>" +
          '<em style="color:#52606d;">' +
          typLabel +
          "</em><br/>" +
          escapeHtml(f.adres || f.miejscowosc || "") +
          uczniowieNote +
          approxNote
      );
      marker.addTo(facilityLayer);
    });
    fitToFacilities(facilities);
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
      var marker = L.marker([city.center.lat, city.center.lon], {
        icon: cityIcon(idx + 1),
        zIndexOffset: 500,
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
  };
})(window);
