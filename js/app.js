/* Main app: load data, handle search form, build ranking, wire UI. */
(function () {
  "use strict";

  var state = {
    facilities: [], // all loaded facilities
    byPowiat: {}, // powiat_key -> [facility, ...]
    powiatKeys: [], // sorted unique powiat keys
    currentCities: [], // ranking for last search
    currentRadiusKm: 5,
    activeCityKey: null,
  };

  var els = {};

  document.addEventListener("DOMContentLoaded", function () {
    els.form = document.getElementById("search-form");
    els.powiatInput = document.getElementById("powiat-input");
    els.radiusInput = document.getElementById("radius-input");
    els.powiatList = document.getElementById("powiat-list");
    els.status = document.getElementById("status");
    els.results = document.getElementById("results");

    MapLayer.initMap("map");

    els.form.addEventListener("submit", function (e) {
      e.preventDefault();
      handleSearch();
    });

    loadData();
  });

  function setStatus(text, isError) {
    els.status.textContent = text || "";
    els.status.classList.toggle("error", Boolean(isError));
  }

  function loadData() {
    setStatus("Ladowanie danych placowek...");
    fetch("data/placowki.json", { cache: "no-cache" })
      .then(function (res) {
        if (!res.ok) {
          throw new Error("HTTP " + res.status);
        }
        return res.json();
      })
      .then(function (data) {
        state.facilities = data;
        indexByPowiat(data);
        populateDatalist(state.powiatKeys);
        setStatus(
          "Zaladowano " +
            data.length +
            " placowek w " +
            state.powiatKeys.length +
            " powiatach."
        );
      })
      .catch(function (err) {
        console.error(err);
        setStatus(
          "Nie udalo sie zaladowac data/placowki.json. Uruchom skrypt scripts/preprocess_rspo.py.",
          true
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

  function populateDatalist(keys) {
    els.powiatList.innerHTML = "";
    for (var i = 0; i < keys.length; i++) {
      var opt = document.createElement("option");
      opt.value = keys[i];
      els.powiatList.appendChild(opt);
    }
  }

  function normalizePowiat(input) {
    return (input || "").trim().toLowerCase().replace(/^powiat\s+/i, "");
  }

  function handleSearch() {
    var rawPowiat = els.powiatInput.value;
    var powiatKey = normalizePowiat(rawPowiat);
    var radiusKm = parseFloat(els.radiusInput.value);

    if (!powiatKey) {
      setStatus("Wpisz nazwe powiatu.", true);
      return;
    }
    if (!radiusKm || radiusKm <= 0) {
      setStatus("Promien musi byc dodatni.", true);
      return;
    }

    var facilities = state.byPowiat[powiatKey];
    if (!facilities || facilities.length === 0) {
      setStatus('Nie znaleziono powiatu "' + rawPowiat + '".', true);
      renderSuggestions(powiatKey);
      MapLayer.clear();
      return;
    }

    state.currentRadiusKm = radiusKm;
    var cities = buildRanking(facilities, radiusKm);
    state.currentCities = cities;
    state.activeCityKey = null;

    setStatus(
      "Powiat " +
        powiatKey +
        ": " +
        facilities.length +
        " placowek, " +
        cities.length +
        " miast. Promien " +
        radiusKm +
        " km."
    );

    renderRanking(cities);
    MapLayer.clear();
    MapLayer.plotFacilities(facilities);
    MapLayer.plotCityCenters(cities, function (city) {
      selectCity(city.key);
    });
  }

  /**
   * For each unique miejscowosc in the powiat, compute the centroid of its
   * facilities and count how many facilities in the whole powiat fall within
   * `radiusKm` of that centroid. Returns cities sorted by total desc.
   */
  function buildRanking(facilities, radiusKm) {
    // Group by city key (miejscowosc + gmina to avoid collisions).
    var groups = {};
    for (var i = 0; i < facilities.length; i++) {
      var f = facilities[i];
      var key =
        (f.miejscowosc || "?") + "|" + (f.gmina || "");
      if (!groups[key]) {
        groups[key] = {
          key: key,
          name: f.miejscowosc || "(nieznana miejscowosc)",
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
      for (var j = 0; j < facilities.length; j++) {
        var f = facilities[j];
        var d = Geo.haversineKm(center.lat, center.lon, f.lat, f.lon);
        if (d <= radiusKm) {
          inRadius.push(f);
          if (f.typ === "SP") sp++;
          else if (f.typ === "PRZ") prz++;
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
        inRadius: inRadius,
      });
    });

    cities.sort(function (a, b) {
      if (b.total !== a.total) return b.total - a.total;
      if (b.sp !== a.sp) return b.sp - a.sp;
      return a.name.localeCompare(b.name, "pl");
    });
    return cities;
  }

  function renderRanking(cities) {
    els.results.innerHTML = "";
    if (cities.length === 0) {
      els.results.textContent = "Brak miast.";
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
          ? ' <span style="color:#7b8794;font-weight:400;">(' +
            escapeHtml(city.gmina) +
            ")</span>"
          : "") +
        "</div>" +
        '<div class="city-card__breakdown">' +
        city.sp +
        " SP &middot; " +
        city.prz +
        " przedszkoli" +
        "</div>" +
        "</div>" +
        '<div class="city-card__count">' +
        city.total +
        "</div>";
      header.addEventListener("click", function () {
        selectCity(city.key);
      });
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
      var li = document.createElement("li");
      li.textContent = "Brak placowek w promieniu.";
      ul.appendChild(li);
      return ul;
    }
    // Group: SP first, then PRZ, alphabetical inside each.
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
      li.appendChild(wrap);
      ul.appendChild(li);
    });
    return ul;
  }

  function selectCity(cityKey) {
    var city = state.currentCities.find(function (c) {
      return c.key === cityKey;
    });
    if (!city) return;

    state.activeCityKey = cityKey;

    // Update card active state
    var cards = els.results.querySelectorAll(".city-card");
    cards.forEach(function (card) {
      if (card.dataset.cityKey === cityKey) {
        card.classList.add("active");
        card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } else {
        card.classList.remove("active");
      }
    });

    // Update map
    MapLayer.drawRadius(city.center, state.currentRadiusKm);
    MapLayer.focusOn(city.center.lat, city.center.lon, 12);
  }

  function renderSuggestions(partial) {
    els.results.innerHTML = "";
    if (!partial) return;
    var matches = state.powiatKeys
      .filter(function (k) {
        return k.indexOf(partial) !== -1;
      })
      .slice(0, 10);
    if (matches.length === 0) return;
    var header = document.createElement("div");
    header.style.padding = "8px 10px 0";
    header.style.fontSize = "12px";
    header.style.color = "#52606d";
    header.textContent = "Moze chodzilo o:";
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
})();
