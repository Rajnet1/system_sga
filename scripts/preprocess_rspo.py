#!/usr/bin/env python3
"""Preprocess RSPO CSV into a slim JSON bundled with the static app.

Usage:
    python3 scripts/preprocess_rspo.py [input_csv] [output_json]

Defaults:
    input_csv   = data/raw/rspo.csv
    output_json = data/placowki.json

Pobierz CSV ze strony https://rspo.gov.pl/zaawansowana (filtruj po typie
placowki "Szkola podstawowa" i "Przedszkole", eksport CSV) i zapisz jako
data/raw/rspo.csv. Skrypt dziala na czystej bibliotece standardowej, bez
zewnetrznych zaleznosci.
"""

from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path

# --- KONFIGURACJA -----------------------------------------------------------
# Nazwy kolumn w CSV z RSPO (sprawdz naglowki w swoim pliku i dostosuj).
# RSPO Wyszukiwarka eksportuje CSV z polskimi naglowkami - ponizsze warianty
# sa probowane po kolei dopoki ktorys nie trafi.
COL_CANDIDATES = {
    "rspo": ["Numer RSPO", "RSPO", "Numer Rspo", "numerRspo"],
    "nazwa": ["Nazwa", "Nazwa placowki", "nazwa"],
    "typ": [
        "Typ",
        "Typ podmiotu",
        "Typ placowki",
        "typ",
    ],
    "miejscowosc": ["Miejscowosc", "Miejscowość", "miejscowosc"],
    "gmina": ["Gmina", "gmina"],
    "powiat": ["Powiat", "powiat"],
    "wojewodztwo": ["Wojewodztwo", "Województwo", "wojewodztwo"],
    "ulica": ["Ulica", "ulica"],
    "numer": ["Numer budynku", "Numer", "Nr budynku", "numerBudynku"],
    "kod": ["Kod pocztowy", "kodPocztowy"],
    "lat": [
        "Szerokosc geograficzna",
        "Szerokość geograficzna",
        "szerokoscGeograficzna",
        "Latitude",
        "lat",
    ],
    "lon": [
        "Dlugosc geograficzna",
        "Długość geograficzna",
        "dlugoscGeograficzna",
        "Longitude",
        "lon",
    ],
}

# Typy placowek zachowywane w wyjsciu. Klucz = wartosc z CSV (lowercase),
# wartosc = krotki kod w JSON.
WANTED_TYPES = {
    "szkola podstawowa": "SP",
    "szkoła podstawowa": "SP",
    "przedszkole": "PRZ",
}

DEFAULT_INPUT = Path("data/raw/rspo.csv")
DEFAULT_OUTPUT = Path("data/placowki.json")


def pick_column(header: list[str], candidates: list[str]) -> str | None:
    """Zwroc pierwszy istniejacy w header naglowek z listy kandydatow."""
    lowered = {h.strip().lower(): h for h in header}
    for cand in candidates:
        if cand in header:
            return cand
        if cand.lower() in lowered:
            return lowered[cand.lower()]
    return None


def resolve_columns(header: list[str]) -> dict[str, str | None]:
    return {key: pick_column(header, cands) for key, cands in COL_CANDIDATES.items()}


def parse_float(value: str) -> float | None:
    if not value:
        return None
    cleaned = value.strip().replace(",", ".")
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


_POWIAT_PREFIX = re.compile(r"^(powiat|miasto\s+na\s+prawach\s+powiatu)\s+", re.IGNORECASE)


def powiat_key(name: str) -> str:
    """Normalizacja nazwy powiatu do stabilnego klucza wyszukiwania."""
    if not name:
        return ""
    n = name.strip()
    n = _POWIAT_PREFIX.sub("", n)
    return n.lower()


