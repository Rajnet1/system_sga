/* Geo utilities: haversine distance and centroid of a point cloud. */
(function (global) {
  "use strict";

  var EARTH_RADIUS_KM = 6371;

  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }

  /**
   * Great-circle distance between two (lat, lon) pairs in kilometers.
   */
  function haversineKm(lat1, lon1, lat2, lon2) {
    var dLat = toRad(lat2 - lat1);
    var dLon = toRad(lon2 - lon1);
    var a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_KM * c;
  }

  /**
   * Simple arithmetic mean of lat/lon. Good enough for facility clusters at
   * the scale of a single Polish powiat (tens of km across).
   */
  function centroid(points) {
    if (!points || points.length === 0) {
      return null;
    }
    var latSum = 0;
    var lonSum = 0;
    for (var i = 0; i < points.length; i++) {
      latSum += points[i].lat;
      lonSum += points[i].lon;
    }
    return {
      lat: latSum / points.length,
      lon: lonSum / points.length,
    };
  }

  global.Geo = {
    haversineKm: haversineKm,
    centroid: centroid,
  };
})(window);
