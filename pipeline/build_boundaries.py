#!/usr/bin/env python3
"""Construit les contours du niveau « Pays » à partir de Natural Earth (domaine public).

Usage :
    python pipeline/build_boundaries.py               # télécharge Natural Earth 1:50m
    python pipeline/build_boundaries.py --source f.geojson

Prérequis : Node.js (mapshaper est lancé via npx) ou la variable MAPSHAPER
pointant vers l'exécutable mapshaper.

À relancer seulement si les frontières changent : les données statistiques
sont produites séparément par build_stats.py.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shlex
import subprocess
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data" / "geo" / "countries.geojson"
NE_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
    "master/geojson/ne_50m_admin_0_countries.geojson"
)

# Natural Earth ADM0_A3 -> code de la carte (aligné sur les codes FMI).
# Les entités rattachées à un même code sont fusionnées en un seul contour.
CODE_OVERRIDES = {
    "SOL": "SOM",  # Somaliland -> Somalie (frontières reconnues par l'ONU)
    "CYN": "CYP",  # Chypre du Nord -> Chypre
    "KOS": "UVK",  # Kosovo : code FMI
    "PSX": "WBG",  # Palestine : code FMI « West Bank and Gaza »
    "ALD": "FIN",  # Åland -> Finlande
    "IOA": "AUS",  # Territoires australiens de l'océan Indien -> Australie
    "ATC": "AUS",  # Îles Ashmore-et-Cartier -> Australie
}
DROP = {"ATA"}  # Antarctique : sans données, et très déformée en projection plane

NAME_OVERRIDES = {
    "CHN": "Chine",
    "COG": "Congo",
    "COD": "RD Congo",
    "MAF": "Saint-Martin (France)",
    "SXM": "Sint Maarten",
    "WBG": "Palestine (Cisjordanie et Gaza)",
    "PCN": "Îles Pitcairn",
    "KAS": "Glacier de Siachen",
    "IOT": "Territoire britannique de l'océan Indien",
}

# Recadrage au clic : on garde le polygone principal, les îles proches,
# et les grandes terres un peu plus éloignées (ex. Papouasie pour l'Indonésie).
NEAR_DEG = 10
FAR_DEG = 30
FAR_MIN_AREA_RATIO = 0.05


def load_source(path: str | None) -> dict:
    if path:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    req = urllib.request.Request(NE_URL, headers={"User-Agent": "atlas-eco/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def code_of(p: dict) -> str:
    a3 = p["ADM0_A3"]
    if a3 in CODE_OVERRIDES:
        return CODE_OVERRIDES[a3]
    iso = p.get("ISO_A3_EH") or "-99"
    return iso if iso != "-99" else a3


def nice_name(code: str, raw: str) -> str:
    name = NAME_OVERRIDES.get(code, raw)
    return name[:1].upper() + name[1:]


def prepare(src: dict) -> dict:
    by_code: dict[str, list[dict]] = {}
    for f in src["features"]:
        p = f["properties"]
        if p["ADM0_A3"] in DROP:
            continue
        by_code.setdefault(code_of(p), []).append(f)

    feats = []
    for code, fs in by_code.items():
        # Le nom vient de l'entité « principale » (celle dont le code ISO est le code final).
        main = next((f for f in fs if f["properties"].get("ISO_A3_EH") == code), fs[0])
        name = nice_name(code, main["properties"]["NAME_FR"] or main["properties"]["NAME"])
        for f in fs:
            feats.append({"type": "Feature", "properties": {"code": code, "name": name},
                          "geometry": f["geometry"]})
    return {"type": "FeatureCollection", "features": feats}


def run_mapshaper(src: Path, dst: Path) -> None:
    exe = shlex.split(os.environ.get("MAPSHAPER", "npx --yes mapshaper"))
    cmd = exe + [
        "-i", str(src),
        "-dissolve", "code", "copy-fields=name",
        "-simplify", "15%", "weighted", "keep-shapes",
        "-clean",
        "-o", "format=geojson", "precision=0.001", str(dst),
    ]
    subprocess.run(cmd, check=True)


def rings(geom: dict):
    if geom["type"] == "Polygon":
        yield geom["coordinates"][0]
    elif geom["type"] == "MultiPolygon":
        for poly in geom["coordinates"]:
            yield poly[0]


def ring_stats(ring):
    """Aire (deg² corrigée de la latitude) et centroïde approximatif d'un anneau."""
    a = cx = cy = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        cross = x1 * y2 - x2 * y1
        a += cross
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    if abs(a) < 1e-12:
        xs, ys = zip(*ring)
        return 0.0, (sum(xs) / len(xs), sum(ys) / len(ys))
    cx /= 3 * a
    cy /= 3 * a
    return abs(a) / 2 * math.cos(math.radians(cy)), (cx, cy)


def focus_bbox(geom: dict) -> list[float]:
    parts = [(r, *ring_stats(r)) for r in rings(geom)]
    main_ring, main_area, (mx, my) = max(parts, key=lambda t: t[1])
    xs, ys = [], []
    for ring, area, (cx, cy) in parts:
        dx = (cx - mx + 540) % 360 - 180  # écart en longitude, antiméridien compris
        dist = math.hypot(dx * math.cos(math.radians(my)), cy - my)
        keep = ring is main_ring or dist <= NEAR_DEG or (
            dist <= FAR_DEG and area >= FAR_MIN_AREA_RATIO * main_area)
        if not keep:
            continue
        shift = 0.0
        if cx - mx > 180:
            shift = -360.0
        elif cx - mx < -180:
            shift = 360.0
        for x, y in ring:
            xs.append(x + shift)
            ys.append(y)
    return [round(min(xs), 3), round(min(ys), 3), round(max(xs), 3), round(max(ys), 3)]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", help="GeoJSON Natural Earth local (sinon téléchargé)")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        prepared = Path(tmp) / "prepared.geojson"
        simplified = Path(tmp) / "simplified.geojson"
        prepared.write_text(json.dumps(prepare(load_source(args.source))), encoding="utf-8")
        run_mapshaper(prepared, simplified)
        fc = json.loads(simplified.read_text(encoding="utf-8"))

    for f in fc["features"]:
        f["properties"]["bbox"] = focus_bbox(f["geometry"])
    fc["features"].sort(key=lambda f: f["properties"]["code"])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(fc['features'])} contours -> {OUT.relative_to(ROOT)} "
          f"({OUT.stat().st_size / 1024:.0f} Ko)")


if __name__ == "__main__":
    main()
