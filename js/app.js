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

    /* If we have local data for this powiat, use it immediately */
    var localFacilities = state.byPowiat[powiatKey];
    if (localFacilities && localFacilities.length > 0) {
      processAndRender(localFacilities, powiatKey, radiusKm, "lokalna baza RSPO");
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
      var inRadius = [];
      var sp = 0;
      var prz = 0;
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
      if (a.typ !== b.typ) return a.typ === "SP" ? -1 : 1;
      return (a.nazwa || "").localeCompare(b.nazwa || "", "pl");
    });
    sorted.forEach(function (f) {
      var li = document.createElement("li");
      var badge = document.createElement("span");
      badge.className = "type-badge " + f.typ;
      badge.textContent = f.typ === "SP" ? "SP" : "PRZ";
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
      statusMsg += " Uwaga: kolumna 'Liczba uczniow' nie zostala wykryta - liczba uczniow bedzie wynosic 0.";
    }

    if (!result.hasCoords) {
      statusMsg += " Uwaga: brak współrzędnych geograficznych - placówki nie będą na mapie.";
    }

    statusMsg += " Mozesz teraz kliknac Szukaj.";

    var statusClass = (result.hasStudents && result.hasCoords) ? "ok" : "err";
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
    /* Normalise line endings */
    var lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    if (lines.length < 2) {
      return { error: "Plik zbyt krotki (wymagany naglowek + dane).", facilities: [] };
    }

    /* Detect separator */
    var sep = lines[0].indexOf(";") !== -1 ? ";" : ",";

    var header = splitCsvLine(lines[0], sep).map(function (h) {
      return h.trim().toLowerCase();
    });

    /* Column detection helpers */
    function findCol(candidates) {
      for (var i = 0; i < candidates.length; i++) {
        var idx = header.indexOf(candidates[i].toLowerCase());
        if (idx !== -1) return idx;
      }
      return -1;
    }

    var COL = {
      rspo:     findCol(["numer rspo", "rspo", "numer rsip"]),
      nazwa:    findCol(["nazwa", "nazwa placowki", "nazwa podmiotu"]),
      typ:      findCol(["typ podmiotu", "typ", "typ placowki", "rodzaj placowki"]),
      miej:     findCol(["miejscowosc", "miejscowo\u015b\u0107", "miasto"]),
      gmina:    findCol(["gmina"]),
      powiat:   findCol(["powiat", "powiat/meiasto"]),
      woj:      findCol(["wojew\u00f3dztwo", "wojewodztwo"]),
      ulica:    findCol(["ulica", "adres"]),
      nr:       findCol(["numer budynku", "numer", "nr budynku", "nr"]),
      kod:      findCol(["kod pocztowy", "kod"]),
      lat:      findCol(["szeroko\u015b\u0107 geograficzna", "szerokosc geograficzna", "latitude", "lat", "wsp\u00f3\u0142rz\u0119dne geograficzne"]),
      lon:      findCol(["d\u0142ugo\u015b\u0107 geograficzna", "dlugosc geograficzna", "longitude", "lon", "wsp\u00f3\u0142rz\u0119dne geograficzne"]),
      uczniowie: findCol(["liczba uczni\u00f3w", "liczba uczniow", "liczba dzieci", "uczniowie", "students", "liczba uczni\u00f3w/dzieci", "ogolna liczba dzieci/uczniow"]),
    };

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
    var sp = 0, prz = 0;
    var detectedPowiatKey = defaultPowiatKey;
    var unknownTypes = {}; /* Track types we skip for debugging */
    var debugCount = 0;   /* Log first few rows for debugging */
    var hasCoords = COL.lat !== -1 && COL.lon !== -1;

    console.log("Starting CSV parsing, total lines:", lines.length, "Has coords:", hasCoords);

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

      var lat = parseFloat((cells[COL.lat] || "").trim().replace(",", "."));
      var lon = parseFloat((cells[COL.lon] || "").trim().replace(",", "."));
      if (isNaN(lat) || isNaN(lon)) { lat = null; lon = null; }

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

      var uczniowieRaw = COL.uczniowie !== -1 ? (cells[COL.uczniowie] || "").trim().replace(/\s/g, "") : "";
      var uczniowie = parseInt(uczniowieRaw, 10);
      if (isNaN(uczniowie)) uczniowie = 0;

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
