/* Overpass API integration: Polish powiats list + school/kindergarten fetching.
 * Results are cached in localStorage to avoid repeated queries.
 * Uses multiple Overpass endpoints with automatic fallback and retry.
 */
(function (global) {
  "use strict";

  /* Bounding box roughly covering Poland (lat 49.0-55.0, lon 14.1-24.2) */
  var PL_BBOX = "49.0,14.1,55.0,24.2";

  /* Endpoints tried in order on failure. All are public Overpass mirrors. */
  var ENDPOINTS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.openstreetmap.ru/cgi/interpreter",
  ];

  /* Fetch timeout per endpoint attempt (ms) */
  var FETCH_TIMEOUT_MS = 60000;

  /* Cache keys and TTLs */
  var KEY_LIST = "overpass_powiaty_list_v3";
  var TTL_LIST = 7 * 86400 * 1000;   /* 7 days  */
  var PREFIX_FAC = "overpass_fac_v3_";
  var TTL_FAC = 24 * 3600 * 1000;    /* 24 hours */

  /* -----------------------------------------------------------------------
   * Public helpers
   * --------------------------------------------------------------------- */

  /** Normalize a powiat name to a stable lowercase search key. */
  function powiatKey(name) {
    return (name || "")
      .replace(/^powiat\s+/i, "")
      .replace(/^miasto\s+/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /* -----------------------------------------------------------------------
   * HTTP layer: tries each endpoint in sequence
   * --------------------------------------------------------------------- */

  /**
   * POST the Overpass QL query to the first endpoint that responds within
   * FETCH_TIMEOUT_MS. Tries each endpoint sequentially on network error or
   * 5xx. Rejects only when ALL endpoints fail.
   */
  function overpassQuery(ql) {
    return tryEndpoints(ENDPOINTS.slice(), ql);
  }

  function tryEndpoints(queue, ql) {
    if (queue.length === 0) {
      return Promise.reject(new Error(
        "Wszystkie serwery Overpass niedostepne. " +
        "Sprobuj za chwile lub skorzystaj z opcji 'wklej CSV'."
      ));
    }
    var endpoint = queue.shift();
    return fetchWithTimeout(endpoint, ql, FETCH_TIMEOUT_MS)
      .then(function (r) {
        if (r.status === 429 || r.status >= 500) {
          /* Server-side error — try next mirror */
          console.warn("Overpass " + r.status + " from " + endpoint + ", trying next...");
          return tryEndpoints(queue, ql);
        }
        if (!r.ok) {
          return Promise.reject(new Error("Overpass HTTP " + r.status));
        }
        return r.json();
      })
      .catch(function (err) {
        /* Network error / timeout — try next mirror */
        if (queue.length > 0) {
          console.warn("Overpass error from " + endpoint + " (" + err.message + "), trying next...");
          return tryEndpoints(queue, ql);
        }
        return Promise.reject(err);
      });
  }

  function fetchWithTimeout(endpoint, ql, ms) {
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = null;
    var fetchPromise = fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(ql),
      signal: controller ? controller.signal : undefined,
    });
    if (controller) {
      timer = setTimeout(function () { controller.abort(); }, ms);
      fetchPromise = fetchPromise.finally(function () { clearTimeout(timer); });
    }
    return fetchPromise;
  }

  /* -----------------------------------------------------------------------
   * localStorage cache
   * --------------------------------------------------------------------- */

  function cacheGet(key, ttl) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (Date.now() - (obj.ts || 0) > ttl) return null;
      return obj.data;
    } catch (e) {
      return null;
    }
  }

  function cacheSet(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data: data }));
    } catch (e) {
      /* localStorage full — ignore */
    }
  }

  /* -----------------------------------------------------------------------
   * Public API
   * --------------------------------------------------------------------- */

  /**
   * Load the list of all Polish powiats from Overpass (cached 7 days).
   * callback(err, [{name, key}])
   */
  function loadPowiatList(callback) {
    var cached = cacheGet(KEY_LIST, TTL_LIST);
    if (cached) { callback(null, cached); return; }

    var ql =
      "[out:json][timeout:55][bbox:" + PL_BBOX + "];" +
      'relation["boundary"="administrative"]["admin_level"="6"];' +
      "out tags;";

    overpassQuery(ql)
      .then(function (data) {
        var list = data.elements
          .filter(function (e) { return e.tags && e.tags.name; })
          .map(function (e) { return { name: e.tags.name, key: powiatKey(e.tags.name) }; })
          .filter(function (item, idx, arr) {
            return arr.findIndex(function (x) { return x.key === item.key; }) === idx;
          })
          .sort(function (a, b) { return a.key.localeCompare(b.key, "pl"); });

        cacheSet(KEY_LIST, list);
        callback(null, list);
      })
      .catch(function (err) { callback(err, null); });
  }

  /**
   * Fetch all primary schools + kindergartens in a powiat (cached 24h).
   * callback(err, [facility...])
   */
  function fetchFacilities(key, callback) {
    var cached = cacheGet(PREFIX_FAC + key, TTL_FAC);
    if (cached) { callback(null, cached); return; }

    /* Build a case-insensitive regex that matches both:
     *   "powiat krakowski"  and  "krakowski"
     * Uses a literal space (not \s) for Overpass POSIX regex compatibility. */
    var escaped = regexEscape(key);
    var nameRegex = "^(powiat )?" + escaped + "$";

    var ql =
      "[out:json][timeout:80];" +
      /* 1. Find the powiat admin boundary relation */
      'rel["boundary"="administrative"]["admin_level"="6"]' +
        '["name"~"' + nameRegex + '",i]->.p;' +
      /* 2. Convert to area */
      ".p map_to_area -> .a;" +
      /* 3. Find schools and kindergartens inside */
      "(" +
      '  node["amenity"="school"](area.a);' +
      '  way["amenity"="school"](area.a);' +
      '  node["amenity"="kindergarten"](area.a);' +
      '  way["amenity"="kindergarten"](area.a);' +
      ");" +
      "out center tags;";

    overpassQuery(ql)
      .then(function (data) {
        var facilities = parseElements(data.elements, key);
        if (facilities.length > 0) {
          cacheSet(PREFIX_FAC + key, facilities);
        }
        callback(null, facilities);
      })
      .catch(function (err) { callback(err, null); });
  }

  /* -----------------------------------------------------------------------
   * Data parsing
   * --------------------------------------------------------------------- */

  function parseElements(elements, key) {
    return elements
      .filter(function (e) {
        return e.tags && (e.tags.amenity === "school" || e.tags.amenity === "kindergarten");
      })
      .map(function (e) {
        var lat = e.lat != null ? e.lat : (e.center ? e.center.lat : null);
        var lon = e.lon != null ? e.lon : (e.center ? e.center.lon : null);
        if (lat == null || lon == null) return null;

        var typ = e.tags.amenity === "school" ? "SP" : "PRZ";
        var city = e.tags["addr:city"] || e.tags["addr:place"] || e.tags["is_in:city"] || "";

        return {
          rspo: String(e.id),
          nazwa: e.tags.name || e.tags["name:pl"] || "(brak nazwy)",
          typ: typ,
          miejscowosc: city,
          gmina: e.tags["is_in:county"] || "",
          powiat: key,
          powiat_key: key,
          wojewodztwo: e.tags["is_in:province"] || "",
          adres: buildAddr(e.tags),
          lat: Math.round(lat * 1e6) / 1e6,
          lon: Math.round(lon * 1e6) / 1e6,
        };
      })
      .filter(Boolean);
  }

  function buildAddr(tags) {
    var parts = [];
    var street = tags["addr:street"] || "";
    var num = tags["addr:housenumber"] || "";
    if (street) parts.push(num ? street + " " + num : street);
    var postcode = tags["addr:postcode"] || "";
    var city = tags["addr:city"] || tags["addr:place"] || "";
    if (postcode || city) parts.push([postcode, city].filter(Boolean).join(" "));
    return parts.join(", ");
  }

  function regexEscape(s) {
    /* Escape only chars that are special in POSIX ERE (used by Overpass) */
    return s.replace(/[.^$*+?{}()|[\]\\]/g, "\\$&");
  }

  /* -----------------------------------------------------------------------
   * Cache management
   * --------------------------------------------------------------------- */

  function clearCache() {
    var toRemove = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && (k === KEY_LIST || k.indexOf(PREFIX_FAC) === 0)) toRemove.push(k);
    }
    toRemove.forEach(function (k) { localStorage.removeItem(k); });
    return toRemove.length;
  }

  global.Overpass = {
    loadPowiatList: loadPowiatList,
    fetchFacilities: fetchFacilities,
    powiatKey: powiatKey,
    clearCache: clearCache,
  };
})(window);
