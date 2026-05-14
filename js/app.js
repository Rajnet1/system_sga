/* Main app: load data, handle search form, build ranking, wire UI.
 *
 * Data flow:
 *  1. CSV import (drag-and-drop/file picker) — adresy geokodowane przez Nominatim
 *  2. Overpass API (OpenStreetMap, live, fetched in-browser, cached 24h)
 *
 * Powiat autocomplete:
 *  - Overpass powiat list (async, cached 7 days)
 */
(function () {
  "use strict";

  var state = {
    byPowiat: {},         /* powiat_key -> [facility, ...] (CSV import or Overpass) */
    currentCities: [],    /* ranking for last search */
    currentMappedFacilities: [], /* last rendered facilities with coordinates */
    currentRadiusKm: 5,
    analysisMode: "cities", /* cities | county — ustawiany auto po imporcie CSV */
    activeCityKey: null,
    searching: false,
  };

  var GOOGLE_DK_CACHE_PREFIX = "google_dk_v1_";
  var GOOGLE_DK_TTL = 7 * 86400 * 1000;
  var GOOGLE_DK_QUERIES = ["dom kultury", "ośrodek kultury", "centrum kultury", "biblioteka publiczna"];

  var els = {};

  document.addEventListener("DOMContentLoaded", function () {
    els.form        = document.getElementById("search-form");
    els.powiatInput = document.getElementById("powiat-input");
    els.radiusInput = document.getElementById("radius-input");
    els.status      = document.getElementById("status");
    els.results     = document.getElementById("results");
    els.submitBtn   = document.getElementById("submit-btn");
    els.csvInfo     = document.getElementById("csv-info");
    els.csvImportBtn  = document.getElementById("csv-import-btn");
    els.csvModal      = document.getElementById("csv-modal");
    els.csvModalClose = document.getElementById("csv-modal-close");
    els.csvDropzone   = document.getElementById("csv-dropzone");
    els.csvFileInput  = document.getElementById("csv-file-input");
    els.csvFilename   = document.getElementById("csv-filename");
    els.csvParseStatus = document.getElementById("csv-parse-status");
    els.csvLoadBtn    = document.getElementById("csv-load-btn");
    els.csvCancelBtn  = document.getElementById("csv-cancel-btn");
    els.googleApiKey  = document.getElementById("google-api-key");
    els.saveApiKeyBtn = document.getElementById("save-api-key-btn");

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

    /* Google API key — check server on load, save via POST /api/key */
    fetch("/api/key-status")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.hasKey && els.googleApiKey) {
          els.googleApiKey.placeholder = "Klucz zapisany (wpisz nowy by zmienić)";
        }
      })
      .catch(function () { /* running outside Go server — ignore */ });

    if (els.saveApiKeyBtn) {
      els.saveApiKeyBtn.addEventListener("click", function () {
        var key = (els.googleApiKey ? els.googleApiKey.value : "").trim();
        if (!key) return;
        fetch("/api/key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key }),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.ok) {
              if (els.googleApiKey) {
                els.googleApiKey.value = "";
                els.googleApiKey.placeholder = "Klucz zapisany (wpisz nowy by zmienić)";
              }
              setStatus("Klucz Google Places API zapisany.");
            }
          })
          .catch(function () { setStatus("Błąd zapisu klucza.", true); });
      });
    }

    setStatus("Wgraj plik CSV z RSPO aby rozpocząć wyszukiwanie.");
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
      /* Keep button disabled if no CSV loaded yet (powiatInput empty) */
      els.submitBtn.disabled = loading || !els.powiatInput.value;
      els.submitBtn.textContent = loading ? "Ładowanie..." : "Szukaj";
    }
  }

  /* -----------------------------------------------------------------------
   * Data loading
   * --------------------------------------------------------------------- */

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

  /* -----------------------------------------------------------------------
   * Search handler
   * --------------------------------------------------------------------- */

  function handleSearch() {
    var rawPowiat = els.powiatInput.value;
    var powiatKey = Overpass.powiatKey(rawPowiat);
    var radiusKm = parseFloat(els.radiusInput.value);

    if (!powiatKey) {
      setStatus("Wgraj plik CSV z RSPO aby rozpocząć wyszukiwanie.", true);
      return;
    }
    if (!radiusKm || radiusKm <= 0) {
      setStatus("Promień musi być dodatni.", true);
      return;
    }

    state.currentRadiusKm = radiusKm;
    /* state.analysisMode jest ustawiany automatycznie podczas importu CSV */

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
          var localSource = "CSV";
          if (invalidated > 0) localSource += " (skorygowano " + invalidated + " poza granica powiatu)";
          processAndRenderWithDk(localFacilities, powiatKey, radiusKm, localSource);
          return;
        }

        /* Local data is partially/fully without coordinates — enrich from OSM. */
        setLoading(true);
        setStatus("Uzupelniam brakujace wspolrzedne z OpenStreetMap...");
        els.results.innerHTML = "";
        MapLayer.clear();

        Overpass.fetchFacilities(powiatKey, function (err, osmFacilities) {
          if (err || !osmFacilities || osmFacilities.length === 0) {
            setStatus("Uzupelniam wspolrzedne ze srodkow miejscowosci OSM...");
            fillMissingFromPlaceCenters(localFacilities, powiatKey, function (finalFacilities, placeMeta) {
              setLoading(false);
              state.byPowiat[powiatKey] = finalFacilities;
              var sourceFallback = "CSV + miejscowosci OSM";
              if (placeMeta && placeMeta.resolved > 0) {
                sourceFallback += " (" + placeMeta.resolved + " uzupelnionych)";
              }
              processAndRenderWithDk(finalFacilities, powiatKey, radiusKm, sourceFallback);
            });
            return;
          }

          var merged = mergeCoordsByName(localFacilities, osmFacilities);
          var missingAfterMerge = countMissingCoords(merged);
          if (missingAfterMerge === 0) {
            setLoading(false);
            state.byPowiat[powiatKey] = merged;
            processAndRenderWithDk(merged, powiatKey, radiusKm, "CSV + OpenStreetMap (uzupelnione wspolrzedne)");
            return;
          }

          setStatus(
            "Dopasowano czesc placowek w OSM. Uzupelniam pozostale ze srodkow miejscowosci (" +
              missingAfterMerge +
              ")..."
          );

          fillMissingFromPlaceCenters(merged, powiatKey, function (finalMerged, placeMeta2) {
            setLoading(false);
            state.byPowiat[powiatKey] = finalMerged;
            var source = "CSV + OpenStreetMap";
            if (placeMeta2 && placeMeta2.resolved > 0) {
              source += " + miejscowosci OSM (" + placeMeta2.resolved + ")";
            }
            processAndRenderWithDk(finalMerged, powiatKey, radiusKm, source);
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
        return;
      }
      if (!facilities || facilities.length === 0) {
        setStatus(
          "Nie znaleziono placówek dla powiatu \"" + powiatKey + "\". Sprawdź pisownię.",
          true
        );
        return;
      }

      state.byPowiat[powiatKey] = facilities;
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

  /* -----------------------------------------------------------------------
   * Google Places API — DK via local server proxy (/api/places)
   * --------------------------------------------------------------------- */

  function extractCityFromGoogleAddress(addr) {
    if (!addr) return "";
    var m = addr.match(/\b\d{2}-\d{3}\s+([^,]+)/);
    if (m) return m[1].trim();
    var parts = addr.split(",").map(function (p) { return p.trim(); });
    if (parts.length >= 2) {
      var last = parts[parts.length - 1];
      if (/^polska$/i.test(last)) parts.pop();
      if (parts.length >= 1) return parts[parts.length - 1];
    }
    return "";
  }

  function fetchDkFromGoogle(powiatKey, bounds, callback) {
    if (!bounds) { callback(null, []); return; }

    var cacheKey = GOOGLE_DK_CACHE_PREFIX + powiatKey;
    try {
      var raw = localStorage.getItem(cacheKey);
      if (raw) {
        var obj = JSON.parse(raw);
        if (Date.now() - obj.ts < GOOGLE_DK_TTL) { callback(null, obj.data); return; }
      }
    } catch (e) { /* ignore */ }

    var centerLat = (bounds.minlat + bounds.maxlat) / 2;
    var centerLon = (bounds.minlon + bounds.maxlon) / 2;
    var radiusM = Math.min(
      50000,
      Math.round(Geo.haversineKm(bounds.minlat, bounds.minlon, bounds.maxlat, bounds.maxlon) * 500)
    );
    var location = centerLat + "," + centerLon;

    var allResults = {};
    var remaining = GOOGLE_DK_QUERIES.length;

    function onQueryDone() {
      remaining--;
      if (remaining > 0) return;
      var list = Object.keys(allResults).map(function (id) { return allResults[id]; });
      try { localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: list })); } catch (e) {}
      callback(null, list);
    }

    GOOGLE_DK_QUERIES.forEach(function (query) {
      var qs = "query=" + encodeURIComponent(query) +
               "&location=" + encodeURIComponent(location) +
               "&radius=" + encodeURIComponent(String(radiusM));
      fetch("/api/places?" + qs)
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.status === "OK" || data.status === "ZERO_RESULTS") {
            (data.results || []).forEach(function (place) {
              if (!place.place_id || !place.geometry) return;
              if (/świetlic/i.test(place.name || "")) return;
              var city = extractCityFromGoogleAddress(place.formatted_address || "");
              allResults[place.place_id] = {
                rspo: "g_" + place.place_id,
                nazwa: place.name || "",
                typ: "DK",
                miejscowosc: city,
                gmina: "",
                powiat: powiatKey,
                powiat_key: powiatKey,
                adres: place.formatted_address || "",
                lat: place.geometry.location.lat,
                lon: place.geometry.location.lng,
                uczniowie: 0,
              };
            });
          }
          onQueryDone();
        })
        .catch(function () { onQueryDone(); });
    });
  }

  /**
   * Fetch DK from Google Places proxy and merge into facilities list.
   */
  function processAndRenderWithDk(facilities, powiatKey, radiusKm, source) {
    setStatus("Pobieranie domów kultury z Google Maps...");
    Overpass.fetchPowiatBounds(powiatKey, function (err, bounds) {
      fetchDkFromGoogle(powiatKey, bounds, function (gErr, googleDk) {
        var merged = facilities;
        if (!gErr && Array.isArray(googleDk) && googleDk.length > 0) {
          var existingDkNames = {};
          for (var i = 0; i < facilities.length; i++) {
            if (facilities[i].typ === "DK") {
              existingDkNames[normName(facilities[i].nazwa)] = true;
            }
          }
          var cityGminaMap = {};
          for (var j = 0; j < facilities.length; j++) {
            var f = facilities[j];
            var ck = normAddrKey(f.miejscowosc || "");
            if (ck && f.gmina && !cityGminaMap[ck]) cityGminaMap[ck] = f.gmina;
          }
          var newDk = googleDk.filter(function (dk) {
            return !existingDkNames[normName(dk.nazwa)];
          });
          newDk.forEach(function (dk) {
            if (!dk.gmina && dk.miejscowosc) {
              var ck = normAddrKey(dk.miejscowosc);
              if (cityGminaMap[ck]) dk.gmina = cityGminaMap[ck];
            }
          });
          if (newDk.length > 0) {
            merged = facilities.concat(newDk);
            source = source + " + " + newDk.length + " DK z Google Maps";
          }
        }
        processAndRender(merged, powiatKey, radiusKm, source);
      });
    });
  }

  function processAndRender(facilities, powiatKey, radiusKm, source) {
    buildRanking(facilities, radiusKm, powiatKey, state.analysisMode, function (cities, meta) {
      state.currentCities = cities;
      state.activeCityKey = null;
      state.currentMappedFacilities = facilities.filter(function (f) { return hasCoords(f); });

      var mappedCount = state.currentMappedFacilities.length;
      var modeLabel = state.analysisMode === "county"
        ? "powiat jako całość"
        : "miejscowości w powiecie";
      var scopeLabel = state.analysisMode === "county"
        ? "cale terytorium powiatu"
        : "promien " + radiusKm + " km";
      var cityFilterNote = "";
      if (state.analysisMode === "cities" && meta) {
        if (meta.cityFilterApplied) {
          cityFilterNote =
            " | tylko miejscowosci OSM (" +
            meta.nonCityGroupsCount +
            " poza filtrem)";
        } else {
          cityFilterNote = " | filtr miejscowosci tymczasowo niedostepny";
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
      /* Normalize key to prevent duplicates when CSV and OSM data differ in:
       * - casing of city name ("Kraków" vs "kraków")
       * - gmina presence (CSV has gmina, OSM DK often doesn't)
       * We group purely by normalized city name; gmina stored for display only. */
      var cityNorm = normAddrKey(city);
      if (!groups[cityNorm]) {
        groups[cityNorm] = {
          key: cityNorm,
          name: city,
          gmina: current.gmina || "",
          members: [],
        };
      } else {
        /* Prefer non-empty gmina and proper-cased name from CSV */
        if (!groups[cityNorm].gmina && current.gmina) {
          groups[cityNorm].gmina = current.gmina;
        }
        if (!groups[cityNorm].name || (current.gmina && !groups[cityNorm].gmina)) {
          groups[cityNorm].name = city;
        }
      }
      groups[cityNorm].members.push(current);
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

      /* Skip cities with no schools or kindergartens in radius */
      if (sp === 0 && prz === 0) continue;

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

    var result = parseCsvText(csv);

    if (result.error) {
      setCsvStatus("Blad parsowania: " + result.error, "err");
      return;
    }
    if (result.facilities.length === 0) {
      var errorMsg = "Nie znaleziono placowek typu Szkola podstawowa / Przedszkole / Dom kultury w podanym CSV.";
      if (result.unknownTypes && result.unknownTypes.length > 0) {
        errorMsg += " Znalezione typy: " + result.unknownTypes.join(", ") + ".";
      }
      setCsvStatus(errorMsg, "err");
      return;
    }

    /* Inject into state — group by powiat */
    var fallbackKey = result.powiatKey || "csv-import";
    var grouped = groupFacilitiesByPowiat(result.facilities, fallbackKey);
    var keys = Object.keys(grouped);
    if (keys.length === 0) keys = [fallbackKey];
    for (var g = 0; g < keys.length; g++) {
      state.byPowiat[keys[g]] = grouped[keys[g]] || result.facilities;
    }

    /* Set powiat key into hidden input */
    var selectedKey = keys[0];
    els.powiatInput.value = selectedKey;

    /* Auto-detect mode: county when only 1 unique city, cities otherwise */
    var facilitiesForPowiat = state.byPowiat[selectedKey] || result.facilities;
    var uniqueCities = new Set();
    for (var u = 0; u < facilitiesForPowiat.length; u++) {
      var uc = normAddrKey(facilitiesForPowiat[u].miejscowosc || "");
      if (uc) uniqueCities.add(uc);
    }
    state.analysisMode = uniqueCities.size <= 1 ? "county" : "cities";

    /* Show province/powiat info strip */
    var wojList = result.wojewodztwa && result.wojewodztwa.length > 0
      ? result.wojewodztwa.map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); })
      : [];
    var infoText = wojList.length > 0
      ? "woj. " + wojList.join(", ") + " • powiat " + selectedKey
      : "powiat " + selectedKey;
    if (keys.length > 1) infoText += " (+" + (keys.length - 1) + " inne)";
    els.csvInfo.textContent = infoText;
    els.csvInfo.removeAttribute("hidden");

    /* Enable search button */
    els.submitBtn.disabled = false;

    var statusMsg = "Zaladowano " + result.facilities.length + " placowek z CSV (" +
      result.sp + " SP, " + result.prz + " PRZ, " + (result.dk || 0) + " DK). " +
      "Tryb: " + (state.analysisMode === "county" ? "całość bez podziału" : "ranking miast") + ".";

    if (!result.hasStudents) {
      statusMsg += " Brak kolumny uczniow — uzyte wartosci domyslne.";
    }

    var statusClass = result.hasCoords ? "ok" : "err";
    setCsvStatus(statusMsg, statusClass);

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
   * Returns { facilities, powiatKey, wojewodztwa, sp, prz, dk, error }.
   */
  function parseCsvText(text) {
    var defaultPowiatKey = "";
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

    var WANTED = {
      /* SP */
      "szkoła podstawowa": "SP",
      "szkola podstawowa": "SP",
      "publiczna szkola podstawowa": "SP",
      "samorzadowa szkola podstawowa": "SP",
      "szkola": "SP",
      /* PRZ */
      "przedszkole": "PRZ",
      "przedszkole publiczne": "PRZ",
      "publiczne przedszkole": "PRZ",
      "samorzadowe przedszkole": "PRZ",
      /* DK — wszystkie warianty RSPO */
      "dom kultury": "DK",
      "dom i osrodek kultury": "DK",
      "osrodek kultury": "DK",
      "centrum kultury": "DK",
      "instytucja kultury": "DK",
      "miejski osrodek kultury": "DK",
      "gminny osrodek kultury": "DK",
      "gminne centrum kultury": "DK",
      "miejskie centrum kultury": "DK",
      "biblioteka": "DK",
      "biblioteka publiczna": "DK",
    };

    var facilities = [];
    var sp = 0, prz = 0, dk = 0;
    var detectedPowiatKey = defaultPowiatKey;
    var uniqueWoj = {};   /* Track unique województwa */
    var unknownTypes = {}; /* Track types we skip for debugging */
    var debugCount = 0;   /* Log first few rows for debugging */
    var hasCoordsColumns = (COL.lat !== -1 && COL.lon !== -1) || COL.wsp !== -1;

    /* Defaults applied when no student-count column is present.
     * Approx. Polish averages so ranking is meaningful even without SIO data. */
    var DEFAULT_UCZNIOWIE_SP = 300;
    var DEFAULT_UCZNIOWIE_PRZ = 100;
    var hasStudents = COL.uczniowie !== -1;

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
        } else if (
          (typNormalized.indexOf("dom") !== -1 && typNormalized.indexOf("kultury") !== -1) ||
          (typNormalized.indexOf("osrodek") !== -1 && typNormalized.indexOf("kultury") !== -1) ||
          (typNormalized.indexOf("centrum") !== -1 && typNormalized.indexOf("kultury") !== -1) ||
          typNormalized.indexOf("instytucja kultury") !== -1
        ) {
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

      var wojRaw = COL.woj !== -1 ? (cells[COL.woj] || "").trim() : "";
      if (wojRaw) uniqueWoj[wojRaw.toUpperCase()] = true;

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
      wojewodztwa: Object.keys(uniqueWoj),
      sp: sp,
      prz: prz,
      dk: dk,
      hasStudents: COL.uczniowie !== -1,
      hasCoords: hasCoords,
      unknownTypes: unknownTypeList,
      error: null
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
