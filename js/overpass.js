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
      "[out:json][timeout:90];" +
      /* 1. Find the powiat admin boundary relation */
      'rel["boundary"="administrative"]["admin_level"="6"]' +
        '["name"~"' + nameRegex + '",i]->.p;' +
      /* 2. Convert to area */
      ".p map_to_area -> .a;" +
      /* 3. Find schools, kindergartens and community centres inside */
      "(" +
      '  node["amenity"="school"](area.a);' +
      '  way["amenity"="school"](area.a);' +
      '  node["amenity"="kindergarten"](area.a);' +
      '  way["amenity"="kindergarten"](area.a);' +
      /* Community centres - multiple tag variants used in Poland */
      '  node["amenity"="community_centre"](area.a);' +
      '  way["amenity"="community_centre"](area.a);' +
      '  node["amenity"="culture_centre"](area.a);' +
      '  way["amenity"="culture_centre"](area.a);' +
      '  node["building"="community_centre"](area.a);' +
      '  way["building"="community_centre"](area.a);' +
      '  node["building"="culture_centre"](area.a);' +
      '  way["building"="culture_centre"](area.a);' +
      '  node["leisure"="community_centre"](area.a);' +
      '  way["leisure"="community_centre"](area.a);' +
      '  node["leisure"="culture_centre"](area.a);' +
      '  way["leisure"="culture_centre"](area.a);' +
      /* Polish cultural centres - often tagged as "centre" or with "club" */
      '  node["amenity"~"centre|center"](area.a);' +
      '  way["amenity"~"centre|center"](area.a);' +
      '  node["club"](area.a);' +
      '  way["club"](area.a);' +
      ");" +
      "out center tags;";

    overpassQuery(ql)
      .then(function (data) {
        console.log("Raw Overpass response for " + key + ":", {
          totalElements: data.elements.length,
          sampleElements: data.elements.slice(0, 5).map(function(e) {
            return {
              type: e.type,
              id: e.id,
              amenity: e.tags?.amenity,
              building: e.tags?.building,
              leisure: e.tags?.leisure,
              name: e.tags?.name
            };
          })
        });

        var facilities = parseElements(data.elements, key);
        if (facilities.length > 0) {
          cacheSet(PREFIX_FAC + key, facilities);
        }
        console.log("Overpass results for " + key + ":", {
          totalElements: data.elements.length,
          facilities: facilities.length,
          byType: {
            SP: facilities.filter(function(f) { return f.typ === "SP"; }).length,
            PRZ: facilities.filter(function(f) { return f.typ === "PRZ"; }).length,
            DK: facilities.filter(function(f) { return f.typ === "DK"; }).length
          },
          sampleDK: facilities.filter(function(f) { return f.typ === "DK"; }).slice(0, 3).map(function(f) {
            return { nazwa: f.nazwa, tags: data.elements.find(function(e) { return String(e.id) === f.rspo; })?.tags };
          })
        });
        callback(null, facilities);
      })
      .catch(function (err) { callback(err, null); });
  }

  /* -----------------------------------------------------------------------
   * Data parsing
   * --------------------------------------------------------------------- */

  /* Sensible default student counts when OSM has no `capacity` tag.
   * Based on approximate Polish averages from SIO data so that the
   * "liczba uczniow" ranking gives meaningful results even without
   * real per-facility numbers. */
  var DEFAULT_UCZNIOWIE_SP = 300;
  var DEFAULT_UCZNIOWIE_PRZ = 100;

  function extractUczniowie(tags, typ) {
    /* Community centres don't have students */
    if (typ === "DK") {
      return 0;
    }

    /* OSM sometimes exposes a `capacity`, `capacity:students`, or
     * `capacity:pupils` tag — prefer those when present. */
    var candidates = [
      tags["capacity:students"],
      tags["capacity:pupils"],
      tags["capacity:persons"],
      tags["capacity"],
    ];
    for (var i = 0; i < candidates.length; i++) {
      var raw = candidates[i];
      if (raw == null || raw === "") continue;
      var n = parseInt(String(raw).replace(/[^0-9]/g, ""), 10);
      if (!isNaN(n) && n > 0) return n;
    }
    return typ === "SP" ? DEFAULT_UCZNIOWIE_SP : DEFAULT_UCZNIOWIE_PRZ;
  }

  function parseElements(elements, key) {
    /* Debug: log all community_centre elements */
    var communityCentres = elements.filter(function (e) {
      return e.tags && (
        e.tags.amenity === "community_centre" ||
        e.tags.building === "community_centre" ||
        e.tags.leisure === "community_centre"
      );
    });
    if (communityCentres.length > 0) {
      console.log("Found community_centre elements:", communityCentres.length, communityCentres.slice(0, 3).map(function (e) {
        return { id: e.id, name: e.tags.name, amenity: e.tags.amenity, building: e.tags.building, leisure: e.tags.leisure };
      }));
    }

    return elements
      .filter(function (e) {
        if (!e.tags) return false;
        /* Schools and kindergartens */
        if (e.tags.amenity === "school" || e.tags.amenity === "kindergarten") return true;
        /* Community & cultural centres - multiple tag variants */
        if (e.tags.amenity === "community_centre" ||
            e.tags.amenity === "culture_centre" ||
            e.tags.building === "community_centre" ||
            e.tags.building === "culture_centre" ||
            e.tags.leisure === "community_centre" ||
            e.tags.leisure === "culture_centre" ||
            (e.tags.amenity && /centre|center/i.test(e.tags.amenity)) ||
            e.tags.club) {
          return true;
        }
        return false;
      })
      .map(function (e) {
        var lat = e.lat != null ? e.lat : (e.center ? e.center.lat : null);
        var lon = e.lon != null ? e.lon : (e.center ? e.center.lon : null);
        if (lat == null || lon == null) return null;

        var typ;
        var nameTag = e.tags.name || e.tags["name:pl"] || "";
        var city = e.tags["addr:city"] || e.tags["addr:place"] || e.tags["is_in:city"] || "";

        /* Determine facility type based on tags */
        if (e.tags.amenity === "school") {
          typ = "SP";
        } else if (e.tags.amenity === "kindergarten") {
          typ = "PRZ";
        } else if (e.tags.amenity === "community_centre" ||
                   e.tags.amenity === "culture_centre" ||
                   e.tags.building === "community_centre" ||
                   e.tags.building === "culture_centre" ||
                   e.tags.leisure === "community_centre" ||
                   e.tags.leisure === "culture_centre" ||
                   (e.tags.amenity && /centre|center/i.test(e.tags.amenity)) ||
                   e.tags.club) {
          typ = "DK";
        } else {
          return null;
        }

        /* Skip facilities without a name */
        if (!nameTag || nameTag.trim().length === 0) return null;

        return {
          rspo: String(e.id),
          nazwa: nameTag,
          typ: typ,
          miejscowosc: city,
          gmina: e.tags["is_in:county"] || "",
          powiat: key,
          powiat_key: key,
          wojewodztwo: e.tags["is_in:province"] || "",
          adres: buildAddr(e.tags),
          lat: Math.round(lat * 1e6) / 1e6,
          lon: Math.round(lon * 1e6) / 1e6,
          uczniowie: extractUczniowie(e.tags, typ),
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
