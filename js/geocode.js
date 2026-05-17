/* Photon geocoder (https://photon.komoot.io/) — CORS-friendly, no API key.
 * Used to resolve facility addresses (street + number + city) to lat/lon
 * when the source CSV doesn't carry coordinates and the name didn't match
 * anything in OSM.
 *
 * Results are cached in localStorage. Negative results (address not found)
 * are also cached so we don't re-hit Photon every search.
 */
(function (global) {
  "use strict";

  var PHOTON_URL = "https://photon.komoot.io/api/";
  var CACHE_PREFIX = "photon_geocode_v1_";
  var CACHE_TTL = 30 * 86400 * 1000; /* 30 days */
  var FETCH_TIMEOUT_MS = 8000;
  /* Photon allows generous use but we keep concurrent requests modest to
   * stay polite and avoid timeouts. */
  var DEFAULT_CONCURRENCY = 4;

  function normalize(addr) {
    return (addr || "")
      .toLowerCase()
      .replace(/ą/g, "a").replace(/ć/g, "c").replace(/ę/g, "e")
      .replace(/ł/g, "l").replace(/ń/g, "n").replace(/ó/g, "o")
      .replace(/ś/g, "s").replace(/ź/g, "z").replace(/ż/g, "z")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function cacheKey(addr) {
    return CACHE_PREFIX + normalize(addr);
  }

  function cacheGet(addr) {
    try {
      var raw = localStorage.getItem(cacheKey(addr));
      if (!raw) return undefined;
      var obj = JSON.parse(raw);
      if (Date.now() - (obj.ts || 0) > CACHE_TTL) return undefined;
      return obj.data; /* may be null for negative-cached "not found" */
    } catch (e) {
      return undefined;
    }
  }

  function cacheSet(addr, data) {
    try {
      localStorage.setItem(cacheKey(addr), JSON.stringify({ ts: Date.now(), data: data }));
    } catch (e) { /* localStorage full — ignore */ }
  }

  function fetchWithTimeout(url, ms) {
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = null;
    var p = fetch(url, { signal: controller ? controller.signal : undefined });
    if (controller) {
      timer = setTimeout(function () { controller.abort(); }, ms);
      p = p.finally(function () { clearTimeout(timer); });
    }
    return p;
  }

  /**
   * Geocode one address. Returns Promise<{lat, lon} | null>.
   * bias: optional {lat, lon} to bias the search around (e.g. powiat centre).
   * bounds: optional {minlat, minlon, maxlat, maxlon} — results outside are rejected.
   */
  function geocodeOne(address, bias, bounds) {
    if (!address || !address.trim()) return Promise.resolve(null);
    var cached = cacheGet(address);
    if (cached !== undefined) return Promise.resolve(cached);

    var params = [
      "q=" + encodeURIComponent(address),
      "limit=1",
    ];
    /* Note: lang= only accepts en/fr/de/it — `pl` yields HTTP 400.
     * The default returns names in their native language anyway, so
     * Polish results come back in Polish. */
    if (bias && typeof bias.lat === "number" && typeof bias.lon === "number") {
      params.push("lat=" + bias.lat.toFixed(5));
      params.push("lon=" + bias.lon.toFixed(5));
    }
    var url = PHOTON_URL + "?" + params.join("&");

    return fetchWithTimeout(url, FETCH_TIMEOUT_MS)
      .then(function (r) {
        if (!r.ok) throw new Error("Photon HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        var feature = data && data.features && data.features[0];
        var coords = feature && feature.geometry && feature.geometry.coordinates;
        if (!coords || coords.length < 2) {
          cacheSet(address, null);
          return null;
        }
        var lat = coords[1];
        var lon = coords[0];
        if (typeof lat !== "number" || typeof lon !== "number") {
          cacheSet(address, null);
          return null;
        }
        if (bounds && !insideBounds(lat, lon, bounds)) {
          /* Photon returned something outside the powiat — treat as miss. */
          cacheSet(address, null);
          return null;
        }
        var result = {
          lat: Math.round(lat * 1e6) / 1e6,
          lon: Math.round(lon * 1e6) / 1e6,
        };
        cacheSet(address, result);
        return result;
      })
      .catch(function (err) {
        /* Don't cache transient errors — try again next time. */
        var msg = (err && err.message) || String(err);
        if (typeof Log !== "undefined") Log.warn("Photon geocode '" + address + "' nieudany: " + msg);
        return null;
      });
  }

  function insideBounds(lat, lon, b) {
    return lat >= b.minlat && lat <= b.maxlat && lon >= b.minlon && lon <= b.maxlon;
  }

  /**
   * Geocode many addresses with a bounded concurrency pool.
   * onProgress(done, total) is called after each completion.
   * Returns Promise<Array<{lat,lon}|null>> in the same order as input.
   */
  function geocodeMany(addresses, opts) {
    opts = opts || {};
    var concurrency = opts.concurrency || DEFAULT_CONCURRENCY;
    var bias = opts.bias || null;
    var bounds = opts.bounds || null;
    var onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;

    var results = new Array(addresses.length);
    var next = 0;
    var completed = 0;

    return new Promise(function (resolve) {
      if (addresses.length === 0) { resolve(results); return; }
      var inFlight = 0;

      function launch() {
        while (inFlight < concurrency && next < addresses.length) {
          var idx = next++;
          inFlight++;
          geocodeOne(addresses[idx], bias, bounds).then(function (boundIdx) {
            return function (r) {
              results[boundIdx] = r;
              inFlight--;
              completed++;
              if (onProgress) onProgress(completed, addresses.length);
              if (completed === addresses.length) resolve(results);
              else launch();
            };
          }(idx));
        }
      }
      launch();
    });
  }

  global.Geocoder = {
    geocodeOne: geocodeOne,
    geocodeMany: geocodeMany,
  };
})(window);
