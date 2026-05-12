/* Main app: load data, handle search form, build ranking, wire UI.
 *
 * Data flow priority:
 *  1. Local data/placowki.json (pre-processed RSPO data, fast, offline-safe)
 *  2. Overpass API (OpenStreetMap, live, fetched in-browser, cached 24h)
 *
 * Powiat autocomplete:
 *  - Keys from local JSON (always fast)
 *  - Merged with Overpass powiat list (async, cached 7 days)
 */
(function () {
  "use strict";

  var state = {
    facilities: [],       /* all locally loaded facilities */
    byPowiat: {},         /* powiat_key -> [facility, ...] from local JSON */
    powiatKeys: [],       /* sorted unique powiat keys (local) */
    datalistKeys: new Set(), /* all known powiat keys for datalist */
    currentCities: [],    /* ranking for last search */
    currentMappedFacilities: [], /* last rendered facilities with coordinates */
    currentRadiusKm: 5,
    analysisMode: "cities", /* cities | county */
    activeCityKey: null,
    searching: false,
  };

  var GEO_CACHE_PREFIX = "geocode_v1_";
  var GEO_CACHE_HIT_TTL = 180 * 86400 * 1000; /* 180 days */
  var GEO_CACHE_MISS_TTL = 14 * 86400 * 1000; /* 14 days */
  var GEO_DELAY_MS = 1100; /* Nominatim-friendly pacing */
  var GEO_TIMEOUT_MS = 15000;
  var GEO_MAX_PER_RUN = 250;

  var els = {};

  document.addEventListener("DOMContentLoaded", function () {
    els.form = document.getElementById("search-form");
    els.powiatInput = document.getElementById("powiat-input");
    els.radiusInput = document.getElementById("radius-input");
    els.modeSelect = document.getElementById("mode-select");
    els.powiatList = document.getElementById("powiat-list");
    els.status = document.getElementById("status");
    els.results = document.getElementById("results");
    els.submitBtn = els.form.querySelector("button[type=submit]");
    els.csvImportBtn = document.getElementById("csv-import-btn");
    els.csvModal = document.getElementById("csv-modal");
    els.csvModalClose = document.getElementById("csv-modal-close");
    els.csvDropzone = document.getElementById("csv-dropzone");
    els.csvFileInput = document.getElementById("csv-file-input");
    els.csvFilename = document.getElementById("csv-filename");
    els.csvParseStatus = document.getElementById("csv-parse-status");
    els.csvLoadBtn = document.getElementById("csv-load-btn");
    els.csvCancelBtn = document.getElementById("csv-cancel-btn");

    MapLayer.initMap("map");

    els.form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!state.searching) handleSearch();
    });

    /* CSV import modal */
    if (els.csvImportBtn) els.csvImportBtn.addEventListener("click", openCsvModal);
    if (els.csvModalClose) els.csvModalClose.addEventListener("click", closeCsvModal);
    if (els.csvCancelBtn) els.csvCancelBtn.addEventListener("click", closeCsvModal);
    if (els.csvModal) {
      els.csvModal.addEventListener("click", function (e) {
        if (e.target === els.csvModal) closeCsvModal();
      });
    }
    if (els.csvLoadBtn) els.csvLoadBtn.addEventListener("click", importCsv);

    /* Drag-and-drop and file picker */
    if (els.csvDropzone) {
      els.csvDropzone.addEventListener("click", function () {
        if (els.csvFileInput) els.csvFileInput.click();
      });
      els.csvDropzone.addEventListener("dragover", function (e) {
        e.preventDefault();
        els.csvDropzone.classList.add("drag-over");
      });
      els.csvDropzone.addEventListener("dragleave", function () {
        els.csvDropzone.classList.remove("drag-over");
      });
      els.csvDropzone.addEventListener("drop", function (e) {
        e.preventDefault();
        els.csvDropzone.classList.remove("drag-over");
        var files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length > 0) handleFileSelected(files[0]);
      });
    }
    if (els.csvFileInput) {
      els.csvFileInput.addEventListener("change", function () {
        if (els.csvFileInput.files && els.csvFileInput.files.length > 0) {
          handleFileSelected(els.csvFileInput.files[0]);
        }
      });
    }

    /* Load local JSON (fast, offline) and async Overpass powiat list */
    loadLocalData();
    loadOverpassPowiatList();
  });

  /* -----------------------------------------------------------------------
   * Status helpers
   * --------------------------------------------------------------------- */

  function setStatus(text, isError) {
    if (els.status) {
      els.status.textContent = text || "";
      els.status.classList.toggle("error", Boolean(isError));
    }
  }

  function setLoading(loading) {
    state.searching = loading;
    if (els.submitBtn) {
      els.submitBtn.disabled = loading;
      els.submitBtn.textContent = loading ? "Ładowanie..." : "Szukaj";
    }
  }

  /* -----------------------------------------------------------------------
   * Data loading
   * --------------------------------------------------------------------- */

  function loadLocalData() {
    setStatus("Ładowanie lokalnej bazy placówek...");
    fetch("data/placowki.json", { cache: "no-cache" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        state.facilities = data;
        indexByPowiat(data);
        mergeIntoDatalist(state.powiatKeys);
        setStatus(
          "Załadowano " +
            data.length +
            " placówek z lokalnej bazy (" +
            state.powiatKeys.length +
            " powiatów)."
        );
      })
      .catch(function (err) {
        console.warn("Lokalna baza placowki.json niedostepna:", err.message);
        setStatus(
          "Brak lokalnej bazy — dane pobierane na żądanie z OpenStreetMap."
        );
      });
  }

  function loadOverpassPowiatList() {
    Overpass.loadPowiatList(function (err, list) {
      if (err || !list) {
        console.warn("Overpass powiat list error:", err);
        return;
      }
      var keys = list.map(function (item) { return item.key; });
      mergeIntoDatalist(keys);
      setStatus(
        "Gotowy. Zidentyfikowano " +
          state.datalistKeys.size +
          " powiatów (baza OSM). Wpisz powiat i kliknij Szukaj."
      );
    });
  }

  function indexByPowiat(facilities) {
    var byPowiat = {};
    for (var i = 0; i < facilities.length; i++) {
      var f = facilities[i];
      var key = f.powiat_key || "";
      if (!key) continue;
      if (!byPowiat[key]) byPowiat[key] = [];
      byPowiat[key].push(f);
    }
    state.byPowiat = byPowiat;
    state.powiatKeys = Object.keys(byPowiat).sort();
  }

  function hasCoords(facility) {
    return facility && facility.lat != null && facility.lon != null;
  }

  function countMissingCoords(facilities) {
    var missing = 0;
    for (var i = 0; i < facilities.length; i++) {
      if (!hasCoords(facilities[i])) missing++;
    }
    return missing;
  }

  function groupFacilitiesByPowiat(facilities, fallbackKey) {
    var grouped = {};
    for (var i = 0; i < facilities.length; i++) {
      var f = facilities[i];
      var key = Overpass.powiatKey(f.powiat_key || f.powiat || "") || fallbackKey;
      if (!key) continue;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(f);
    }
    return grouped;
  }

  function mergeIntoDatalist(keys) {
    keys.forEach(function (k) { state.datalistKeys.add(k); });
    rebuildDatalist();
  }

  function rebuildDatalist() {
    if (!els.powiatList) return;
    els.powiatList.innerHTML = "";
    /* Sort before rendering */
    var sorted = Array.from(state.datalistKeys).sort(function (a, b) {
      return a.localeCompare(b, "pl");
    });
    sorted.forEach(function (k) {
      var opt = document.createElement("option");
      opt.value = k;
      els.powiatList.appendChild(opt);
    });
  }

  /* -----------------------------------------------------------------------
   * Search handler
   * --------------------------------------------------------------------- */

  function normalizePowiat(input) {
    return Overpass.powiatKey(input);
  }

  function handleSearch() {
    var rawPowiat = els.powiatInput.value;
    var powiatKey = normalizePowiat(rawPowiat);
    var radiusKm = parseFloat(els.radiusInput.value);
    var mode = els.modeSelect ? els.modeSelect.value : "cities";
    if (mode !== "cities" && mode !== "county") mode = "cities";

    if (!powiatKey) {
      setStatus("Wpisz nazwę powiatu.", true);
      return;
    }
    if (!radiusKm || radiusKm <= 0) {
      setStatus("Promień musi być dodatni.", true);
      return;
    }

    state.currentRadiusKm = radiusKm;
    state.analysisMode = mode;

    /* If we have local data for this powiat, use it immediately.
     * BUT: if none of the local facilities have coordinates (e.g. CSV import
     * without lat/lon), fall back to Overpass to get coords and merge them in
     * so schools can be plotted on the map. */
    var localFacilities = state.byPowiat[powiatKey];
    if (localFacilities && localFacilities.length > 0) {
      sanitizeFacilitiesAgainstPowiatBounds(localFacilities, powiatKey, function (_bounds, invalidated) {
        var withCoords = 0;
        var withoutCoords = 0;
        for (var i = 0; i < localFacilities.length; i++) {
          if (hasCoords(localFacilities[i])) withCoords++;
          else withoutCoords++;
        }

        if (withoutCoords === 0) {
          var localSource = "lokalna baza RSPO";
          if (invalidated > 0) localSource += " (skorygowano " + invalidated + " poza granica powiatu)";
          processAndRender(localFacilities, powiatKey, radiusKm, localSource);
          return;
        }

        /* Local data is partially/fully without coordinates — enrich from OSM. */
        setLoading(true);
        setStatus("Uzupelniam brakujace wspolrzedne z OpenStreetMap...");
        els.results.innerHTML = "";
        MapLayer.clear();

        Overpass.fetchFacilities(powiatKey, function (err, osmFacilities) {
          if (err || !osmFacilities || osmFacilities.length === 0) {
            /* Fallback: geocode addresses from CSV directly. */
            setStatus(
              "OpenStreetMap nie zwrocil danych (" +
                (err ? err.message : "brak wynikow") +
                "). Geokoduje adresy z CSV..."
            );
            enrichMissingCoordsFromNominatim(localFacilities, powiatKey, function (enriched, geoMeta) {
              fillMissingFromPlaceCenters(enriched, powiatKey, function (finalFacilities, placeMeta) {
                setLoading(false);
                state.byPowiat[powiatKey] = finalFacilities;
                var sourceFallback = withCoords > 0
                  ? "lokalna baza RSPO + geokodowanie adresow"
                  : "CSV + geokodowanie adresow";
                if (geoMeta && geoMeta.requested > 0) {
                  sourceFallback += " (" + geoMeta.resolved + "/" + geoMeta.requested + " uzupelnionych)";
                }
                if (placeMeta && placeMeta.resolved > 0) {
                  sourceFallback += " + miejscowosci OSM (" + placeMeta.resolved + ")";
                }
                processAndRender(finalFacilities, powiatKey, radiusKm, sourceFallback);
              });
            });
            return;
          }

          var merged = mergeCoordsByName(localFacilities, osmFacilities);
          var missingAfterMerge = countMissingCoords(merged);
          if (missingAfterMerge === 0) {
            setLoading(false);
            state.byPowiat[powiatKey] = merged;
            processAndRender(merged, powiatKey, radiusKm, "CSV + OpenStreetMap (uzupelnione wspolrzedne)");
            return;
          }

          setStatus(
            "Dopasowano czesc placowek w OSM. Geokoduje pozostale adresy z CSV (" +
              missingAfterMerge +
              ")..."
          );

          enrichMissingCoordsFromNominatim(merged, powiatKey, function (enrichedMerged, geoMeta2) {
            fillMissingFromPlaceCenters(enrichedMerged, powiatKey, function (finalMerged, placeMeta2) {
              setLoading(false);
              state.byPowiat[powiatKey] = finalMerged;
              var source = "CSV + OpenStreetMap + geokodowanie adresow";
              if (geoMeta2 && geoMeta2.requested > 0) {
                source += " (" + geoMeta2.resolved + "/" + geoMeta2.requested + " uzupelnionych)";
              }
              if (placeMeta2 && placeMeta2.resolved > 0) {
                source += " + miejscowosci OSM (" + placeMeta2.resolved + ")";
              }
              processAndRender(finalMerged, powiatKey, radiusKm, source);
            });
          });
        });
      });
      return;
    }

    /* Otherwise fetch from Overpass */
    setLoading(true);
    setStatus("Pobieranie danych z OpenStreetMap dla powiatu: " + rawPowiat + "...");
    els.results.innerHTML = "";
    MapLayer.clear();

    Overpass.fetchFacilities(powiatKey, function (err, facilities) {
      setLoading(false);
      if (err) {
        setStatus(
          "Błąd pobierania z Overpass: " + err.message + ". Spróbuj ponownie.",
          true
        );
        renderSuggestions(powiatKey);
        return;
      }
      if (!facilities || facilities.length === 0) {
        setStatus(
          'Nie znaleziono placówek dla powiatu ' +
            powiatKey +
            '". Sprawdź pisownię.',
          true
        );
        renderSuggestions(powiatKey);
        return;
      }

      /* Cache in local state so re-renders don't hit Overpass again */
      state.byPowiat[powiatKey] = facilities;
      if (!state.datalistKeys.has(powiatKey)) {
        state.datalistKeys.add(powiatKey);
        rebuildDatalist();
      }
      processAndRender(facilities, powiatKey, radiusKm, "OpenStreetMap (Overpass)");
    });
  }

  /**
   * Normalise a facility name for fuzzy matching: lower-case, Polish
   * diacritics removed, punctuation stripped, stop-words dropped.
   */
  function normName(s) {
    return (s || "")
      .toLowerCase()
      .replace(/[\u0105\u0104]/g, "a")
      .replace(/[\u0107\u0106]/g, "c")
      .replace(/[\u0119\u0118]/g, "e")
      .replace(/[\u0142\u0141]/g, "l")
      .replace(/[\u0144\u0143]/g, "n")
      .replace(/[\u00F3\u00D3]/g, "o")
      .replace(/[\u015B\u015A]/g, "s")
      .replace(/[\u017A\u0179]/g, "z")
      .replace(/[\u017C\u017B]/g, "z")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\b(im|imienia|w|we|ul|nr|sp|szkola|podstawowa|przedszkole|samorzadowe|publiczne|publiczna)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normAddrKey(s) {
    return (s || "")
      .toLowerCase()
      .replace(/[\u0105\u0104]/g, "a")
      .replace(/[\u0107\u0106]/g, "c")
      .replace(/[\u0119\u0118]/g, "e")
      .replace(/[\u0142\u0141]/g, "l")
      .replace(/[\u0144\u0143]/g, "n")
      .replace(/[\u00F3\u00D3]/g, "o")
      .replace(/[\u015B\u015A]/g, "s")
      .replace(/[\u017A\u0179]/g, "z")
      .replace(/[\u017C\u017B]/g, "z")
      .replace(/\s+/g, " ")
      .trim();
  }

  function placeNameKey(s) {
    return normAddrKey(s)
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function uniqueNonEmptyParts(parts) {
    var seen = {};
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var raw = parts[i] == null ? "" : String(parts[i]).trim();
      if (!raw) continue;
      var key = placeNameKey(raw);
      if (!key || seen[key]) continue;
      seen[key] = true;
      out.push(raw);
    }
    return out;
  }

  function powiatLabel(raw) {
    var value = (raw || "").trim();
    if (!value) return "";
    if (/^powiat\s+/i.test(value)) return value;
    return "powiat " + value;
  }

  function cleanStreetForGeocode(street) {
    return (street || "")
      .replace(/^ul\.?\s+/i, "")
      .replace(/^aleja\s+/i, "")
      .replace(/^al\.?\s+/i, "")
      .replace(/^plac\s+/i, "")
      .replace(/^pl\.?\s+/i, "")
      .replace(/^os\.?\s+/i, "")
      .replace(/^osiedle\s+/i, "")
      .trim();
  }

  function parseAddressParts(addr) {
    var source = (addr || "").trim();
    if (!source) return { street: "", city: "" };
    var chunks = source.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    var street = chunks.length > 0 ? cleanStreetForGeocode(chunks[0]) : "";
    var city = "";
    if (chunks.length > 1) {
      city = chunks[1]
        .replace(/\b\d{2}-\d{3}\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
    return { street: street, city: city };
  }

  function buildGeocodeQueries(facility, powiatKey) {
    var pLabel = powiatLabel(facility.powiat || powiatKey);
    var locality = (facility.miejscowosc || "").trim();
    var gmina = (facility.gmina || "").trim();
    var parsedAddr = parseAddressParts(facility.adres || "");
    var city = locality || parsedAddr.city || gmina;

    var queries = [];
    var candidates = [
      [parsedAddr.street, city],
      [parsedAddr.street, city, "Polska"],
      [facility.adres, city],
      [facility.adres, locality, gmina],
      [facility.nazwa, city],
      [facility.nazwa, city, pLabel],
      [facility.nazwa, locality || gmina, pLabel, "Polska"],
      [facility.adres, locality, gmina, pLabel, "Polska"],
    ];

    for (var i = 0; i < candidates.length; i++) {
      var parts = uniqueNonEmptyParts(candidates[i]);
      if (parts.length === 0) continue;
      var q = parts.join(", ");
      var qKey = placeNameKey(q);
      var exists = false;
      for (var j = 0; j < queries.length; j++) {
        if (placeNameKey(queries[j]) === qKey) {
          exists = true;
          break;
        }
      }
      if (!exists) queries.push(q);
      if (queries.length >= 4) break;
    }
    return queries;
  }

  function simpleHash(text) {
    var hash = 2166136261;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(36);
  }

  function geocodeScopeKey(powiatKey, bounds) {
    var scope = String(powiatKey || "").trim();
    if (!bounds) return scope;
    return (
      scope +
      "|" +
      [
        Number(bounds.minlat || 0).toFixed(3),
        Number(bounds.minlon || 0).toFixed(3),
        Number(bounds.maxlat || 0).toFixed(3),
        Number(bounds.maxlon || 0).toFixed(3),
      ].join(",")
    );
  }

  function geocodeCacheKey(query, scopeKey) {
    var normalized = placeNameKey(query);
    if (!normalized) return "";
    return GEO_CACHE_PREFIX + simpleHash((scopeKey || "") + "|" + normalized);
  }

  function geocodeCacheGet(query, scopeKey) {
    var key = geocodeCacheKey(query, scopeKey);
    if (!key) return null;
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || !obj.status || !obj.ts) return null;
      var ttl = obj.status === "ok" ? GEO_CACHE_HIT_TTL : GEO_CACHE_MISS_TTL;
      if (Date.now() - obj.ts > ttl) return null;
      return obj;
    } catch (e) {
      return null;
    }
  }

  function geocodeCacheSet(query, scopeKey, status, coords) {
    var key = geocodeCacheKey(query, scopeKey);
    if (!key) return;
    try {
      localStorage.setItem(
        key,
        JSON.stringify({
          ts: Date.now(),
          status: status,
          lat: coords && coords.lat != null ? coords.lat : null,
          lon: coords && coords.lon != null ? coords.lon : null,
        })
      );
    } catch (e) {
      /* ignore localStorage errors */
    }
  }

  function isInsideBounds(lat, lon, bounds) {
    if (!bounds) return true;
    var margin = 0.005; /* ~0.5 km margin for boundary precision */
    return (
      lat >= (bounds.minlat - margin) &&
      lat <= (bounds.maxlat + margin) &&
      lon >= (bounds.minlon - margin) &&
      lon <= (bounds.maxlon + margin)
    );
  }

  function sanitizeFacilitiesAgainstPowiatBounds(facilities, powiatKey, callback) {
    if (typeof callback !== "function") callback = function () {};
    if (!Array.isArray(facilities) || facilities.length === 0) {
      callback(null, 0);
      return;
    }
    if (typeof Overpass.fetchPowiatBounds !== "function") {
      callback(null, 0);
      return;
    }

    Overpass.fetchPowiatBounds(powiatKey, function (err, bounds) {
      if (err || !bounds) {
        if (err) console.warn("Nie udalo sie pobrac granic do walidacji punktow:", err.message);
        callback(bounds || null, 0);
        return;
      }

      var invalidated = 0;
      for (var i = 0; i < facilities.length; i++) {
        var f = facilities[i];
        if (!hasCoords(f)) continue;
        if (!isInsideBounds(f.lat, f.lon, bounds)) {
          f.lat = null;
          f.lon = null;
          invalidated++;
        }
      }
      callback(bounds, invalidated);
    });
  }

  function geocodeQueryNominatim(query, options, callback) {
    options = options || {};
    var scopeKey = geocodeScopeKey(options.powiatKey, options.bounds);
    var cached = geocodeCacheGet(query, scopeKey);
    if (cached) {
      if (cached.status === "ok" && cached.lat != null && cached.lon != null) {
        if (isInsideBounds(cached.lat, cached.lon, options.bounds)) {
          callback(null, { coords: { lat: cached.lat, lon: cached.lon }, fromCache: true });
          return;
        }
      }
      callback(null, { coords: null, fromCache: true });
      return;
    }

    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = null;
    var url =
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=pl&addressdetails=0&accept-language=pl&q=" +
      encodeURIComponent(query);

    if (options.bounds) {
      var viewbox = [
        options.bounds.minlon,
        options.bounds.maxlat,
        options.bounds.maxlon,
        options.bounds.minlat,
      ].join(",");
      url += "&viewbox=" + encodeURIComponent(viewbox) + "&bounded=1";
    }

    fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller ? controller.signal : undefined,
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (rows) {
        if (Array.isArray(rows) && rows.length > 0) {
          var lat = parseFloat(rows[0].lat);
          var lon = parseFloat(rows[0].lon);
          if (!isNaN(lat) && !isNaN(lon)) {
            var coords = {
              lat: Math.round(lat * 1e6) / 1e6,
              lon: Math.round(lon * 1e6) / 1e6,
            };
            if (isInsideBounds(coords.lat, coords.lon, options.bounds)) {
              geocodeCacheSet(query, scopeKey, "ok", coords);
              callback(null, { coords: coords, fromCache: false });
              return;
            }
          }
        }
        geocodeCacheSet(query, scopeKey, "miss", null);
        callback(null, { coords: null, fromCache: false });
      })
      .catch(function (err) {
        callback(err, { coords: null, fromCache: false });
      })
      .finally(function () {
        if (timer) clearTimeout(timer);
      });

    if (controller) {
      timer = setTimeout(function () {
        controller.abort();
      }, GEO_TIMEOUT_MS);
    }
  }

  function geocodeFacility(facility, powiatKey, powiatBounds, callback) {
    var queries = buildGeocodeQueries(facility, powiatKey);
    if (queries.length === 0) {
      callback(null, { coords: null, fromCacheOnly: true });
      return;
    }

    var idx = 0;
    var usedNetwork = false;

    function next() {
      if (idx >= queries.length) {
        callback(null, { coords: null, fromCacheOnly: !usedNetwork });
        return;
      }
      var query = queries[idx++];
      geocodeQueryNominatim(query, { powiatKey: powiatKey, bounds: powiatBounds }, function (err, result) {
        if (result && !result.fromCache) usedNetwork = true;
        if (result && result.coords) {
          callback(null, { coords: result.coords, fromCacheOnly: !usedNetwork });
          return;
        }
        if (err) {
          console.warn("Geokodowanie nieudane dla zapytania:", query, err.message);
        }
        next();
      });
    }

    next();
  }

  function enrichMissingCoordsFromNominatim(facilities, powiatKey, callback) {
    var missingIdx = [];
    for (var i = 0; i < facilities.length; i++) {
      if (!hasCoords(facilities[i]) && facilities[i] && facilities[i].nazwa) {
        missingIdx.push(i);
      }
    }

    if (missingIdx.length === 0) {
      callback(facilities, {
        requested: 0,
        resolved: 0,
        unresolved: 0,
        remainingMissing: 0,
      });
      return;
    }

    function runGeocoding(powiatBounds) {
      var queue = missingIdx.slice(0, GEO_MAX_PER_RUN);
      var requested = queue.length;
      var resolved = 0;
      var unresolved = 0;
      var done = 0;

      function step() {
        if (queue.length === 0) {
          var remainingMissing = countMissingCoords(facilities);
          callback(facilities, {
            requested: requested,
            resolved: resolved,
            unresolved: unresolved,
            remainingMissing: remainingMissing,
          });
          return;
        }

        var idx = queue.shift();
        var facility = facilities[idx];
        geocodeFacility(facility, powiatKey, powiatBounds, function (_err, result) {
          done++;
        if (result && result.coords) {
          facility.lat = result.coords.lat;
          facility.lon = result.coords.lon;
          facility.coords_source = "geocode";
          resolved++;
        } else {
          unresolved++;
          }

          if (done % 5 === 0 || done === requested) {
            setStatus(
              "Geokodowanie adresow z CSV: " +
                done +
                "/" +
                requested +
                " (uzupelniono " +
                resolved +
                ")..."
            );
          }

          setTimeout(step, result && result.fromCacheOnly ? 0 : GEO_DELAY_MS);
        });
      }

      step();
    }

    if (typeof Overpass.fetchPowiatBounds !== "function") {
      runGeocoding(null);
      return;
    }

    Overpass.fetchPowiatBounds(powiatKey, function (boundsErr, bounds) {
      if (boundsErr) {
        console.warn("Nie udalo sie pobrac granic powiatu do geokodowania:", boundsErr.message);
      }
      runGeocoding(bounds || null);
    });
  }

  function fillMissingFromPlaceCenters(facilities, powiatKey, callback) {
    if (typeof callback !== "function") callback = function () {};

    var missingIdx = [];
    for (var i = 0; i < facilities.length; i++) {
      if (!hasCoords(facilities[i]) && facilities[i] && facilities[i].nazwa) {
        missingIdx.push(i);
      }
    }

    if (missingIdx.length === 0) {
      callback(facilities, {
        requested: 0,
        resolved: 0,
        remainingMissing: 0,
      });
      return;
    }

    if (typeof Overpass.fetchPlaceCenters !== "function") {
      callback(facilities, {
        requested: missingIdx.length,
        resolved: 0,
        remainingMissing: countMissingCoords(facilities),
      });
      return;
    }

    setStatus("Uzupelniam pozostale punkty ze srodkow miejscowosci OSM...");
    Overpass.fetchPlaceCenters(powiatKey, function (err, places) {
      if (err || !Array.isArray(places) || places.length === 0) {
        callback(facilities, {
          requested: missingIdx.length,
          resolved: 0,
          remainingMissing: countMissingCoords(facilities),
        });
        return;
      }

      var byKey = {};
      for (var p = 0; p < places.length; p++) {
        var place = places[p];
        if (!place || !place.key) continue;
        if (!byKey[place.key]) byKey[place.key] = place;
      }

      var resolved = 0;
      for (var m = 0; m < missingIdx.length; m++) {
        var idx = missingIdx[m];
        var f = facilities[idx];
        var keys = [
          placeNameKey(f.miejscowosc || ""),
          placeNameKey(f.gmina || ""),
        ];
        var chosen = null;
        for (var k = 0; k < keys.length; k++) {
          if (!keys[k]) continue;
          if (byKey[keys[k]]) {
            chosen = byKey[keys[k]];
            break;
          }
        }
        if (!chosen) continue;

        f.lat = chosen.lat;
        f.lon = chosen.lon;
        f.coords_source = "place_center";
        resolved++;
      }

      callback(facilities, {
        requested: missingIdx.length,
        resolved: resolved,
        remainingMissing: countMissingCoords(facilities),
      });
    });
  }

  function safeStudentCount(facility) {
    if (!facility) return 0;
    var n = parseInt(facility.uczniowie, 10);
    return isNaN(n) || n < 0 ? 0 : n;
  }

  function streetToken(facility) {
    var addr = (facility && facility.adres) ? String(facility.adres) : "";
    if (!addr) return "";
    var first = addr.split(",")[0];
    return normAddrKey(first)
      .replace(/^ul\.?\s+/i, "")
      .replace(/^aleja\s+/i, "")
      .replace(/^al\.?\s+/i, "")
      .replace(/^plac\s+/i, "")
      .trim();
  }

  /**
   * Merge coordinates from OSM facilities into local facilities by matching
   * normalised names (with miejscowosc as tiebreaker). Any local facility
   * without a match keeps lat/lon=null and will be skipped by the map layer,
   * but still contributes to the ranking.
   */
  function mergeCoordsByName(local, osm) {
    var byName = {};
    osm.forEach(function (o) {
      if (!hasCoords(o)) return;
      var key = normName(o.nazwa);
      if (!key) return;
      if (!byName[key]) byName[key] = [];
      byName[key].push(o);
    });

    var matched = 0;
    var out = local.map(function (f) {
      if (hasCoords(f)) return f;
      var key = normName(f.nazwa);
      var candidates = byName[key] || [];
      /* If multiple candidates, prefer same miejscowosc */
      var pick = null;
      if (candidates.length === 1) {
        pick = candidates[0];
      } else if (candidates.length > 1) {
        var targetMiej = normAddrKey(f.miejscowosc || "");
        var filtered = candidates;
        for (var i = 0; i < candidates.length; i++) {
          if (normAddrKey(candidates[i].miejscowosc || "") === targetMiej) {
            if (filtered === candidates) filtered = [];
            filtered.push(candidates[i]);
          }
        }
        if (filtered.length === 1) pick = filtered[0];
        if (!pick && filtered.length > 1) {
          var targetStreet = streetToken(f);
          if (targetStreet) {
            var byStreet = filtered.filter(function (c) {
              return streetToken(c) === targetStreet;
            });
            if (byStreet.length === 1) pick = byStreet[0];
          }
        }
        if (!pick) pick = filtered[0] || candidates[0];
      }
      if (!pick) return f;
      matched++;
      var copy = {};
      for (var k in f) { if (Object.prototype.hasOwnProperty.call(f, k)) copy[k] = f[k]; }
      copy.lat = pick.lat;
      copy.lon = pick.lon;
      return copy;
    });
    console.log("mergeCoordsByName: matched " + matched + "/" + local.length + " facilities");
    return out;
  }

  function processAndRender(facilities, powiatKey, radiusKm, source) {
    buildRanking(facilities, radiusKm, powiatKey, state.analysisMode, function (cities, meta) {
      state.currentCities = cities;
      state.activeCityKey = null;
      state.currentMappedFacilities = facilities.filter(function (f) { return hasCoords(f); });

      var mappedCount = state.currentMappedFacilities.length;
      var modeLabel = state.analysisMode === "county"
        ? "powiat jako jedno miasto"
        : "miasta w powiecie";
      var scopeLabel = state.analysisMode === "county"
        ? "cale terytorium powiatu"
        : "promien " + radiusKm + " km";
      var cityFilterNote = "";
      if (state.analysisMode === "cities" && meta) {
        if (meta.cityFilterApplied) {
          cityFilterNote =
            " | tylko miasta (" +
            meta.nonCityGroupsCount +
            " miejscowosci poza filtrem)";
        } else {
          cityFilterNote = " | filtr miast tymczasowo niedostepny";
        }
      }

      setStatus(
        "Powiat " + powiatKey + ": " +
          facilities.length + " placowek, " +
          mappedCount + " na mapie, " +
          cities.length + " pozycji rankingu | tryb: " +
          modeLabel + cityFilterNote + " | zakres: " +
          scopeLabel + " | zrodlo: " + source
      );

      renderRanking(cities);
      MapLayer.clear();
      MapLayer.plotFacilities(facilities);
      if (state.analysisMode === "county") {
        MapLayer.plotCityCenters([], null);
      } else {
        MapLayer.plotCityCenters(cities, function (city) {
          selectCity(city.key);
        });
      }
    });
  }

  /* -----------------------------------------------------------------------
   * Ranking
   * --------------------------------------------------------------------- */

  /**
   * Build ranking for selected mode.
   * In `cities` mode we keep only OSM urban places (city/town).
   * In `county` mode we aggregate whole powiat as one item (no radius cutoff).
   */
  function buildRanking(facilities, radiusKm, powiatKey, mode, callback) {
    if (typeof callback !== "function") callback = function () {};

    var located = facilities.filter(function (f) {
      return hasCoords(f) && f.nazwa && f.nazwa.length > 0;
    });
    var baseMeta = {
      cityFilterApplied: false,
      nonCityGroupsCount: 0,
      missingCoordsCount: Math.max(0, facilities.length - located.length),
    };

    if (located.length === 0) {
      callback([], baseMeta);
      return;
    }

    if (mode === "county") {
      var countyCenter = Geo.centroid(located);
      if (!countyCenter) {
        callback([], baseMeta);
        return;
      }
      var countyAll = facilities.filter(function (f) {
        return f && f.nazwa && f.nazwa.length > 0;
      });

      var countySp = 0;
      var countyPrz = 0;
      var countyDk = 0;
      var countyUczniowieTotal = 0;
      var countyUczniowieSp = 0;
      var countyUczniowiePrz = 0;

      for (var p = 0; p < countyAll.length; p++) {
        var fp = countyAll[p];
        var studentsP = safeStudentCount(fp);

        if (fp.typ === "SP") {
          countySp++;
          countyUczniowieSp += studentsP;
        } else if (fp.typ === "PRZ") {
          countyPrz++;
          countyUczniowiePrz += studentsP;
        } else if (fp.typ === "DK") {
          countyDk++;
        }
        countyUczniowieTotal += studentsP;
      }

      callback([{
        key: "__powiat__",
        name: "Powiat " + powiatKey,
        gmina: "",
        center: countyCenter,
        total: countyAll.length,
        sp: countySp,
        prz: countyPrz,
        dk: countyDk,
        uczniowieTotal: countyUczniowieTotal,
        uczniowieSp: countyUczniowieSp,
        uczniowiePrz: countyUczniowiePrz,
        inRadius: countyAll.slice(),
      }], baseMeta);
      return;
    }

    var groups = {};
    for (var i = 0; i < located.length; i++) {
      var current = located[i];
      var city = (current.miejscowosc || "").trim();
      if (!city) continue;
      var key = city + "|" + (current.gmina || "");
      if (!groups[key]) {
        groups[key] = {
          key: key,
          name: city,
          gmina: current.gmina || "",
          members: [],
        };
      }
      groups[key].members.push(current);
    }

    var allGroups = Object.keys(groups).map(function (k) { return groups[k]; });
    if (allGroups.length === 0) {
      callback([], baseMeta);
      return;
    }

    var applyFilter = typeof Overpass.fetchUrbanPlaces === "function";
    if (!applyFilter) {
      console.warn("Overpass.fetchUrbanPlaces unavailable; fallback without city filter.");
      callback(computeCityRanking(allGroups, located, radiusKm), baseMeta);
      return;
    }

    Overpass.fetchUrbanPlaces(powiatKey, function (urbanErr, urbanNames) {
      if (urbanErr || !Array.isArray(urbanNames)) {
        console.warn("Nie udalo sie pobrac listy miast z OSM:", urbanErr ? urbanErr.message : "brak danych");
        callback(computeCityRanking(allGroups, located, radiusKm), baseMeta);
        return;
      }

      var urbanSet = new Set(
        urbanNames
          .map(placeNameKey)
          .filter(function (name) { return name.length > 0; })
      );
      var filteredGroups = allGroups.filter(function (g) {
        return urbanSet.has(placeNameKey(g.name));
      });
      var nonCityGroupsCount = Math.max(0, allGroups.length - filteredGroups.length);

      callback(computeCityRanking(filteredGroups, located, radiusKm), {
        cityFilterApplied: true,
        nonCityGroupsCount: nonCityGroupsCount,
        missingCoordsCount: baseMeta.missingCoordsCount,
      });
    });
  }

  function computeCityRanking(groups, located, radiusKm) {
    var cities = [];

    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var center = Geo.centroid(g.members);
      if (!center) continue;

      var inRadius = [];
      var sp = 0;
      var prz = 0;
      var dk = 0;
      var uczniowieTotal = 0;
      var uczniowieSp = 0;
      var uczniowiePrz = 0;

      for (var j = 0; j < located.length; j++) {
        var f = located[j];
        var d = Geo.haversineKm(center.lat, center.lon, f.lat, f.lon);
        if (d > radiusKm) continue;

        var students = safeStudentCount(f);
        inRadius.push(f);

        if (f.typ === "SP") {
          sp++;
          uczniowieSp += students;
        } else if (f.typ === "PRZ") {
          prz++;
          uczniowiePrz += students;
        } else if (f.typ === "DK") {
          dk++;
        }
        uczniowieTotal += students;
      }

      cities.push({
        key: g.key,
        name: g.name,
        gmina: g.gmina,
        center: center,
        total: inRadius.length,
        sp: sp,
        prz: prz,
        dk: dk,
        uczniowieTotal: uczniowieTotal,
        uczniowieSp: uczniowieSp,
        uczniowiePrz: uczniowiePrz,
        inRadius: inRadius,
      });
    }

    cities.sort(function (a, b) {
      if (b.uczniowieTotal !== a.uczniowieTotal) return b.uczniowieTotal - a.uczniowieTotal;
      if (b.total !== a.total) return b.total - a.total;
      if (b.sp !== a.sp) return b.sp - a.sp;
      return a.name.localeCompare(b.name, "pl");
    });
    return cities;
  }

  /* -----------------------------------------------------------------------
   * Rendering
   * --------------------------------------------------------------------- */

  function renderRanking(cities) {
    els.results.innerHTML = "";
    if (cities.length === 0) {
      els.results.textContent = "Brak wyników.";
      return;
    }
    cities.forEach(function (city, idx) {
      var card = document.createElement("div");
      card.className = "city-card";
      card.dataset.cityKey = city.key;

      var header = document.createElement("div");
      header.className = "city-card__header";
      header.innerHTML =
        "<div>" +
        '<div class="city-card__name">' +
          (idx + 1) +
          ". " +
          escapeHtml(city.name) +
          (city.gmina && city.gmina !== city.name
            ? ' <span style="color:#7b8794;font-weight:400;">' +
              "(" +
              escapeHtml(city.gmina) +
              ")" +
              "</span>"
            : "") +
        "</div>" +
        '<div class="city-card__breakdown">' +
          '<span class="uczniowie-sp">' + city.uczniowieSp + " ucz. SP</span> &middot; " +
          '<span class="uczniowie-prz">' + city.uczniowiePrz + " ucz. PRZ</span> &middot; " +
          '<span style="color:#7b8794;">' + city.sp + ' SP</span> &middot; ' +
          '<span style="color:#7b8794;">' + city.prz + ' PRZ</span>' +
          (city.dk > 0 ? ' &middot; <span style="color:#d97706;">' + city.dk + ' DK</span>' : '') +
        "</div>" +
        "</div>" +
        '<div class="city-card__count">' + city.uczniowieTotal + " ucz.</div>";

      header.addEventListener("click", (function (c) {
        return function () { selectCity(c.key); };
      })(city));
      card.appendChild(header);

      var body = document.createElement("div");
      body.className = "city-card__body";
      body.appendChild(buildFacilityList(city.inRadius));
      card.appendChild(body);

      els.results.appendChild(card);
    });
  }

  function buildFacilityList(facilities) {
    var ul = document.createElement("ul");
    ul.className = "facility-list";
    if (facilities.length === 0) {
      var empty = document.createElement("li");
      empty.textContent = "Brak placówek w promieniu.";
      ul.appendChild(empty);
      return ul;
    }
    var sorted = facilities.slice().sort(function (a, b) {
      if (a.typ !== b.typ) {
        if (a.typ === "SP") return -1;
        if (b.typ === "SP") return 1;
        if (a.typ === "PRZ") return -1;
        if (b.typ === "PRZ") return 1;
        return 0;
      }
      return (a.nazwa || "").localeCompare(b.nazwa || "", "pl");
    });
    sorted.forEach(function (f) {
      var li = document.createElement("li");
      var badge = document.createElement("span");
      badge.className = "type-badge " + f.typ;
      if (f.typ === "SP") badge.textContent = "SP";
      else if (f.typ === "PRZ") badge.textContent = "PRZ";
      else if (f.typ === "DK") badge.textContent = "DK";
      li.appendChild(badge);
      var wrap = document.createElement("div");
      var name = document.createElement("span");
      name.className = "facility-name";
      name.textContent = f.nazwa;
      wrap.appendChild(name);
      if (f.adres) {
        var addr = document.createElement("span");
        addr.className = "facility-addr";
        addr.textContent = f.adres;
        wrap.appendChild(addr);
      }
      if (f.uczniowie && f.uczniowie > 0) {
        var students = document.createElement("span");
        students.className = "facility-students";
        students.style.cssText = "color:#7b8794;font-size:11px;margin-left:6px;";
        students.textContent = f.uczniowie + " ucz.";
        wrap.appendChild(students);
      }
      li.appendChild(wrap);
      ul.appendChild(li);
    });
    return ul;
  }

  function selectCity(cityKey) {
    var city = null;
    for (var i = 0; i < state.currentCities.length; i++) {
      if (state.currentCities[i].key === cityKey) {
        city = state.currentCities[i];
        break;
      }
    }
    if (!city) return;
    state.activeCityKey = cityKey;

    var cards = els.results.querySelectorAll(".city-card");
    for (var j = 0; j < cards.length; j++) {
      var card = cards[j];
      if (card.dataset.cityKey === cityKey) {
        card.classList.add("active");
        card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } else {
        card.classList.remove("active");
      }
    }

    if (state.analysisMode === "county") {
      if (MapLayer.clearRadius) MapLayer.clearRadius();
      if (MapLayer.fitToFacilities && state.currentMappedFacilities.length > 0) {
        MapLayer.fitToFacilities(state.currentMappedFacilities);
      } else if (city.center) {
        MapLayer.focusOn(city.center.lat, city.center.lon, 10);
      }
      return;
    }

    MapLayer.drawRadius(city.center, state.currentRadiusKm);
    MapLayer.focusOn(city.center.lat, city.center.lon, 12);
  }

  function renderSuggestions(partial) {
    els.results.innerHTML = "";
    if (!partial) return;
    var all = Array.from(state.datalistKeys);
    var matches = all
      .filter(function (k) { return k.indexOf(partial) !== -1; })
      .slice(0, 12);
    if (matches.length === 0) return;
    var header = document.createElement("div");
    header.style.cssText = "padding:8px 10px 0;font-size:12px;color:#52606d;";
    header.textContent = "Może chodziło o:";
    els.results.appendChild(header);
    var ul = document.createElement("ul");
    ul.className = "suggestions";
    matches.forEach(function (m) {
      var li = document.createElement("li");
      li.textContent = m;
      li.addEventListener("click", function () {
        els.powiatInput.value = m;
        handleSearch();
      });
      ul.appendChild(li);
    });
    els.results.appendChild(ul);
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

  /* -----------------------------------------------------------------------
   * CSV Import Modal
   * --------------------------------------------------------------------- */

  /* Holds the raw text of the selected file until "Zaladuj dane" is clicked */
  var pendingCsvText = null;

  function openCsvModal() {
    if (!els.csvModal) return;
    pendingCsvText = null;
    if (els.csvFilename) els.csvFilename.textContent = "";
    if (els.csvDropzone) els.csvDropzone.classList.remove("has-file", "drag-over");
    if (els.csvLoadBtn) els.csvLoadBtn.disabled = true;
    if (els.csvFileInput) els.csvFileInput.value = "";
    if (els.csvParseStatus) { els.csvParseStatus.textContent = ""; els.csvParseStatus.className = "csv-modal__parse-status"; }
    els.csvModal.removeAttribute("hidden");
  }

  function closeCsvModal() {
    if (els.csvModal) els.csvModal.setAttribute("hidden", "");
    pendingCsvText = null;
    if (els.csvFilename) els.csvFilename.textContent = "";
    if (els.csvDropzone) els.csvDropzone.classList.remove("has-file");
    if (els.csvLoadBtn) els.csvLoadBtn.disabled = true;
    if (els.csvFileInput) els.csvFileInput.value = "";
    if (els.csvParseStatus) { els.csvParseStatus.textContent = ""; els.csvParseStatus.className = "csv-modal__parse-status"; }
  }

  function handleFileSelected(file) {
    if (!file) return;
    var name = file.name || "";
    if (els.csvFilename) els.csvFilename.textContent = name;
    setCsvStatus("Odczytywanie pliku...", "");
    var reader = new FileReader();
    reader.onload = function (e) {
      var text = e.target.result;
      /* Detect encoding issues — RSPO often exports in Windows-1250.
       * If TextDecoder is available, re-read as windows-1250; otherwise proceed as-is. */
      if (typeof TextDecoder !== "undefined" && text.indexOf("\uFFFD") !== -1) {
        var reader2 = new FileReader();
        reader2.onload = function (e2) {
          var decoded = new TextDecoder("windows-1250").decode(e2.target.result);
          setCsvStatus("Plik gotowy: " + name, "ok");
          pendingCsvText = decoded;
          if (els.csvDropzone) els.csvDropzone.classList.add("has-file");
          if (els.csvLoadBtn) els.csvLoadBtn.disabled = false;
        };
        reader2.readAsArrayBuffer(file);
      } else {
        setCsvStatus("Plik gotowy: " + name, "ok");
        pendingCsvText = text;
        if (els.csvDropzone) els.csvDropzone.classList.add("has-file");
        if (els.csvLoadBtn) els.csvLoadBtn.disabled = false;
      }
    };
    reader.onerror = function () { setCsvStatus("Blad odczytu pliku.", "err"); };
    reader.readAsText(file, "utf-8");
  }

  function importCsv() {
    var csv = (pendingCsvText || "").trim();
    if (!csv) {
      setCsvStatus("Najpierw wybierz lub upusc plik CSV.", "err");
      return;
    }

    var powiatInput = normalizePowiat(els.powiatInput.value || "");
    var result = parseCsvText(csv, powiatInput);

    if (result.error) {
      setCsvStatus("Blad parsowania: " + result.error, "err");
      return;
    }
    if (result.facilities.length === 0) {
      var errorMsg = "Nie znaleziono placowek typu Szkola podstawowa / Przedszkole w podanym CSV.";
      if (result.unknownTypes && result.unknownTypes.length > 0) {
        errorMsg += " Znalezione typy: " + result.unknownTypes.join(", ") + ".";
      }
      setCsvStatus(errorMsg, "err");
      return;
    }

    /* Inject into state (supports CSV containing multiple powiats) */
    var fallbackKey = result.powiatKey || powiatInput || "csv-import";
    var grouped = groupFacilitiesByPowiat(result.facilities, fallbackKey);
    var keys = Object.keys(grouped);
    if (keys.length === 0) keys = [fallbackKey];
    for (var g = 0; g < keys.length; g++) {
      state.byPowiat[keys[g]] = grouped[keys[g]] || result.facilities;
      state.datalistKeys.add(keys[g]);
    }
    rebuildDatalist();

    /* Set selected powiat after import */
    var selectedKey = (powiatInput && grouped[powiatInput]) ? powiatInput : keys[0];
    if (selectedKey && els.powiatInput) {
      els.powiatInput.value = selectedKey;
    }

    var statusMsg = "Zaladowano " + result.facilities.length + " placowek z CSV (" +
      result.sp + " SP, " + result.prz + " PRZ" +
      (result.dk ? ", " + result.dk + " DK" : "") +
      ", " + keys.length + " powiatow).";

    if (!result.hasStudents) {
      statusMsg += " Uwaga: brak kolumny 'Liczba uczniow' - uzyto srednich wartosci (SP=300, PRZ=100).";
    }

    if (!result.hasCoords) {
      statusMsg += " Uwaga: brak wspolrzednych geograficznych w CSV - po kliknieciu Szukaj aplikacja sprobuje uzupelnic je z OpenStreetMap i geokodowania adresow.";
    }

    statusMsg += " Mozesz teraz kliknac Szukaj.";

    var statusClass = (result.hasCoords) ? "ok" : "err";
    setCsvStatus(statusMsg, statusClass);

    console.log("Import result:", {
      facilitiesCount: result.facilities.length,
      sp: result.sp,
      prz: result.prz,
      hasStudents: result.hasStudents,
      hasCoords: result.hasCoords,
      sampleFacility: result.facilities[0]
    });

    /* Auto-close after short delay and trigger search */
    setTimeout(function () {
      closeCsvModal();
      if (!state.searching) handleSearch();
    }, 1200);
  }

  function setCsvStatus(msg, cls) {
    if (!els.csvParseStatus) return;
    els.csvParseStatus.textContent = msg;
    els.csvParseStatus.className = "csv-modal__parse-status" + (cls ? " " + cls : "");
  }

  /**
   * Minimal in-browser CSV parser for RSPO exports.
   * Handles semicolon-separated files with a header row.
   * Returns { facilities, powiatKey, sp, prz, error }.
   */
  function parseCsvText(text, defaultPowiatKey) {
    /* Strip UTF-8 BOM if present */
    if (text.charCodeAt(0) === 0xFEFF) {
      text = text.slice(1);
    }

    /* Normalise line endings */
    var lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    if (lines.length < 2) {
      return { error: "Plik zbyt krotki (wymagany naglowek + dane).", facilities: [] };
    }

    /* Detect separator */
    var sep = lines[0].indexOf(";") !== -1 ? ";" : ",";

    /* Normalise a header to: lower-case, no Polish diacritics, collapsed whitespace.
     * Helps when headers have stray spaces, casing or accented chars. */
    function normHeader(h) {
      return (h || "")
        .replace(/^\uFEFF/, "")
        .toLowerCase()
        .replace(/[\u0105\u0104]/g, "a")
        .replace(/[\u0107\u0106]/g, "c")
        .replace(/[\u0119\u0118]/g, "e")
        .replace(/[\u0142\u0141]/g, "l")
        .replace(/[\u0144\u0143]/g, "n")
        .replace(/[\u00F3\u00D3]/g, "o")
        .replace(/[\u015B\u015A]/g, "s")
        .replace(/[\u017A\u0179]/g, "z")
        .replace(/[\u017C\u017B]/g, "z")
        .replace(/\s+/g, " ")
        .trim();
    }

    var header = splitCsvLine(lines[0], sep).map(normHeader);

    /* Column detection: exact match first, then substring fallback so
     * variants like "liczba uczniow/wychowankow" or "szerokosc geogr."
     * still get recognised. */
    function findCol(candidates) {
      var normCands = candidates.map(normHeader);
      /* 1. Exact header match */
      for (var i = 0; i < normCands.length; i++) {
        var idx = header.indexOf(normCands[i]);
        if (idx !== -1) return idx;
      }
      /* 2. Substring match (either direction) */
      for (var j = 0; j < normCands.length; j++) {
        var needle = normCands[j];
        for (var k = 0; k < header.length; k++) {
          if (header[k].indexOf(needle) !== -1) return k;
        }
      }
      return -1;
    }

    var COL = {
      rspo:     findCol(["numer rspo", "rspo", "numer rsip"]),
      nazwa:    findCol(["nazwa placowki", "nazwa podmiotu", "nazwa"]),
      typ:      findCol(["typ podmiotu", "typ placowki", "rodzaj placowki", "typ"]),
      miej:     findCol(["miejscowosc", "miasto"]),
      gmina:    findCol(["gmina"]),
      powiat:   findCol(["powiat"]),
      woj:      findCol(["wojewodztwo"]),
      ulica:    findCol(["ulica", "adres"]),
      nr:       findCol(["numer budynku", "nr budynku", "numer", "nr"]),
      kod:      findCol(["kod pocztowy", "kod"]),
      lat:      findCol(["szerokosc geograficzna", "latitude", "lat", "szerokosc"]),
      lon:      findCol(["dlugosc geograficzna", "longitude", "lon", "dlugosc"]),
      /* Combined "Współrzędne geograficzne" column (e.g. "49.97, 19.82") */
      wsp:      findCol(["wspolrzedne geograficzne", "wspolrzedne", "coordinates", "geo"]),
      uczniowie: findCol([
        "liczba uczniow/wychowankow",
        "liczba uczniow i wychowankow",
        "ogolna liczba uczniow",
        "ogolna liczba dzieci",
        "liczba uczniow",
        "liczba dzieci",
        "liczba wychowankow",
        "uczniowie",
        "students",
      ]),
    };

    /* If combined column was matched as lat/lon (same index), null them out;
     * we'll use COL.wsp instead. */
    if (COL.wsp !== -1 && COL.wsp === COL.lat && COL.wsp === COL.lon) {
      COL.lat = -1;
      COL.lon = -1;
    }

    if (COL.nazwa === -1 || COL.typ === -1) {
      return {
        error:
          "Nie znaleziono kolumn 'Nazwa' i 'Typ'. Dostepne naglowki: " +
          header.join(", ") +
          ". Upewnij sie, ze CSV ma naglowki z nazwami kolumn.",
        facilities: [],
      };
    }

    /* Debug: log column detection */
    console.log("CSV Columns detected:", {
      typ: COL.typ,
      typValue: header[COL.typ],
      nazwa: COL.nazwa,
      nazwaValue: header[COL.nazwa],
      allHeaders: header
    });

    var WANTED = {
      /* Direct match with polish chars */
      "szkoła podstawowa": "SP",
      "przedszkole": "PRZ",
      "dom kultury": "DK",
      /* After NFD normalization (polish chars removed) */
      "szkola podstawowa": "SP",
      "przedszkole": "PRZ",
      "przedszkole publiczne": "PRZ",
      "szkola": "SP",
      "publiczna szkola podstawowa": "SP",
      "publiczne przedszkole": "PRZ",
      "samorzadowa szkola podstawowa": "SP",
      "samorzadowe przedszkole": "PRZ",
    };

    var facilities = [];
    var sp = 0, prz = 0, dk = 0;
    var detectedPowiatKey = defaultPowiatKey;
    var unknownTypes = {}; /* Track types we skip for debugging */
    var debugCount = 0;   /* Log first few rows for debugging */
    var hasCoordsColumns = (COL.lat !== -1 && COL.lon !== -1) || COL.wsp !== -1;

    /* Defaults applied when no student-count column is present.
     * Approx. Polish averages so ranking is meaningful even without SIO data. */
    var DEFAULT_UCZNIOWIE_SP = 300;
    var DEFAULT_UCZNIOWIE_PRZ = 100;
    var hasStudents = COL.uczniowie !== -1;

    console.log("Starting CSV parsing, total lines:", lines.length, "Has coord columns:", hasCoordsColumns, "Has students:", hasStudents);

    for (var i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      var cells = splitCsvLine(lines[i], sep).map(cleanCsvCell);

      var typRaw = (cells[COL.typ] || "").trim();
      var typNormalized = typRaw.toLowerCase()
        .replace(/[\u0105\u0104]/g, "a")  /* ą, Ą */
        .replace(/[\u0107\u0106]/g, "c")  /* ć, Ć */
        .replace(/[\u0119\u0118]/g, "e")  /* ę, Ę */
        .replace(/[\u0142\u0141]/g, "l")  /* ł, Ł */
        .replace(/[\u0144\u0143]/g, "n")  /* ń, Ń */
        .replace(/[\u00F3\u00D3]/g, "o")  /* ó, Ó */
        .replace(/[\u015B\u015A]/g, "s")  /* ś, Ś */
        .replace(/[\u017A\u0179]/g, "z")  /* ź, Ź */
        .replace(/[\u017C\u017B]/g, "z")  /* ż, Ż */
        .replace(/\s+/g, " ").trim();

      var typCode = WANTED[typNormalized];

      /* Fallback: check if type contains key words (without special chars) */
      if (!typCode) {
        if (typNormalized.indexOf("szkola") !== -1 && typNormalized.indexOf("podstawowa") !== -1) {
          typCode = "SP";
        } else if (typNormalized.indexOf("przedszkole") !== -1) {
          typCode = "PRZ";
        } else if (typNormalized.indexOf("dom") !== -1 && typNormalized.indexOf("kultury") !== -1) {
          typCode = "DK";
        } else {
          /* Track unknown types for debugging - show both original and normalized */
          var debugKey = typRaw + " -> " + typNormalized;
          if (!unknownTypes[debugKey]) unknownTypes[debugKey] = 0;
          unknownTypes[debugKey]++;
          if (debugCount < 5) {
            console.log("Unknown type rejected:", debugKey);
            debugCount++;
          }
          continue;
        }
      }

      /* Debug: log successful type matching for first few rows */
      if (debugCount < 5) {
        console.log("Row " + i + " SUCCESS:", {
          typRaw: typRaw,
          typCode: typCode,
          nazwaRaw: cells[COL.nazwa]
        });
        debugCount++;
      }

      var lat = null;
      var lon = null;
      if (COL.lat !== -1 && COL.lon !== -1 && COL.lat !== COL.lon) {
        lat = parseFloat((cells[COL.lat] || "").trim().replace(",", "."));
        lon = parseFloat((cells[COL.lon] || "").trim().replace(",", "."));
        if (isNaN(lat) || isNaN(lon)) { lat = null; lon = null; }
      } else if (COL.wsp !== -1) {
        /* Combined column, e.g. "49.9762, 19.8220" or "49.9762 19.8220" */
        var raw = (cells[COL.wsp] || "").trim();
        /* Extract first two numbers (handles "49,97 19,82" European commas too
         * by first replacing commas between digits with dots). */
        var parts = raw.split(/[\s,;]+/).filter(function (p) { return p.length > 0; });
        /* If we got exactly 2 pieces, straightforward. Otherwise try pairing
         * first + second numeric token. */
        if (parts.length >= 2) {
          var a = parseFloat(parts[0].replace(",", "."));
          var b = parseFloat(parts[1].replace(",", "."));
          if (!isNaN(a) && !isNaN(b)) { lat = a; lon = b; }
        }
      }

      var powiatRaw = COL.powiat !== -1 ? (cells[COL.powiat] || "").trim() : "";
      if (!detectedPowiatKey && powiatRaw) {
        detectedPowiatKey = Overpass.powiatKey(powiatRaw);
      }

      var miejscowosc = COL.miej !== -1 ? (cells[COL.miej] || "").trim() : "";
      var gmina = COL.gmina !== -1 ? (cells[COL.gmina] || "").trim() : "";

      /* Build address */
      var addrParts = [];
      if (COL.ulica !== -1 && cells[COL.ulica]) {
        var s = cells[COL.ulica].trim();
        var n = COL.nr !== -1 ? (cells[COL.nr] || "").trim() : "";
        addrParts.push(n ? s + " " + n : s);
      }
      var kodCity = [];
      if (COL.kod !== -1 && cells[COL.kod]) kodCity.push(cells[COL.kod].trim());
      if (miejscowosc) kodCity.push(miejscowosc);
      if (kodCity.length) addrParts.push(kodCity.join(" "));

      var uczniowie = 0;
      if (hasStudents) {
        var uczniowieRaw = (cells[COL.uczniowie] || "").trim().replace(/\s/g, "");
        uczniowie = parseInt(uczniowieRaw, 10);
        if (isNaN(uczniowie)) uczniowie = 0;
      }
      /* When the CSV has no student-count column, fall back to type-based
       * averages so the ranking and badges are not all zeros. */
      if (uczniowie <= 0 && !hasStudents) {
        if (typCode === "SP") uczniowie = DEFAULT_UCZNIOWIE_SP;
        else if (typCode === "PRZ") uczniowie = DEFAULT_UCZNIOWIE_PRZ;
        else uczniowie = 0;
      }

      var facility = {
        rspo: COL.rspo !== -1 ? (cells[COL.rspo] || "").trim() : "",
        nazwa: (cells[COL.nazwa] || "").trim(),
        typ: typCode,
        miejscowosc: miejscowosc,
        gmina: gmina,
        powiat: powiatRaw,
        powiat_key: Overpass.powiatKey(powiatRaw) || detectedPowiatKey || defaultPowiatKey,
        wojewodztwo: COL.woj !== -1 ? (cells[COL.woj] || "").trim() : "",
        adres: addrParts.join(", "),
        lat: lat,
        lon: lon,
        uczniowie: uczniowie,
      };

      /* Filter out rows without name */
      if (!facility.nazwa || facility.nazwa.length === 0 || facility.nazwa === "(brak nazwy)") continue;

      /* Debug: log facilities without coordinates */
      if (debugCount < 10 && (facility.lat === null || facility.lon === null)) {
        console.log("Row " + i + " skipped (no coords):", facility.nazwa);
        debugCount++;
      }

      /* Allow facilities without coordinates for ranking purposes */
      facilities.push(facility);
      if (typCode === "SP") sp++;
      else if (typCode === "PRZ") prz++;
      else if (typCode === "DK") dk++;
    }

    /* Build helpful error message if no facilities found */
    var unknownTypeList = Object.keys(unknownTypes);
    var errorHint = "";
    if (facilities.length === 0 && unknownTypeList.length > 0) {
      errorHint = " Znalezione typy placowek w CSV: " + unknownTypeList.join(", ") + ". " +
        "Szukane typy: 'Szkoła podstawowa', 'Przedszkole'. " +
        "Upewnij sie, ze w CSV sa tylko te typy lub dodaj ich warianty.";
    } else if (facilities.length === 0) {
      var rowCount = lines.length - 1;
      errorHint = " CSV ma " + rowCount + " wierszy (bez naglowka). " +
        "Mozliwe, ze nie ma wierszy z typami 'Szkoła podstawowa' lub 'Przedszkole'. " +
        "Dostepne typy w pliku: " + (unknownTypeList.length > 0 ? unknownTypeList.join(", ") : "brak");
    }

    var hasCoords = facilities.some(function (f) { return hasCoordsColumns && f.lat != null && f.lon != null; });

    if (facilities.length > 0 && !hasCoords) {
      /* This is just a warning, not a critical error */
      console.log("Warning: CSV imported but has no coordinates");
    }

    return {
      facilities: facilities,
      powiatKey: detectedPowiatKey,
      sp: sp,
      prz: prz,
      dk: dk,
      hasStudents: COL.uczniowie !== -1,
      hasCoords: hasCoords,
      unknownTypes: unknownTypeList,
      error: null /* Don't treat missing coords as error */
    };
  }

  /**
   * Split a single CSV line respecting quoted fields.
   */
  function splitCsvLine(line, sep) {
    var result = [];
    var cur = "";
    var inQuote = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === sep && !inQuote) {
        result.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    result.push(cur);
    return result;
  }

  function cleanCsvCell(value) {
    var out = value == null ? "" : String(value).trim();
    /* Excel-like exports can store plain values as formulas, e.g. ="20-785". */
    out = out.replace(/^\s*=\s*/, "");
    if (out.length >= 2) {
      var first = out.charAt(0);
      var last = out.charAt(out.length - 1);
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        out = out.slice(1, -1).trim();
      }
    }
    return out;
  }
})();
