# Wyszukiwarka szkol podstawowych i przedszkoli

Statyczna aplikacja webowa, ktora dla zadanego **powiatu** pokazuje na mapie
wszystkie **szkoly podstawowe** i **przedszkola**, a nastepnie tworzy ranking
miast wedlug liczby placowek w promieniu zadanym przez uzytkownika.

- Zrodlo danych: [Rejestr Szkol i Placowek Oswiatowych (RSPO)](https://rspo.gov.pl/).
- Mapa: Leaflet + kafelki OpenStreetMap.
- Brak backendu, brak buildu, brak zaleznosci npm.

## Jak dziala

1. Wpisz nazwe powiatu (np. `krakowski`, `warszawski zachodni`) — lista podpowiedzi
   uzupelnia sie automatycznie z bazy OpenStreetMap (wszystkie 380 polskich powiatow).
2. Podaj promien w kilometrach (domyslnie 5 km).
3. Aplikacja:
   - pobiera placowki z bazy lokalnej (RSPO) lub z Overpass API (OSM), jesli lokalna
     baza nie zawiera danego powiatu,
   - wyswietla wszystkie placowki w powiecie na mapie,
   - grupuje placowki po `miejscowosci`, liczac centroid jako przybliony srodek miasta,
   - dla kazdego miasta liczy ile SP + przedszkoli znajduje sie w promieniu wokol
     tego centroidu,
   - sortuje miasta od najwyzszej do najnizszej liczby placowek w promieniu,
   - po klikieciu w miasto pokazuje pelna liste nazw placowek w promieniu.

### Priorytety zrodel danych

| Zrodlo | Kiedy uzywane | Dokladnosc |
|--------|---------------|------------|
| Lokalna baza `data/placowki.json` (RSPO) | jesli powiat w bazie | bardzo wysoka |
| Overpass API (OpenStreetMap) | kazdy powiat, na zywo z internetu | dobra |

Wyniki z Overpass sa cachowane w `localStorage` przegladarki na 24 godziny.
Lista powiatow jest cachowana 7 dni. Kliknij **wyczysc cache** (stopka) aby
wymusic swieze dane.

## Uruchomienie

### 1. Pobierz dane RSPO (jednorazowo)

1. Wejdz na <https://rspo.gov.pl/zaawansowana>.
2. W filtrze "Typ podmiotu" zaznacz: `Szkola podstawowa` oraz `Przedszkole`.
3. Uruchom wyszukiwanie, a nastepnie kliknij "Eksportuj do CSV".
4. Zapisz plik jako `data/raw/rspo.csv` w tym repo (`data/raw/` jest
   ignorowane przez git).

Alternatywa: dataset na
<https://dane.gov.pl/pl/dataset/839/resource/51521> (ta sama baza, aktualizowana
automatycznie).

### 2. Preprocessing CSV -> slim JSON

```bash
python3 scripts/preprocess_rspo.py
```

Skrypt:
- wczyta `data/raw/rspo.csv`,
- zachowa tylko placowki typu "Szkola podstawowa" i "Przedszkole",
- odrzuci rekordy bez wspolrzednych geograficznych,
- zapisze wynik jako `data/placowki.json` (ten plik commitujemy do repo, by
  aplikacja dzialala bez preprocessingu u koncowego uzytkownika).

Skrypt uzywa tylko biblioteki standardowej Pythona (brak `pip install`).

Jesli w Twoim CSV naglowki kolumn sa nieco inne, dostosuj stala
`COL_CANDIDATES` na gorze `scripts/preprocess_rspo.py` - kazda kolumna ma
liste alternatywnych nazw, pierwsza ktora pasuje jest uzywana.

### 3. Uruchom aplikacje

Najprosciej lokalnym serwerem HTTP (wymagany, bo `fetch()` nie dziala z
`file://`):

```bash
python3 -m http.server 8000
```

Otworz w przegladarce: <http://localhost:8000>.

Mozesz takze wdrozyc repo na dowolny hosting statyczny (GitHub Pages,
Netlify, Vercel, Cloudflare Pages) - wystarczy podlaczyc repozytorium, nie
potrzeba zadnej konfiguracji buildu.

## Struktura projektu

```
system_sga/
|-- index.html              # UI (formularz, sidebar, mapa)
|-- css/styles.css          # style
|-- js/
|   |-- geo.js              # haversine + centroid
|   |-- map.js              # Leaflet init, markery, kolko promienia
|   |-- app.js              # logika: ranking, interakcje
|-- data/
|   |-- placowki.json       # slim JSON (SP + przedszkola, z wspolrzednymi)
|   `-- raw/                # surowe CSV (ignorowane przez git)
|-- scripts/
|   `-- preprocess_rspo.py  # CSV -> slim JSON
`-- README.md
```

## Ograniczenia i dalsze ulepszenia

- **Srodek miasta** w MVP to centroid wszystkich placowek danego miasta. Dla
  duzych miast to dobre przyblizenie, ale dla precyzji mozna uzyc
  [Nominatim](https://nominatim.openstreetmap.org/) do geokodowania.
- **Aktualnosc danych** zalezy od tego, kiedy ostatnio pobrano CSV z RSPO.
- **Inne typy placowek** (licea, technika, zespoly szkol) mozna wlaczyc
  rozszerzajac `WANTED_TYPES` w skrypcie preprocesujacym.
- Aplikacja jest w pelni client-side, wiec pelen zbior `data/placowki.json`
  jest pobierany przy starcie. Dla ~20 000 rekordow to ~2 MB - w porzadku.