def format_address(row: dict, cols: dict[str, str | None]) -> str:
    parts: list[str] = []
    if cols["ulica"]:
        street = (row.get(cols["ulica"]) or "").strip()
        num = (row.get(cols["numer"]) or "").strip() if cols["numer"] else ""
        if street and num:
            parts.append(f"{street} {num}")
        elif street:
            parts.append(street)
    locality_bits = []
    if cols["kod"]:
        kod = (row.get(cols["kod"]) or "").strip()
        if kod:
            locality_bits.append(kod)
    if cols["miejscowosc"]:
        miej = (row.get(cols["miejscowosc"]) or "").strip()
        if miej:
            locality_bits.append(miej)
    if locality_bits:
        parts.append(" ".join(locality_bits))
    return ", ".join(parts)


def main(argv: list[str]) -> int:
    input_path = Path(argv[1]) if len(argv) > 1 else DEFAULT_INPUT
    output_path = Path(argv[2]) if len(argv) > 2 else DEFAULT_OUTPUT

    if not input_path.exists():
        print(f"[ERR] Nie znaleziono pliku wejsciowego: {input_path}", file=sys.stderr)
        print(
            "Pobierz CSV z https://rspo.gov.pl/zaawansowana i zapisz jako "
            f"{input_path}",
            file=sys.stderr,
        )
        return 1

    # Autodetekcja separatora (RSPO uzywa ';').
    with input_path.open("r", encoding="utf-8-sig", newline="") as f:
        sample = f.read(8192)
        f.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=";,\t|")
        except csv.Error:
            dialect = csv.excel
            dialect.delimiter = ";"  # type: ignore[attr-defined]
        reader = csv.DictReader(f, dialect=dialect)
        if reader.fieldnames is None:
            print("[ERR] Pusty CSV / brak naglowkow", file=sys.stderr)
            return 1
        cols = resolve_columns(reader.fieldnames)

        missing_required = [k for k in ("nazwa", "typ", "powiat", "lat", "lon") if not cols[k]]
        if missing_required:
            print(
                "[ERR] Brak wymaganych kolumn w CSV: "
                f"{missing_required}. Dostepne naglowki: {reader.fieldnames}",
                file=sys.stderr,
            )
            return 1

        kept: list[dict] = []
        skipped_type = 0
        skipped_geo = 0
        total = 0

        for row in reader:
            total += 1
            typ_raw = (row.get(cols["typ"]) or "").strip().lower()
            typ_code = WANTED_TYPES.get(typ_raw)
            if not typ_code:
                skipped_type += 1
                continue

            lat = parse_float(row.get(cols["lat"]) or "")
            lon = parse_float(row.get(cols["lon"]) or "")
            if lat is None or lon is None:
                skipped_geo += 1
                continue

            powiat_raw = (row.get(cols["powiat"]) or "").strip()
            miejscowosc = (row.get(cols["miejscowosc"]) or "").strip() if cols["miejscowosc"] else ""
            gmina = (row.get(cols["gmina"]) or "").strip() if cols["gmina"] else ""

            entry = {
                "rspo": (row.get(cols["rspo"]) or "").strip() if cols["rspo"] else "",
                "nazwa": (row.get(cols["nazwa"]) or "").strip(),
                "typ": typ_code,
                "miejscowosc": miejscowosc,
                "gmina": gmina,
                "powiat": powiat_raw,
                "powiat_key": powiat_key(powiat_raw),
                "wojewodztwo": (row.get(cols["wojewodztwo"]) or "").strip()
                if cols["wojewodztwo"]
                else "",
                "adres": format_address(row, cols),
                "lat": round(lat, 6),
                "lon": round(lon, 6),
            }
            kept.append(entry)

    kept.sort(key=lambda e: (e["powiat_key"], e["miejscowosc"], e["nazwa"]))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(kept, f, ensure_ascii=False, separators=(",", ":"))

    print(
        f"[OK] Wczytano {total} rekordow, zapisano {len(kept)} placowek "
        f"(pominieto {skipped_type} zlych typow, {skipped_geo} bez wspolrzednych)",
        file=sys.stderr,
    )
    print(f"[OK] Wynik: {output_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
