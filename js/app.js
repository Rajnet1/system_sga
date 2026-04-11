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
    currentRadiusKm: 5,
    activeCityKey: null,
    searching: false,
  };

  var els = {};

  document.addEventListener("DOMContentLoaded", function () {
    els.form = document.getElementById("search-form");
    els.powiatInput = document.getElementById("powiat-input");
    els.radiusInput = document.getElementById("radius-input");
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

    if (!powiatKey) {
      setStatus("Wpisz nazwę powiatu.", true);
      return;
    }
    if (!radiusKm || radiusKm <= 0) {
      setStatus("Promień musi być dodatni.", true);
      return;
    }

    state.currentRadiusKm = radiusKm;

    /* If we have local data for this powiat, use it immediately.
     * BUT: if none of the local facilities have coordinates (e.g. CSV import
     * without lat/lon), fall back to Overpass to get coords and merge them in
     * so schools can be plotted on the map. */
    var localFacilities = state.byPowiat[powiatKey];
    if (localFacilities && localFacilities.length > 0) {
      var withCoords = 0;
      for (var i = 0; i < localFacilities.length; i++) {
        if (localFacilities[i].lat != null && localFacilities[i].lon != null) withCoords++;
      }
      if (withCoords > 0) {
        processAndRender(localFacilities, powiatKey, radiusKm, "lokalna baza RSPO");
        return;
      }

      /* Local data exists but has no coordinates — enrich with Overpass geo */
      setLoading(true);
      setStatus("Placowki z CSV bez wspolrzednych - pobieram pozycje z OpenStreetMap...");
      els.results.innerHTML = "";
      MapLayer.clear();

      Overpass.fetchFacilities(powiatKey, function (err, osmFacilities) {
        setLoading(false);
        if (err || !osmFacilities || osmFacilities.length === 0) {
          /* Fallback: still render ranking without map markers */
          setStatus(
            "Brak wspolrzednych w CSV i nie mozna pobrac z OSM (" +
              (err ? err.message : "brak wynikow") +
              "). Wyswietlam ranking bez mapy.",
            true
          );
          processAndRender(localFacilities, powiatKey, radiusKm, "CSV (bez wspolrzednych)");
          return;
        }
        var merged = mergeCoordsByName(localFacilities, osmFacilities);
        state.byPowiat[powiatKey] = merged;
        processAndRender(merged, powiatKey, radiusKm, "CSV + OpenStreetMap (wspolrzedne)");
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

  /**
   * Merge coordinates from OSM facilities into local facilities by matching
   * normalised names (with miejscowosc as tiebreaker). Any local facility
   * without a match keeps lat/lon=null and will be skipped by the map layer,
   * but still contributes to the ranking.
   */
  function mergeCoordsByName(local, osm) {
    var byName = {};
    osm.forEach(function (o) {
      if (o.lat == null || o.lon == null) return;
      var key = normName(o.nazwa);
      if (!key) return;
      if (!byName[key]) byName[key] = [];
      byName[key].push(o);
    });

    var matched = 0;
    var out = local.map(function (f) {
      if (f.lat != null && f.lon != null) return f;
      var key = normName(f.nazwa);
      var candidates = byName[key] || [];
      /* If multiple candidates, prefer same miejscowosc */
      var pick = null;
      if (candidates.length === 1) {
        pick = candidates[0];
      } else if (candidates.length > 1) {
        var targetMiej = (f.miejscowosc || "").toLowerCase();
        for (var i = 0; i < candidates.length; i++) {
          if ((candidates[i].miejscowosc || "").toLowerCase() === targetMiej) {
            pick = candidates[i];
            break;
          }
        }
        if (!pick) pick = candidates[0];
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
    var cities = buildRanking(facilities, radiusKm);
    state.currentCities = cities;
    state.activeCityKey = null;

    setStatus(
      "Powiat " + powiatKey + ": " +
        facilities.length + " placowek, " +
        cities.length + " miejscowosci | promien " +
        radiusKm + " km | zrodlo: " + source
    );

    renderRanking(cities);
    MapLayer.clear();
    MapLayer.plotFacilities(facilities);
    MapLayer.plotCityCenters(cities, function (city) {
      selectCity(city.key);
    });
  }

  /* -----------------------------------------------------------------------
   * Ranking
   * --------------------------------------------------------------------- */

  /**
   * For each unique city in the powiat, compute the centroid of its facilities
   * and count how many facilities in the whole powiat fall within `radiusKm`.
   */
  function buildRanking(facilities, radiusKm) {
    /* Facilities without a city get grouped as "(nieznana miejscowość)" */
    var groups = {};
    for (var i = 0; i < facilities.length; i++) {
      var f = facilities[i];
      var city = (f.miejscowosc || "").trim() || "(nieznana miejscowość)";
      var key = city + "|" + (f.gmina || "");
      if (!groups[key]) {
        groups[key] = {
          key: key,
          name: city,
          gmina: f.gmina || "",
          members: [],
        };
      }
      groups[key].members.push(f);
    }

    var cities = [];
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      var center = Geo.centroid(g.members);

      /* Skip groups without any coordinates - can't compute radius */
      if (!center) {
        console.log("Skipping group without coordinates:", g.name);
        return;
      }

      var inRadius = [];
      var sp = 0;
      var prz = 0;
      var dk = 0;
      var uczniowieTotal = 0;
      var uczniowieSp = 0;
      var uczniowiePrz = 0;
      for (var j = 0; j < facilities.length; j++) {
        var f = facilities[j];
        /* Skip facilities without a name or coordinates */
        if (!f.nazwa || f.nazwa.length === 0) continue;
        if (f.lat == null || f.lon == null) continue;

        var d = Geo.haversineKm(center.lat, center.lon, f.lat, f.lon);
        if (d <= radiusKm) {
          inRadius.push(f);
          if (f.typ === "SP") sp++;
          else if (f.typ === "PRZ") prz++;
          else if (f.typ === "DK") dk++;

          uczniowieTotal += f.uczniowie || 0;
          if (f.typ === "SP") uczniowieSp += f.uczniowie || 0;
          else if (f.typ === "PRZ") uczniowiePrz += f.uczniowie || 0;
        }
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
    });

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

    /* Inject into state */
    var key = result.powiatKey || powiatInput || "csv-import";
    state.byPowiat[key] = result.facilities;
    if (!state.datalistKeys.has(key)) {
      state.datalistKeys.add(key);
      rebuildDatalist();
    }

    /* Set the powiat input */
    if (key && els.powiatInput) {
      els.powiatInput.value = key;
    }

    var statusMsg = "Zaladowano " + result.facilities.length + " placowek z CSV (" +
      result.sp + " SP, " + result.prz + " PRZ).";

    if (!result.hasStudents) {
      statusMsg += " Uwaga: brak kolumny 'Liczba uczniow' - uzyto srednich wartosci (SP=300, PRZ=100).";
    }

    if (!result.hasCoords) {
      statusMsg += " Uwaga: brak wspolrzednych geograficznych - placowki nie beda na mapie. Sprobuj pobrac dane z OSM (wpisz powiat i kliknij Szukaj - dane zostana pobrane z OpenStreetMap).";
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
      "dom kultury ": "DK",
      "szkola": "SP",
      "publiczna szkola podstawowa": "SP",
      "publiczne przedszkole": "PRZ",
      "samorzadowa szkola podstawowa": "SP",
      "samorzadowe przedszkole": "PRZ",
    };

    var facilities = [];
    var sp = 0, prz = 0;
    var detectedPowiatKey = defaultPowiatKey;
    var unknownTypes = {}; /* Track types we skip for debugging */
    var debugCount = 0;   /* Log first few rows for debugging */
    var hasCoords = (COL.lat !== -1 && COL.lon !== -1) || COL.wsp !== -1;

    /* Defaults applied when no student-count column is present.
     * Approx. Polish averages so ranking is meaningful even without SIO data. */
    var DEFAULT_UCZNIOWIE_SP = 300;
    var DEFAULT_UCZNIOWIE_PRZ = 100;
    var hasStudents = COL.uczniowie !== -1;

    console.log("Starting CSV parsing, total lines:", lines.length, "Has coords:", hasCoords, "Has students:", hasStudents);

    for (var i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      var cells = splitCsvLine(lines[i], sep);

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
        uczniowie = typCode === "SP" ? DEFAULT_UCZNIOWIE_SP : DEFAULT_UCZNIOWIE_PRZ;
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
      if (typCode === "SP") sp++; else prz++;
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
    } else if (!hasCoords) {
      /* This is just a warning, not a critical error */
      console.log("Warning: CSV imported but has no coordinates");
    }

    return {
      facilities: facilities,
      powiatKey: detectedPowiatKey,
      sp: sp,
      prz: prz,
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
})();
