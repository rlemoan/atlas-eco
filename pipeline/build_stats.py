#!/usr/bin/env python3
"""Récupère les indicateurs de chaque niveau décrit dans public/config.json.

Usage :
    python pipeline/build_stats.py                    # interroge les API en direct
    python pipeline/build_stats.py --imf-dir dossier/ # fichiers FMI enregistrés à la main
    python pipeline/build_stats.py --ref-year 2025

Pour chaque niveau disponible et chaque indicateur, on garde la valeur de
l'année de référence (par défaut : année en cours - 1, la dernière année
complète) ou, à défaut, la plus récente avant elle, plus un historique court.

Le script refuse d'écrire si la couverture chute anormalement : un site en
ligne garde ainsi ses dernières données valides si une source change de format.
"""
from __future__ import annotations

import argparse
import datetime as dt
import importlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
sys.path.insert(0, str(Path(__file__).resolve().parent))

PROVIDERS = {"imf": "providers.imf"}
MIN_COVERAGE = {"countries": 150}  # nombre minimal de zones renseignées par indicateur
MONTHS = {"January": "janvier", "February": "février", "March": "mars", "April": "avril",
          "May": "mai", "June": "juin", "July": "juillet", "August": "août",
          "September": "septembre", "October": "octobre", "November": "novembre",
          "December": "décembre"}


def french_edition(label: str | None) -> str | None:
    if not label:
        return None
    for en, fr in MONTHS.items():
        label = label.replace(en, fr)
    return label


def pick(series: dict[int, float], ref: int, max_age: int) -> tuple[int, float] | None:
    """Valeur de l'année de référence, sinon la plus récente, si elle n'est pas trop ancienne."""
    years = [y for y in series if ref - max_age <= y <= ref]
    if not years:
        return None
    y = max(years)
    return y, series[y]


def check_consistency(values: dict, level_id: str) -> list[str]:
    """PIB/hab × population doit retrouver le PIB (à 2 % près) : détecte les séries corrompues."""
    issues = []
    for code, v in values.items():
        if not all(k in v for k in ("gdp", "gdp_pc", "pop")):
            continue
        if v["gdp"]["y"] != v["gdp_pc"]["y"] or v["gdp"]["y"] != v["pop"]["y"]:
            continue
        if v["pop"]["v"] < 0.1:  # micro-États : la population arrondie fausse le calcul
            continue
        rebuilt = v["gdp_pc"]["v"] * v["pop"]["v"] / 1000
        if v["gdp"]["v"] and abs(rebuilt / v["gdp"]["v"] - 1) > 0.02:
            issues.append(f"{level_id}/{code}: PIB {v['gdp']['v']:.1f} vs PIB/hab×pop {rebuilt:.1f}")
    return issues


def build_level(level: dict, indicators: list[dict], ref: int, hist: int, max_age: int,
                local_dirs: dict[str, Path | None]) -> dict:
    geo = json.loads((PUBLIC / level["geometry"]).read_text(encoding="utf-8"))
    id_prop = level.get("idProperty", "code")
    codes = {f["properties"][id_prop] for f in geo["features"]}

    values: dict[str, dict] = {}
    used: dict[str, dict] = {}
    coverage: dict[str, int] = {}
    providers_used: dict[str, list[str]] = {}

    for ind in indicators:
        src = ind.get("sources", {}).get(level["id"])
        if not src:
            continue
        prov = importlib.import_module(PROVIDERS[src["provider"]])
        series = prov.fetch_series(src["code"], local_dirs.get(src["provider"]))
        providers_used.setdefault(src["provider"], []).append(src["code"])
        used[ind["id"]] = {"provider": src["provider"], "code": src["code"]}
        n = 0
        for code in codes:
            s = series.get(code)
            got = pick(s, ref, max_age) if s else None
            if not got:
                continue
            y, v = got
            h = [[yy, s[yy]] for yy in range(y - hist + 1, y + 1) if yy in s]
            values.setdefault(code, {})[ind["id"]] = {"v": v, "y": y, "h": h}
            n += 1
        coverage[ind["id"]] = n
        print(f"  {level['id']:>10} · {ind['id']:<8} {src['code']:<12} {n} zones")

    floor = MIN_COVERAGE.get(level["id"], 1)
    low = {k: n for k, n in coverage.items() if n < floor}
    if low:
        raise SystemExit(f"Couverture insuffisante pour {level['id']} : {low} (minimum {floor}). "
                         "Données précédentes conservées.")

    for issue in check_consistency(values, level["id"]):
        print("  ⚠", issue)

    sources = {}
    for pid, codes_used in providers_used.items():
        prov = importlib.import_module(PROVIDERS[pid])
        sources[pid] = {
            "name": prov.NAME,
            "edition": french_edition(prov.fetch_edition(codes_used, local_dirs.get(pid))),
            "url": prov.HOME,
        }

    return {
        "level": level["id"],
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "referenceYear": ref,
        "sources": sources,
        "indicators": used,
        "values": dict(sorted(values.items())),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--ref-year", type=int, help="année de référence (défaut : année en cours - 1)")
    ap.add_argument("--imf-dir", type=Path, help="dossier de fichiers JSON FMI déjà téléchargés")
    args = ap.parse_args()

    config = json.loads((PUBLIC / "config.json").read_text(encoding="utf-8"))
    ref = args.ref_year or (config.get("referenceYear") if isinstance(config.get("referenceYear"), int)
                            else dt.date.today().year - 1)
    hist = int(config.get("historyYears", 10))
    max_age = int(config.get("maxAgeYears", 6))
    local_dirs = {"imf": args.imf_dir}

    for level in config["levels"]:
        if not level.get("available") or not level.get("stats"):
            continue
        print(f"Niveau {level['label']} (année de référence {ref})")
        out = build_level(level, config["indicators"], ref, hist, max_age, local_dirs)
        path = PUBLIC / level["stats"]
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.is_file():
            # Données identiques : on garde la date de la vraie dernière mise à jour
            # (et le dépôt ne reçoit pas de commit inutile).
            old = json.loads(path.read_text(encoding="utf-8"))
            same = all(old.get(k) == out[k] for k in ("values", "sources", "referenceYear", "indicators"))
            if same:
                print("  données inchangées")
                continue
        path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"  -> {path.relative_to(ROOT)} ({path.stat().st_size / 1024:.0f} Ko)")


if __name__ == "__main__":
    main()
