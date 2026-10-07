/* Atlas économique mondial — carte interactive.
   Tout est piloté par config.json : niveaux de découpage, indicateurs, sources.
   Ajouter un niveau = ajouter un fichier de contours, un fichier de stats
   et une entrée dans config.json ; ce fichier n'a pas à changer. */
(() => {
  'use strict';

  const LOCALE = 'fr-FR';
  const SOURCE_ID = 'zones';
  const WORLD = [[-165, -56], [180, 78]];
  const MOBILE = '(max-width: 720px)';

  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const isMobile = () => window.matchMedia(MOBILE).matches;

  const state = {
    config: null,
    level: null,
    geo: null,
    stats: null,
    byId: new Map(),       // id -> feature
    indicator: null,       // objet indicateur actif
    breaks: [],
    ranks: {},             // indicateur -> Map(id -> rang)
    totals: {},
    hoverId: null,
    selectedId: null,
    projection: 'mercator',
    map: null,
  };

  /* ---------- Formats ---------- */
  const nf = (o) => new Intl.NumberFormat(LOCALE, o);
  const F = {
    n0: nf({ maximumFractionDigits: 0 }),
    n1: nf({ minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    n2: nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    compact: nf({ notation: 'compact', maximumSignificantDigits: 2 }),
  };
  const FORMATS = {
    billions: (v) => (Math.abs(v) >= 100 ? F.n0 : Math.abs(v) >= 10 ? F.n1 : F.n2).format(v),
    millions: (v) => (Math.abs(v) >= 100 ? F.n0 : Math.abs(v) >= 1 ? F.n1 : F.n2).format(v),
    integer: (v) => F.n0.format(v),
    percent: (v) => F.n1.format(v),
  };
  const formatValue = (ind, v) => `${(FORMATS[ind.format] || F.n1.format)(v)} ${ind.unit}`;
  const ordinal = (n) => (n === 1 ? '1er' : `${n}e`);
  const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

  /* ---------- Données ---------- */
  async function loadJSON(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${url} : ${r.status}`);
    return r.json();
  }

  function valueOf(id, indId) {
    const rec = state.stats?.values?.[id]?.[indId];
    return rec && typeof rec.v === 'number' ? rec : null;
  }

  function computeRanks() {
    state.ranks = {};
    state.totals = {};
    for (const ind of state.config.indicators) {
      const rows = [];
      for (const id of state.byId.keys()) {
        const rec = valueOf(id, ind.id);
        if (rec) rows.push([id, rec.v]);
      }
      rows.sort((a, b) => b[1] - a[1]);
      state.ranks[ind.id] = new Map(rows.map(([id], i) => [id, i + 1]));
      state.totals[ind.id] = rows.length;
    }
  }

  function computeBreaks(ind) {
    if (Array.isArray(ind.breaks) && ind.breaks.length) return ind.breaks.slice();
    const vals = [];
    for (const id of state.byId.keys()) {
      const rec = valueOf(id, ind.id);
      if (rec) vals.push(rec.v);
    }
    vals.sort((a, b) => a - b);
    const classes = 7;
    const out = [];
    for (let k = 1; k < classes; k++) {
      const q = vals[Math.min(vals.length - 1, Math.floor((k * vals.length) / classes))];
      if (q === undefined) continue;
      const r = Number(q.toPrecision(2));
      if (!out.length || r > out[out.length - 1]) out.push(r);
    }
    return out;
  }

  function rampColors(ramp, n) {
    const all = Array.from({ length: 7 }, (_, i) => css(`--${ramp}-${i + 1}`));
    if (n >= 7) return all;
    return Array.from({ length: n }, (_, i) => all[Math.round((i * 6) / Math.max(1, n - 1))]);
  }

  /* ---------- Carte ---------- */
  function graticule() {
    const lines = [];
    for (let lon = -180; lon <= 180; lon += 30) {
      const c = [];
      for (let lat = -80; lat <= 85; lat += 2.5) c.push([lon, lat]);
      lines.push(c);
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const c = [];
      for (let lon = -180; lon <= 180; lon += 2.5) c.push([lon, lat]);
      lines.push(c);
    }
    return { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } };
  }

  function hatchImage() {
    const s = 6;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    g.strokeStyle = css('--hatch');
    g.lineWidth = 1;
    g.beginPath();
    for (const o of [-s, 0, s]) { g.moveTo(o, s); g.lineTo(o + s, 0); }
    g.stroke();
    const img = g.getImageData(0, 0, s, s);
    return { width: s, height: s, data: new Uint8Array(img.data.buffer) };
  }

  function fillColorExpr() {
    const colors = rampColors(state.indicator.ramp || 'size', state.breaks.length + 1);
    const step = ['step', ['feature-state', 'v'], colors[0]];
    state.breaks.forEach((b, i) => step.push(b, colors[i + 1]));
    return ['case', ['==', ['typeof', ['feature-state', 'v']], 'number'], step, css('--nodata')];
  }

  function buildMap() {
    const map = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        projection: { type: 'mercator' },
        sources: {},
        layers: [{ id: 'sea', type: 'background', paint: { 'background-color': css('--sea') } }],
      },
      bounds: WORLD,
      fitBoundsOptions: { padding: worldPadding() },
      renderWorldCopies: false,
      minZoom: 0.4,
      maxZoom: 8,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: { compact: true, customAttribution: 'Contours : Natural Earth · Données : FMI' },
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    state.map = map;

    map.on('load', () => {
      map.addImage('hatch', hatchImage());
      map.addSource('graticule', { type: 'geojson', data: graticule() });
      map.addLayer({ id: 'graticule', type: 'line', source: 'graticule',
        paint: { 'line-color': css('--graticule'), 'line-width': 0.8 } });
      addZoneLayers();
      bindMapEvents();
      applyIndicator();
      fitWorld(0);
      const fromHash = decodeURIComponent(location.hash.slice(1));
      if (state.byId.has(fromHash)) select(fromHash, { fly: true });
    });
    return map;
  }

  const ZONE_LAYERS = ['zones-fill', 'zones-nodata', 'zones-border', 'zones-outline'];

  function addZoneLayers() {
    const map = state.map;
    map.addSource(SOURCE_ID, { type: 'geojson', data: state.geo, promoteId: state.level.idProperty || 'code' });
    map.addLayer({ id: 'zones-fill', type: 'fill', source: SOURCE_ID,
      paint: { 'fill-color': css('--nodata') } });
    map.addLayer({ id: 'zones-nodata', type: 'fill', source: SOURCE_ID,
      paint: { 'fill-pattern': 'hatch' }, filter: ['boolean', false] });
    map.addLayer({ id: 'zones-border', type: 'line', source: SOURCE_ID,
      paint: { 'line-color': css('--border'), 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 5, 1.2] } });
    map.addLayer({ id: 'zones-outline', type: 'line', source: SOURCE_ID,
      paint: {
        'line-color': css('--select'),
        'line-width': ['case',
          ['boolean', ['feature-state', 'selected'], false], 2.2,
          ['boolean', ['feature-state', 'hover'], false], 1.4, 0],
      } });
  }

  function removeZoneLayers() {
    const map = state.map;
    for (const id of ZONE_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  }

  function setFS(id, s) {
    if (id != null) state.map.setFeatureState({ source: SOURCE_ID, id }, s);
  }

  function applyIndicator() {
    const map = state.map;
    const ind = state.indicator;
    state.breaks = computeBreaks(ind);
    const withData = [];
    for (const id of state.byId.keys()) {
      const rec = valueOf(id, ind.id);
      setFS(id, { v: rec ? rec.v : null });
      if (rec) withData.push(id);
    }
    map.setPaintProperty('zones-fill', 'fill-color', fillColorExpr());
    map.setFilter('zones-nodata', ['!', ['in', ['get', state.level.idProperty || 'code'], ['literal', withData]]]);
    renderLegend();
    if (state.selectedId) renderDetail(state.selectedId);
  }

  function applyTheme() {
    const map = state.map;
    if (!map || !map.isStyleLoaded()) return;
    map.setPaintProperty('sea', 'background-color', css('--sea'));
    map.setPaintProperty('graticule', 'line-color', css('--graticule'));
    map.setPaintProperty('zones-border', 'line-color', css('--border'));
    map.setPaintProperty('zones-outline', 'line-color', css('--select'));
    map.setPaintProperty('zones-fill', 'fill-color', fillColorExpr());
    map.updateImage('hatch', hatchImage());
    if (state.selectedId) renderDetail(state.selectedId);
  }

  /* ---------- Cadrage ---------- */
  function clampPadding(p) {
    const w = state.map ? state.map.getContainer().clientWidth : innerWidth;
    const h = state.map ? state.map.getContainer().clientHeight : innerHeight;
    const sx = Math.min(1, (w - 80) / Math.max(1, p.left + p.right));
    const sy = Math.min(1, (h - 80) / Math.max(1, p.top + p.bottom));
    return { top: p.top * sy, bottom: p.bottom * sy, left: p.left * sx, right: p.right * sx };
  }

  function worldPadding() {
    if (isMobile()) return clampPadding({ top: 150, bottom: 170, left: 8, right: 8 });
    return clampPadding({ top: 24, bottom: 24, left: 24, right: 24 });
  }

  function focusPadding() {
    const ctrl = document.querySelector('.panel--control').getBoundingClientRect();
    const legend = document.querySelector('.panel--legend').getBoundingClientRect();
    if (isMobile()) {
      const detail = $('detail');
      const bottomEdge = detail.hidden ? legend.top : detail.getBoundingClientRect().top;
      return clampPadding({ top: ctrl.bottom + 16, bottom: innerHeight - bottomEdge + 16, left: 24, right: 24 });
    }
    return clampPadding({ top: 48, bottom: innerHeight - legend.top + 24, left: ctrl.right + 32, right: 360 });
  }

  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function fitWorld(duration = 900) {
    state.map.fitBounds(WORLD, { padding: worldPadding(), duration: reducedMotion() ? 0 : duration });
  }

  function focus(id) {
    const f = state.byId.get(id);
    const b = f?.properties?.bbox;
    if (!b) return;
    const bbox = typeof b === 'string' ? JSON.parse(b) : b;
    const cam = state.map.cameraForBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: focusPadding() });
    if (!cam) return;
    // Un léger recul garde les pays voisins dans le champ.
    const zoom = Math.min(cam.zoom - 0.35, state.level.maxZoomOnFocus || 6);
    state.map.flyTo({ center: cam.center, zoom, duration: reducedMotion() ? 0 : 1100, essential: true });
  }

  /* ---------- Sélection & survol ---------- */
  function select(id, { fly = true } = {}) {
    if (state.selectedId && state.selectedId !== id) setFS(state.selectedId, { selected: false });
    state.selectedId = id;
    setFS(id, { selected: true });
    renderDetail(id);
    $('detail').hidden = false;
    hideTip();
    try { history.replaceState(null, '', `#${encodeURIComponent(id)}`); } catch (_) { /* cadre restreint */ }
    if (fly) requestAnimationFrame(() => focus(id));
  }

  function clearSelection() {
    if (state.selectedId) setFS(state.selectedId, { selected: false });
    state.selectedId = null;
    $('detail').hidden = true;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* idem */ }
  }

  function bindMapEvents() {
    const map = state.map;
    map.on('mousemove', 'zones-fill', (e) => {
      const f = e.features && e.features[0];
      if (!f) return;
      if (state.hoverId !== f.id) {
        setFS(state.hoverId, { hover: false });
        state.hoverId = f.id;
        setFS(f.id, { hover: true });
      }
      map.getCanvas().style.cursor = 'pointer';
      if (!isMobile()) showTip(f.id, e.point);
    });
    map.on('mouseleave', 'zones-fill', () => {
      setFS(state.hoverId, { hover: false });
      state.hoverId = null;
      map.getCanvas().style.cursor = '';
      hideTip();
    });
    map.on('click', (e) => {
      const f = map.queryRenderedFeatures(e.point, { layers: ['zones-fill'] })[0];
      if (f) select(f.id);
      else clearSelection();
    });
    map.on('movestart', hideTip);
  }

  /* ---------- Rendu : infobulle, fiche ---------- */
  function figuresHTML(id) {
    const ref = state.stats.referenceYear;
    return state.config.indicators.map((ind) => {
      const rec = valueOf(id, ind.id);
      const active = ind.id === state.indicator.id ? ' class="is-active"' : '';
      const val = rec
        ? `${formatValue(ind, rec.v)}${rec.y !== ref ? `<small>${rec.y}</small>` : ''}`
        : '<span class="na">n.d.</span>';
      return `<div${active}><dt>${ind.label}</dt><dd>${val}</dd></div>`;
    }).join('');
  }

  function rankText(id) {
    const ind = state.indicator;
    const r = state.ranks[ind.id]?.get(id);
    if (!r) return `Pas de donnée « ${ind.label} » pour ce territoire`;
    return `${ordinal(r)} sur ${state.totals[ind.id]} · ${ind.label}`;
  }

  function nameOf(id) {
    const f = state.byId.get(id);
    return f ? f.properties[state.level.nameProperty || 'name'] : id;
  }

  function showTip(id, point) {
    const tip = $('tip');
    const hasAny = state.stats.values[id];
    tip.innerHTML = `<p class="tip__name">${nameOf(id)}</p>` + (hasAny
      ? `<p class="tip__rank">${rankText(id)}</p><dl class="figures">${figuresHTML(id)}</dl>`
      : '<p class="tip__rank">Pas de données FMI pour ce territoire</p>');
    tip.hidden = false;
    const box = state.map.getContainer().getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let x = point.x + 18;
    let y = point.y + 18;
    if (x + w > box.width - 12) x = point.x - w - 18;
    if (y + h > box.height - 12) y = Math.max(12, point.y - h - 18);
    tip.style.transform = `translate(${Math.max(12, x)}px, ${y}px)`;
    tip.style.left = '0';
    tip.style.top = '0';
  }

  function hideTip() { $('tip').hidden = true; }

  function sparkSVG(rec, ind) {
    const pts = (rec?.h || []).filter((p) => typeof p[1] === 'number');
    if (pts.length < 3) return '';
    const W = 268, H = 64, padL = 2, padR = 2, padT = 6, padB = 16;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    let y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (y0 === y1) { y0 -= 1; y1 += 1; }
    const X = (x) => padL + ((x - x0) / (x1 - x0)) * (W - padL - padR);
    const Y = (y) => padT + (1 - (y - y0) / (y1 - y0)) * (H - padT - padB);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    const base = H - padB;
    const area = `${line}L${X(x1).toFixed(1)},${base}L${X(x0).toFixed(1)},${base}Z`;
    const ramp = ind.ramp || 'size';
    const last = pts[pts.length - 1];
    return `<figcaption>${ind.label}, ${x0}–${x1}</figcaption>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution ${ind.label} de ${x0} à ${x1}">
        <line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="${css('--rule')}" stroke-width="1"/>
        <path d="${area}" fill="${css(`--${ramp}-2`)}" fill-opacity="0.55"/>
        <path d="${line}" fill="none" stroke="${css(`--${ramp}-6`)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${X(last[0])}" cy="${Y(last[1])}" r="3.5" fill="${css(`--${ramp}-6`)}" stroke="${css('--panel-solid')}" stroke-width="2"/>
        <text x="0" y="${H - 3}">${x0}</text>
        <text x="${W}" y="${H - 3}" text-anchor="end">${x1}</text>
      </svg>`;
  }

  function sourceLink(id, ind) {
    const src = state.stats.indicators?.[ind.id];
    if (!src) return null;
    if (src.provider === 'imf') return `https://www.imf.org/external/datamapper/${src.code}@WEO/${encodeURIComponent(id)}`;
    return state.stats.sources?.[src.provider]?.url || null;
  }

  function renderDetail(id) {
    const ind = state.indicator;
    $('detail-name').textContent = nameOf(id);
    const hasAny = state.stats.values[id];
    $('detail-rank').textContent = hasAny ? rankText(id) : 'Pas de données FMI pour ce territoire';
    $('detail-figures').innerHTML = hasAny ? figuresHTML(id) : '';
    $('detail-spark').innerHTML = sparkSVG(valueOf(id, ind.id), ind);
    const link = sourceLink(id, ind);
    const a = $('detail-source');
    a.hidden = !(link && valueOf(id, ind.id));
    if (link) a.href = link;
  }

  /* ---------- Rendu : panneaux ---------- */
  function renderLevels() {
    const box = $('levels');
    box.innerHTML = '';
    for (const lv of state.config.levels) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'level';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(lv.id === state.level.id));
      b.innerHTML = `${lv.label}${lv.available ? '' : ' <small>bientôt</small>'}`;
      if (lv.available) b.addEventListener('click', () => switchLevel(lv.id));
      else { b.disabled = true; b.title = lv.note || 'Bientôt disponible'; }
      box.appendChild(b);
    }
  }

  function renderIndicators() {
    const box = $('indicators');
    box.querySelectorAll('.ind').forEach((n) => n.remove());
    for (const ind of state.config.indicators) {
      if (!ind.sources?.[state.level.id]) continue;
      const label = document.createElement('label');
      label.className = 'ind';
      label.dataset.ramp = ind.ramp || 'size';
      label.title = ind.description || '';
      label.innerHTML = `<input type="radio" name="indicator" id="ind-${ind.id}" value="${ind.id}">
        <span class="ind__mark" aria-hidden="true"></span>
        <span class="ind__label">${ind.label}</span>
        <span class="ind__unit">${ind.unit}</span>`;
      const input = label.querySelector('input');
      input.checked = ind.id === state.indicator.id;
      input.addEventListener('change', () => {
        state.indicator = ind;
        try { localStorage.setItem('atlas-indicator', ind.id); } catch (_) { /* stockage indisponible */ }
        applyIndicator();
      });
      box.appendChild(label);
    }
  }

  function renderLegend() {
    const ind = state.indicator;
    const n = state.breaks.length + 1;
    const ramp = ind.ramp || 'size';
    const idx = Array.from({ length: n }, (_, i) => (n >= 7 ? i + 1 : Math.round((i * 6) / Math.max(1, n - 1)) + 1));
    $('legend-title').textContent = `${ind.label} · ${ind.unit} · ${state.stats.referenceYear}`;
    const fmt = (v) => (ind.format === 'percent' ? F.n0.format(v) : F.compact.format(v));
    const pct = (i) => ((i + 1) / n) * 100;
    const ticks = state.breaks.map((b, i) =>
      `<span style="left:calc((100% - 42px) * ${pct(i) / 100})">${fmt(b)}</span>`).join('');
    $('legend').innerHTML = `
      <div class="legend__bar" style="--n:${n}">
        ${idx.map((k) => `<span style="background:var(--${ramp}-${k})"></span>`).join('')}
        <span class="nd" title="Pas de données"></span>
      </div>
      <div class="legend__ticks">${ticks}<span class="nd-label">n.d.</span></div>`;
  }

  function renderCredits() {
    const s = state.stats;
    const nb = '\u00a0';
    const srcs = Object.values(s.sources || {});
    const label = (x) => `${x.name}, ${x.edition || 'édition non précisée'}`;
    const links = srcs.map((x) => `<a href="${x.url}" target="_blank" rel="noopener">${label(x)}</a>`).join(' ; ');
    const updated = s.generatedAt
      ? new Date(s.generatedAt).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' }).replace(/ /g, nb) : '';
    $('edition-line').textContent = `${srcs.map((x) => `${x.name} · ${x.edition || ''}`).join(' · ')} · données ${s.referenceYear}`;
    $('credits').innerHTML =
      `Source${nb}: ${links}. ` +
      `<span class="credits__long">Valeurs ${s.referenceYear}, en partie estimées selon les pays${nb}; une année en petit à côté d'un chiffre signale une donnée plus ancienne. ` +
      `Contours Natural Earth, frontières indicatives.${updated ? ` Mise à jour${nb}: ${updated}.` : ''}</span>`;
  }

  function renderSearch() {
    const names = [...state.byId.keys()].map((id) => [id, nameOf(id)]).sort((a, b) => a[1].localeCompare(b[1], LOCALE));
    $('country-list').innerHTML = names.map(([, n]) => `<option value="${n.replace(/"/g, '&quot;')}"></option>`).join('');
    $('search').placeholder = `Rechercher ${state.level.searchLabel || 'un pays'}`;
    state.search = { names, index: new Map(names.map(([id, n]) => [strip(n), id])) };
  }

  function runSearch() {
    const q = strip($('search').value);
    if (!q || !state.search) return;
    const { names, index } = state.search;
    let id = index.get(q);
    if (!id) {
      const hit = names.find(([, n]) => strip(n).startsWith(q)) || names.find(([, n]) => strip(n).includes(q));
      id = hit && hit[0];
    }
    if (id) { select(id); $('search').blur(); }
  }

  function bindUI() {
    $('search').addEventListener('change', runSearch);
    $('search').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
    $('detail-close').addEventListener('click', clearSelection);
    $('reset-view').addEventListener('click', () => { clearSelection(); fitWorld(); });
    $('projection-toggle').addEventListener('click', (e) => {
      state.projection = state.projection === 'globe' ? 'mercator' : 'globe';
      state.map.setProjection({ type: state.projection });
      e.currentTarget.setAttribute('aria-pressed', String(state.projection === 'globe'));
      document.documentElement.classList.toggle('is-globe', state.projection === 'globe');
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') clearSelection(); });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
    new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  function showStatus(msg) {
    const s = $('status');
    s.textContent = msg;
    s.hidden = false;
  }

  /* ---------- Niveaux ---------- */
  async function loadLevel(level) {
    const [geo, stats] = await Promise.all([loadJSON(level.geometry), loadJSON(level.stats)]);
    const idProp = level.idProperty || 'code';
    state.level = level;
    state.geo = geo;
    state.stats = stats;
    state.byId = new Map(geo.features.map((f) => [f.properties[idProp], f]));

    let saved = null;
    try { saved = localStorage.getItem('atlas-indicator'); } catch (_) { /* stockage indisponible */ }
    const usable = state.config.indicators.filter((i) => i.sources?.[level.id]);
    if (!state.indicator || !usable.includes(state.indicator)) {
      state.indicator = usable.find((i) => i.id === saved) || usable[0];
    }
    computeRanks();
  }

  function renderPanels() {
    renderLevels();
    renderIndicators();
    renderCredits();
    renderSearch();
  }

  async function switchLevel(id) {
    const lv = state.config.levels.find((l) => l.id === id && l.available);
    if (!lv || lv === state.level) return;
    clearSelection();
    hideTip();
    state.hoverId = null;
    try {
      await loadLevel(lv);
    } catch (err) {
      console.error(err);
      showStatus(`Le découpage « ${lv.label} » n'a pas pu être chargé.`);
      return;
    }
    removeZoneLayers();
    addZoneLayers();
    renderPanels();
    applyIndicator();
  }

  /* ---------- Démarrage ---------- */
  async function start() {
    try {
      state.config = await loadJSON('config.json');
      await loadLevel(state.config.levels.find((l) => l.available));
      renderPanels();
      bindUI();
      buildMap();
    } catch (err) {
      console.error(err);
      showStatus('Les données de la carte n\u2019ont pas pu être chargées. Rechargez la page ; si le problème persiste, relancez le pipeline de données.');
    }
  }

  start();
})();
