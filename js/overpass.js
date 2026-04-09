/* Overpass API integration: Polish powiats list + school/kindergarten fetching.
 * Results are cached in localStorage to avoid repeated queries.
 */
(function (global) {
  "use strict";

  /* Bounding box roughly covering Poland (lat 49.0-55.0, lon 14.1-24.2) */
  var PL_BBOX = "49.0,14.1,55.0,24.2";
  var ENDPOINT = "https://overpass-api.de/api/interpreter";

  /* Cache keys and TTLs */
  var KEY_LIST = "overpass_powiaty_list_v2";
  var TTL_LIST = 7 * 86400 * 1000; /* 7 days */
  var PREFIX_FAC = "overpass_fac_v2_";
  var TTL_FAC = 24 * 3600 * 1000; /* 24 hours */

  /** Normalize a powiat name to a stable lowercase search key. */
  function powiatKey(name) {
    return (name || "")
      .replace(/^powiat\s+/i, "")
      .replace(/^miasto\s+/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /** Post an Overpass QL query and return a Promise resolving to JSON. */
  function overpassQuery(ql) {
    return fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(ql),
    }).then(function (r) {
      if (!r.ok) throw new Error("Overpass HTTP " + r.status);
      return r.json();
    });
  }

  /** Try reading a cached value from localStorage.
   *  Returns the parsed object or null if missing / expired. */
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
      /* localStorage may be full — ignore */
    }
  }

  /**
   * Load the list of all Polish powiats from Overpass.
   * callback(err, [{name, key}])
   */
  function loadPowiatList(callback) {
    var cached = cacheGet(KEY_LIST, TTL_LIST);
    if (cached) {
      callback(null, cached);
      return;
    }

    var ql =
      "[out:json][timeout:60][bbox:" +
      PL_BBOX +
      "];" +
      'relation["boundary"="administrative"]["admin_level"="6"];' +
      "out tags;";

    overpassQuery(ql)
      .then(function (data) {
        var list = data.elements
          .filter(function (e) {
            return e.tags && e.tags.name;
          })
          .map(function (e) {
            return {
              name: e.tags.name,
              key: powiatKey(e.tags.name),
            };
          })
          /* deduplicate by key */
          .filter(function (item, idx, arr) {
            return arr.findIndex(function (x) { return x.key === item.key; }) === idx;
          })
          .sort(function (a, b) {
            return a.key.localeCompare(b.key, "pl");
          });

        cacheSet(KEY_LIST, list);
        callback(null, list);
      })
      .catch(function (err) {
        callback(err, null);
      });
  }

  /**
   * Fetch all primary schools + kindergartens in a powiat identified by key.
   * callback(err, [facility...])
   */
  function fetchFacilities(key, callback) {
    var cached = cacheGet(PREFIX_FAC + key, TTL_FAC);
    if (cached) {
      callback(null, cached);
      return;
    }

    /* Try matching OSM name with and without "powiat " prefix, case-insensitive. */
    var namePattern = "^(powiat\\\\s+)?" + regexEscape(key) + "$";
    var ql =
      "[out:json][timeout:90];" +
      /* Step 1: find the powiat admin boundary */
      'rel["boundary"="administrative"]["admin_level"="6"]["name"~"' +
      namePattern +
      '",i]->.p;' +
      ".p map_to_area -> .a;" +
      /* Step 2: query schools and kindergartens inside that area */
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
        cacheSet(PREFIX_FAC + key, facilities);
        callback(null, facilities);
      })
      .catch(function (err) {
        callback(err, null);
      });
  }

  function parseElements(elements, key) {
    return elements
      .filter(function (e) {
        return (
          e.tags &&
          (e.tags.amenity === "school" || e.tags.amenity === "kindergarten")
        );
      })
      .map(function (e) {
        var lat = e.lat != null ? e.lat : e.center ? e.center.lat : null;
        var lon = e.lon != null ? e.lon : e.center ? e.center.lon : null;
        if (lat == null || lon == null) return null;

        var typ = e.tags.amenity === "school" ? "SP" : "PRZ";
        var city =
          e.tags["addr:city"] ||
          e.tags["addr:place"] ||
          e.tags["is_in:city"] ||
          "";

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
    if (street) {
      parts.push(num ? street + " " + num : street);
    }
    var postcode = tags["addr:postcode"] || "";
    var city = tags["addr:city"] || tags["addr:place"] || "";
    if (postcode || city) {
      parts.push([postcode, city].filter(Boolean).join(" "));
    }
    return parts.join(", ");
  }

  function regexEscape(s) {
    return s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
  }

  /** Clear all Overpass caches (for debugging / manual refresh). */
  function clearCache() {
    var toRemove = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && (k === KEY_LIST || k.indexOf(PREFIX_FAC) === 0)) {
        toRemove.push(k);
      }
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
