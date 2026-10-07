"""Fournisseur FMI : API DataMapper (World Economic Outlook).

Documentation : https://www.imf.org/external/datamapper/api/help
Aucune clé n'est nécessaire. Le FMI met à jour ces séries deux fois par an
(avril et octobre), avec parfois des révisions entre deux éditions.
"""
from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path

BASE = "https://www.imf.org/external/datamapper/api/v1"
NAME = "FMI"
HOME = "https://www.imf.org/external/datamapper/"
UA = {"User-Agent": "atlas-eco/1.0 (+https://github.com/)", "Accept": "application/json"}


def _get(url: str, tries: int = 4) -> dict:
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as exc:  # réseau, 5xx, JSON tronqué…
            last = exc
            time.sleep(2 ** i)
    raise RuntimeError(f"FMI injoignable : {url} ({last})")


def _local(local_dir: Path, code: str) -> dict:
    """Fichier enregistré depuis le navigateur : <code>.json, ou tout fichier contenant le code."""
    candidates = [local_dir / f"{code}.json", local_dir / code]
    candidates += sorted(p for p in local_dir.iterdir() if p.is_file() and code in p.name)
    for p in candidates:
        if p.is_file():
            data = json.loads(p.read_text(encoding="utf-8"))
            if code in data.get("values", {}):
                return data
    raise FileNotFoundError(f"Aucun fichier FMI pour {code} dans {local_dir}")


def fetch_series(code: str, local_dir: Path | None = None) -> dict[str, dict[int, float]]:
    """Renvoie {code pays: {année: valeur}} pour un indicateur du FMI."""
    data = _local(local_dir, code) if local_dir else _get(f"{BASE}/{code}")
    raw = data.get("values", {}).get(code, {})
    out: dict[str, dict[int, float]] = {}
    for country, years in raw.items():
        clean = {int(y): float(v) for y, v in years.items() if v is not None}
        if clean:
            out[country] = clean
    return out


def fetch_edition(codes: list[str], local_dir: Path | None = None) -> str | None:
    """Libellé de l'édition (ex. « World Economic Outlook (April 2026) »), si disponible."""
    try:
        if local_dir:
            p = local_dir / "indicators.json"
            meta = json.loads(p.read_text(encoding="utf-8")) if p.is_file() else {}
        else:
            meta = _get(f"{BASE}/indicators")
        for c in codes:
            src = meta.get("indicators", {}).get(c, {}).get("source")
            if src:
                return src
    except Exception:
        pass
    return None


def source_url(code: str, country: str) -> str:
    return f"https://www.imf.org/external/datamapper/{code}@WEO/{country}"
