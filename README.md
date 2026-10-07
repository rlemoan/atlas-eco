# Atlas économique mondial

Carte interactive des grands indicateurs économiques, aujourd'hui par **pays** :
PIB, PIB en PPA, PIB par habitant, dette publique (% du PIB) et population.

- Survol d'un pays : fiche rapide avec les 5 indicateurs et le rang mondial.
- Clic (ou recherche) : la carte se recentre sur le pays et ouvre sa fiche
  (évolution sur 10 ans, lien vers la série officielle du FMI).
- Vue plane ou globe, thème clair ou sombre, mobile compris.
- Lien direct vers un pays : `…/#FRA`.

Le site est **100 % statique** : pas de serveur, pas de base de données, pas de
clé d'API. Un pipeline Python régénère les fichiers de données, GitHub Actions
le lance tous les mois et republie le site.

---

## Arborescence

```
public/                       ← le site, à publier tel quel
  index.html  style.css  app.js
  config.json                 ← niveaux, indicateurs, sources (tout se règle ici)
  data/geo/countries.geojson  ← contours des pays (Natural Earth, simplifiés)
  data/stats/countries.json   ← valeurs produites par le pipeline
  vendor/                     ← MapLibre GL JS (moteur de carte)
pipeline/
  build_stats.py              ← récupère les indicateurs (stdlib Python, aucune dépendance)
  build_boundaries.py         ← reconstruit les contours (rarement utile)
  providers/imf.py            ← connecteur FMI (API DataMapper)
.github/workflows/donnees-et-deploiement.yml
```

## Lancer en local

```bash
python3 pipeline/build_stats.py          # ~10 s, interroge l'API du FMI
python3 -m http.server 8000 -d public    # puis http://localhost:8000
```

Python 3.10 ou plus. Aucun paquet à installer.

## Publier sur le web

### Option A : GitHub Pages (gratuit, mises à jour automatiques)

1. Créer un dépôt GitHub et y pousser ce dossier.
2. **Settings → Pages → Build and deployment → Source : GitHub Actions.**
3. **Actions → Données et déploiement → Run workflow.**
   Le site est en ligne sur `https://<compte>.github.io/<dépôt>/`.
4. Nom de domaine personnalisé : **Settings → Pages → Custom domain**.

Ensuite, tout est automatique : le 3 de chaque mois, le workflow interroge le
FMI, enregistre les nouvelles données si elles ont changé, puis republie.

### Option B : Cloudflare Pages ou Netlify

Connecter le dépôt, **commande de build vide**, **dossier de sortie `public`**.
Garder le workflow GitHub pour le rafraîchissement mensuel (chaque commit de
données déclenche un redéploiement) et supprimer son job `deploiement`.

## Mise à jour des données

- Source : FMI, *World Economic Outlook*, via l'API DataMapper
  (`https://www.imf.org/external/datamapper/api/v1/<code>`).
- Le FMI publie deux éditions par an (avril et octobre).
- **Année affichée** : par défaut l'année précédente (dernière année complète).
  Si un pays n'a pas de valeur pour cette année, on prend la plus récente
  disponible et la fiche l'indique en petit à côté du chiffre.
  Dans l'édition d'avril, une partie des valeurs de l'année précédente sont
  encore des estimations du FMI.
- Garde-fous : le pipeline refuse d'écrire si moins de 150 pays sont renseignés
  (l'ancien fichier reste en ligne) et signale toute incohérence entre
  PIB, PIB/habitant et population.
- Sans accès réseau au FMI, on peut lui donner des fichiers enregistrés depuis
  le navigateur : `python3 pipeline/build_stats.py --imf-dir dossier/`
  (un fichier par code : `NGDPD.json`, `PPPGDP.json`, `NGDPDPC.json`,
  `GGXWDG_NGDP.json`, `LP.json`).

## Ajouter un indicateur

Ajouter une entrée dans `indicators` de `public/config.json`, par exemple le PIB
par habitant en PPA :

```json
{
  "id": "gdp_pc_ppp",
  "label": "PIB/hab. en PPA",
  "unit": "$ PPA",
  "format": "integer",
  "ramp": "size",
  "description": "PIB par habitant en parité de pouvoir d'achat.",
  "sources": { "countries": { "provider": "imf", "code": "PPPPC" } }
}
```

puis relancer `build_stats.py`. Codes FMI disponibles :
`https://www.imf.org/external/datamapper/api/v1/indicators`.
`format` : `billions`, `millions`, `integer` ou `percent`.
`ramp` : `size` (vert) ou `debt` (brique). `breaks` (facultatif) fixe les seuils
de couleur ; sinon ils sont calculés par quantiles.

## Ajouter un niveau (régions, cantons, États…)

Le front ne change pas : il lit `config.json`.

1. **Contours** : un GeoJSON dans `public/data/geo/`, chaque zone avec les
   propriétés `code` (identifiant unique), `name` et `bbox` `[ouest, sud, est, nord]`
   (cadrage au clic). `build_boundaries.py` montre comment les produire
   (sources possibles : Eurostat GISCO pour les NUTS, geoBoundaries ADM1 ailleurs).
2. **Données** : un connecteur dans `pipeline/providers/` qui expose
   `NAME`, `HOME`, `fetch_series(code, local_dir)` → `{code zone: {année: valeur}}`
   et `fetch_edition(...)`, déclaré dans `PROVIDERS` de `build_stats.py`.
3. **Configuration** : activer le niveau et brancher les sources par indicateur.

```json
{ "id": "regions", "label": "Régions", "available": true,
  "geometry": "data/geo/regions.geojson", "stats": "data/stats/regions.json",
  "idProperty": "code", "nameProperty": "name", "searchLabel": "une région",
  "maxZoomOnFocus": 7 }
```

```json
"sources": {
  "countries": { "provider": "imf", "code": "NGDPD" },
  "regions":   { "provider": "eurostat", "code": "nama_10r_2gdp" }
}
```

Un indicateur sans source pour un niveau est simplement masqué sur ce niveau
(par exemple la dette, rarement publiée à l'échelle régionale).
Au-delà de quelques milliers de zones (communes), passer les contours en
tuiles vectorielles PMTiles plutôt qu'en GeoJSON.

## Sources et licences

| Élément | Source | Licence |
|---|---|---|
| Indicateurs | FMI, World Economic Outlook (API DataMapper) | Conditions du FMI : https://www.imf.org/external/terms.htm (à relire avant tout usage commercial) |
| Contours | Natural Earth 1:50m | Domaine public |
| Moteur de carte | MapLibre GL JS 5.24 | BSD 3 clauses (`public/vendor/`) |
| Polices | Archivo, IBM Plex Mono (Google Fonts) | SIL Open Font License |

## Choix cartographiques

Contours Natural Earth (frontières de fait), avec quelques ajustements pour
coller aux données du FMI : Somaliland rattaché à la Somalie, Chypre du Nord à
Chypre, Kosovo et Palestine sous leurs codes FMI (`UVK`, `WBG`). Les territoires
sans données FMI (Groenland, Cuba, Corée du Nord, territoires d'outre-mer
non souverains…) sont hachurés. L'Antarctique est retiré.
