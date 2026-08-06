
class Component extends DCLogic {
  state = {
    collapsed: false,
    activeModule: 'dailyOps',
    cfgTab: 'baseline', cfgSel: '1-136-0-Q', cfgCarried: {}, cfgAccepted: {}, cfgToast: null,
    doZone: 'all',
    persona: 'Planner',
    contextId: 'cvn73',
    openMenu: null,
    subTab: 'overview',
    deDeck: '4th',
    deMode: 'drawing',
    deWeek: 5,
    deSel: null,
    deFSev: 'all',
    deFClass: 'all',
    deFTrade: 'all',
    deFEvent: 'all',
    deReview: {},
    deScale: 1, dePanX: 0, dePanY: 0, deNatW: 0, deNatH: 0, deReady: false, deDragging: false,
    deView: 'single', vScale: 0.13, vPanX: 0, vReady: false, deSpaceLayer: true, deHoverXFrac: null, deHoverComp: null,
    deFull: false, deFullVH: (typeof window !== 'undefined' ? window.innerHeight : 800),
    deAlt: null, deLens: 'space', deZoneSel: null, deReadiness: true, deLead: 'all', deShow: 'all', deZoneComp: null, deDir: 'all', deTradeSel: null,
    woSearch: '', woType: 'all', woTrade: 'all', woDeck: 'all', woStatus: 'all', woSystem: 'all', woEvent: 'all', woGrowth: 'all', woConflict: 'all', woMaterial: 'all', woSpace: 'all',
    woSort: 'id', woGroup: 'none', woDensity: 'comfortable', woSel: null, woDetailTab: 'overview', woSourceId: null, woChecked: {}, woColsOpen: false, woCols: {}, woToast: null,
    yrTab: 'map', yrSel: null, yrCrane: true, yrLaydown: true, yrShore: false, yrSupplyLines: false, yrSupplyStatus: 'all', yrEdit: false, yrMapFull: false, yrHull: 'all', yrCritOnly: false,
    sbGroup: 'zone', sbReleasedOnly: false, sbGasLayer: false, sbSandbox: false, sbSel: null, sbShift: {}, sbCollapsed: {}, sbProposed: false,
    sbConflictSel: null, sbFixSel: null, sbApplied: null, sbConflictsOnly: false, sbLegendOpen: true, sbToast: null,
    crSort: 'sev', crClass: 'all', crSev: 'all', crCP: 'all', crDeck: 'all', crTrade: 'all', crAvail: 'all', crEvent: 'all', crSearch: '', crSel: null, crStatus: {}, crOwner: {}, crChecked: {}, crMatrix: null, crToast: null,
    sbDragging: false,
    sbView: 'avail', wpShift: {}, wpZone: 'all', wpCommitted: false, wpDragging: false,
    satSel: null, msToast: null, decisions: [], dlOpen: false, dlCopied: null,
    doView: 'shift', hwActed: {}, wallMode: false, wadlFeed: [],
  };
  logDecision(entry) {
    const t = new Date();
    const stamp = 'D' + String(t.getHours()).padStart(2, '0') + String(t.getMinutes()).padStart(2, '0') + '.' + (this.state.decisions.length + 1);
    this.setState((st) => ({ decisions: [Object.assign({ id: stamp, when: 'W' + (st.deWeek || 5) + ' · today' }, entry)].concat(st.decisions) }));
  }

  _onWpTrackRef = (el) => { if (el) this._wpTrack = el; };
  _wpDrag = (id, e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
    const track = this._wpTrack, dayW = (track ? track.clientWidth : 700) / 7;
    const startX = e.clientX, base = this.state.wpShift[id] || 0;
    let last = base, moved = false;
    const move = (ev) => {
      const d = Math.round((ev.clientX - startX) / dayW);
      if (!moved && d !== 0) { moved = true; this.setState({ wpDragging: true, wpCommitted: false }); }
      if (base + d === last) return; last = base + d;
      this.setState((s) => ({ wpShift: Object.assign({}, s.wpShift, { [id]: base + d }) }));
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); if (moved) this.setState({ wpDragging: false }); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  _onSbTrackRef = (el) => { if (el) this._sbTrack = el; };
  _sbBarDown = (id, e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    if (e && e.preventDefault) e.preventDefault();
    const track = this._sbTrack, weekW = (track ? track.clientWidth : 800) / 26;
    const startX = e.clientX, base = this.state.sbShift[id] || 0;
    let moved = false, last = base;
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - startX) > 5) { moved = true; if (!this.state.sbSandbox) this.setState({ sbSandbox: true, sbConflictSel: null, sbFixSel: null, sbApplied: null, sbSel: null }); this.setState({ sbDragging: true }); }
      if (!moved) return;
      const d = Math.round((ev.clientX - startX) / weekW);
      if (d === last) return;
      last = d;
      this.setState((s) => ({ sbShift: Object.assign({}, s.sbShift, { [id]: base + d }), sbProposed: false }));
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); if (moved) this.setState({ sbDragging: false }); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };
  sbReset = () => this.setState({ sbShift: {}, sbProposed: false });
  sbPropose = () => this.setState({ sbProposed: true });

  _onVCanvasRef = (el) => {
    if (el === this._vcv) return;
    if (this._vcv && this._vWheel) this._vcv.removeEventListener('wheel', this._vWheel);
    this._vcv = el || null;
    if (this._vcv) this._vcv.addEventListener('wheel', this._vWheel, { passive: false });
  };
  _vMin = () => this._vcv ? this._vcv.clientWidth / 7000 * 0.85 : 0.04;
  _vWheel = (e) => {
    if (this.state.deView !== 'vertical') return;
    const cv = this._vcv; if (!cv) return;
    e.preventDefault();
    const rect = cv.getBoundingClientRect();
    const cx = e.clientX - rect.left, s = this.state.vScale;
    const ns = Math.max(this._vMin(), Math.min(2.4, s * (e.deltaY < 0 ? 1.12 : 0.893)));
    const cox = (cx - this.state.vPanX) / s;
    this.setState({ vScale: ns, vPanX: cx - cox * ns });
  };
  _vPanStart = (e) => {
    if (this.state.deView !== 'vertical') return;
    const sx = e.clientX, px = this.state.vPanX;
    const move = (ev) => this.setState({ vPanX: px + (ev.clientX - sx), deDragging: true });
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); this.setState({ deDragging: false }); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };
  _onVImgLoad = () => { if (!this.state.vReady && this._vcv) this.setState({ vScale: this._vcv.clientWidth / 7000, vPanX: 0, vReady: true }); };
  vFit = () => { if (this._vcv) this.setState({ vScale: this._vcv.clientWidth / 7000, vPanX: 0 }); };
  vZoomBtn = (f) => { const cv = this._vcv; if (!cv) return; const cx = cv.clientWidth / 2, s = this.state.vScale; const ns = Math.max(this._vMin(), Math.min(2.4, s * f)); const cox = (cx - this.state.vPanX) / s; this.setState({ vScale: ns, vPanX: cx - cox * ns }); };
  _hoverEnter = (data) => (e) => {
    const cv = this._vcv;
    if (!cv || !e || !e.currentTarget) { this.setState({ deHoverXFrac: data.xFrac, deHoverComp: data }); return; }
    const r = e.currentTarget.getBoundingClientRect();
    const cr = cv.getBoundingClientRect();
    this.setState({ deHoverXFrac: data.xFrac, deHoverComp: Object.assign({}, data, {
      cx: Math.round(r.left + r.width / 2 - cr.left),
      cy: Math.round(r.top - cr.top),
      bh: Math.round(r.height),
      cw: Math.round(cr.width),
      ch: Math.round(cr.height),
    }) });
  };

  _onCanvasRef = (el) => {
    if (el === this._cv) return;
    if (this._cv && this._deWheel) this._cv.removeEventListener('wheel', this._deWheel);
    this._cv = el || null;
    if (this._cv) this._cv.addEventListener('wheel', this._deWheel, { passive: false });
  };
  _deWheel = (e) => {
    if (this.state.deMode !== 'drawing' || !this.state.deReady) return;
    const cv = this._cv; if (!cv) return;
    e.preventDefault();
    const rect = cv.getBoundingClientRect();
    this.deZoomAbout(e.deltaY < 0 ? 1.12 : 0.893, e.clientX - rect.left, e.clientY - rect.top);
  };
  _minScale = () => Math.min(0.25, this._cv && this.state.deNatW ? this._cv.clientWidth / this.state.deNatW : 0.1);
  deFit = (kind, natW, natH) => {
    const cv = this._cv; if (!cv) return;
    natW = natW || this.state.deNatW; natH = natH || this.state.deNatH;
    if (!natW || !natH) return;
    const cw = cv.clientWidth, ch = cv.clientHeight;
    let scale = cw / natW;
    if (kind === 'deck') scale = Math.min(cw / natW, ch / natH);
    else if (kind === '100') scale = 1;
    this.setState({ deNatW: natW, deNatH: natH, deScale: scale, dePanX: (cw - natW * scale) / 2, dePanY: (ch - natH * scale) / 2, deReady: true });
  };
  deZoomAbout = (factor, cx, cy) => {
    const s = this.state.deScale;
    const ns = Math.max(this._minScale(), Math.min(4, s * factor));
    const cox = (cx - this.state.dePanX) / s, coy = (cy - this.state.dePanY) / s;
    this.setState({ deScale: ns, dePanX: cx - cox * ns, dePanY: cy - coy * ns });
  };
  deZoomBtn = (factor) => { const cv = this._cv; if (cv) this.deZoomAbout(factor, cv.clientWidth / 2, cv.clientHeight / 2); };
  _onImgLoad = (e) => { this.deFit('width', e.target.naturalWidth, e.target.naturalHeight); };
  _onPanStart = (e) => {
    if (this.state.deMode !== 'drawing') return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, px = this.state.dePanX, py = this.state.dePanY;
    let moved = false;
    const move = (ev) => { moved = true; this.setState({ dePanX: px + (ev.clientX - sx), dePanY: py + (ev.clientY - sy), deDragging: true }); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); this.setState({ deDragging: false }); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };
  componentDidMount() {
    // Shared operating context — see shipyard-context.js. The shell's availability
    // ids are hull ids, so the mapping is the identity; personas map through the
    // module's table because the shell's set is planning-side, not deckplate-side.
    const personaMetaKeys = ['Planner', 'Zone Manager', 'Production Super', 'Project Super', 'IPT', 'Program Office', 'Material Manager', 'Executive'];
    if (window.ShipyardCtx) {
      const C = window.ShipyardCtx;
      this._ctxSub = C.subscribe(ctx => {
        const patch = {};
        if (ctx.vessel) {
          if (C.canHonour('shell', ctx.vessel)) {
            const id = ctx.vessel.toLowerCase().replace('-', '');
            if (id !== this.state.contextId) patch.contextId = id;
            if (this.state.ctxUnscoped) patch.ctxUnscoped = null;
          } else if (this.state.ctxUnscoped !== ctx.vessel) {
            // The operating context names a hull this portfolio has no availability
            // for. Say so — continuing to render the previous hull's shift plan and
            // critical path with no indication is worse than not syncing at all.
            patch.ctxUnscoped = ctx.vessel;
          }
        }
        // Guard the mapping: a persona the shell does not model must leave the
        // shell's own selection alone rather than putting it into a bad state.
        // personaById returns null for an id we do not model; leave our own
        // selection alone rather than defaulting into a view nobody asked for.
        const p = C.personaById(ctx.persona);
        if (p && p.shell && p.shell !== this.state.persona && personaMetaKeys.indexOf(p.shell) >= 0) patch.persona = p.shell;
        if (Object.keys(patch).length) this.setState(patch);
      });
      this._ctxPush = (patch) => C.write(patch, 'shell');
    } else { this._ctxPush = () => {}; }
    this._wadlPoll = setInterval(() => {
      try {
        const raw = localStorage.getItem('wadl_feed') || '[]';
        if (raw !== this._wadlRaw) { this._wadlRaw = raw; this.setState({ wadlFeed: JSON.parse(raw) }); }
      } catch (e) {}
    }, 2000);
    this._onResize = () => { if (this.state.deFull) this.setState({ deFullVH: window.innerHeight }); };
    this._onKey = (e) => { if (e.key === 'Escape' && this.state.deFull) this.setState({ deFull: false }); };
    window.addEventListener('resize', this._onResize);
    window.addEventListener('keydown', this._onKey);
  }
  componentWillUnmount() {
    if (this._wadlPoll) clearInterval(this._wadlPoll);
    if (this._cv && this._deWheel) this._cv.removeEventListener('wheel', this._deWheel);
    if (this._vcv && this._vWheel) this._vcv.removeEventListener('wheel', this._vWheel);
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    if (this._onKey) window.removeEventListener('keydown', this._onKey);
    if (this._map) { try { this._map.remove(); } catch (e) {} this._map = null; }
  }
  componentDidUpdate() {
    if (this._map && this.state.activeModule === 'yardResources' && this.state.yrTab === 'map') {
      try { this._map.invalidateSize(); } catch (e) {}
      this._drawMap();
      const full = !!this.state.yrMapFull;
      if (this._wasFull !== full) {
        this._wasFull = full;
        setTimeout(() => { try { this._map.invalidateSize(); if (full) this._fitNetwork(); else { const g = this.yardGeo(); this._map.setView(g.center, g.zoom); } } catch (e) {} }, 90);
      }
    }
  }
  _distM(a, b) { const R = 6371000, dLat = (b[0] - a[0]) * Math.PI / 180, dLng = (b[1] - a[1]) * Math.PI / 180, la = a[0] * Math.PI / 180, lb = b[0] * Math.PI / 180; const x = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
  _supVisible(m) { const h = this.state.yrHull; if (h && h !== 'all' && m.hull !== h) return false; if (this.state.yrCritOnly && m.status === 'on_track') return false; return true; }
  _fitNetwork() {
    const L = window.L, g = this.yardGeo(); const pts = g.berths.map((b) => [b.lat, b.lng]);
    this.supplyData().filter((m) => this._supVisible(m)).forEach((m) => pts.push(m.oll));
    if (pts.length > 1) { try { this._map.fitBounds(L.latLngBounds(pts).pad(0.12)); } catch (e) {} }
  }
  _drawCarrier(b) {
    const L = window.L;
    if (this._carrierImg) { try { this._carrierImg.remove(); } catch (e) {} this._carrierImg = null; }
    // local (along-ship m, athwartship m) → latlng, oriented to the dock heading. To scale: 333 m LOA × 77 m max beam.
    const ax = (along, athwart) => { const p = this._offset(b.lat, b.lng, along, b.hdg); return this._offset(p[0], p[1], athwart, b.hdg + 90); };
    // CV flight-deck planform (bow −along, starboard +athwart) — to scale, 333 m LOA, with canted deck
    const sel = this.state.yrSel === 'dock:DD4';
    const edge = sel ? '#3D6BFF' : '#bcd6ee';
    const poly = (pts, fill, sw) => L.polygon(pts.map((p) => ax(p[0], p[1])), { color: edge, weight: sw, fill: true, fillColor: fill, fillOpacity: 0.96, interactive: false }).addTo(this._mg.berth);
    poly([[-160, -32], [10, -32], [25, -44], [120, -50], [167, -50], [167, 30], [150, 33], [-150, 33], [-167, 16], [-167, -16]], sel ? '#2f6da3' : '#34557a', 2.2);
    // deck-edge elevators
    poly([[-150, 33], [-150, 42], [-110, 42], [-110, 33]], '#2c4a6b', 1.2);
    poly([[-40, 33], [-40, 42], [5, 42], [5, 33]], '#2c4a6b', 1.2);
    poly([[55, -50], [55, -60], [110, -60], [110, -50]], '#2c4a6b', 1.2);
    // island (starboard, fwd of midships)
    poly([[-95, 33], [-55, 33], [-55, 47], [-95, 47]], '#13283d', 1.4);
    // deck markings: axial catapult line + canted landing-deck line
    L.polyline([ax(160, 0), ax(-150, 0)], { color: 'rgba(255,255,255,0.30)', weight: 1, dashArray: '8 7', interactive: false }).addTo(this._mg.berth);
    L.polyline([ax(150, -44), ax(-120, -6)], { color: 'rgba(255,255,255,0.24)', weight: 1, dashArray: '8 7', interactive: false }).addTo(this._mg.berth);
  }

  // ---- NNSY geographic map (Leaflet) ----
  _place() { if (!this.__place) { try { this.__place = JSON.parse(localStorage.getItem('shipyard.onboard.yard.place') || '{}'); } catch (e) { this.__place = {}; } } return this.__place; }
  _savePlace() { try { localStorage.setItem('shipyard.onboard.yard.place', JSON.stringify(this.__place || {})); } catch (e) {} }
  _resetPlace() { this.__place = {}; try { localStorage.removeItem('shipyard.onboard.yard.place'); } catch (e) {} if (this._map) this._drawMap(); }
  yardGeo() {
    const P = this._place();
    const mp = (o) => { const v = P[o.id] || {}; return Object.assign({}, o, { lat: v.lat != null ? v.lat : o.lat, lng: v.lng != null ? v.lng : o.lng, hdg: v.hdg != null ? v.hdg : o.hdg }); };
    return {
      center: [36.81055, -76.29725], zoom: 17,
      berths: this.berthData().map(mp),
      cranes: [
        { id: 'PC12', label: 'Portal Crane 12', cap: '50 LT', lat: 36.81085, lng: -76.29705, r: 130 },
        { id: 'PC14', label: 'Portal Crane 14', cap: '50 LT', lat: 36.80995, lng: -76.29805, r: 150 },
      ].map(mp),
      rail: [[36.81115, -76.29675], [36.80965, -76.29835]],
      laydowns: [
        { id: 'LA', label: 'Lay-down Apron A', use: 'CVN-73 staging', lat: 36.81145, lng: -76.29625, hdg: 62, dims: [120, 70] },
        { id: 'LB', label: 'Lay-down Apron B', use: 'CVN-71 / CVN-75 staging', lat: 36.80905, lng: -76.29905, hdg: 62, dims: [120, 70] },
      ].map(mp),
      shore: [[36.81165, -76.29585], [36.81075, -76.29705], [36.80975, -76.29835], [36.80905, -76.29455]],
    };
  }
  _editHandle(obj, applyFn, rotatable, reachM) {
    const L = window.L, self = this; const cur = { lat: obj.lat, lng: obj.lng, hdg: obj.hdg || 0 };
    const hIcon = (txt, grab) => L.divIcon({ className: '', html: '<div style="width:26px;height:26px;border-radius:50%;background:#0b0c0e;border:2px solid #3D6BFF;display:flex;align-items:center;justify-content:center;color:#3D6BFF;font-size:14px;font-weight:700;box-shadow:0 2px 9px rgba(0,0,0,.65);cursor:' + grab + '">' + txt + '</div>', iconSize: [26, 26], iconAnchor: [13, 13] });
    const persist = () => { const p = self._place(); p[obj.id] = Object.assign({}, p[obj.id], { lat: cur.lat, lng: cur.lng, hdg: cur.hdg }); self.__place = p; self._savePlace(); };
    const rPos = () => self._offset(cur.lat, cur.lng, reachM, cur.hdg);
    const mh = L.marker([cur.lat, cur.lng], { draggable: true, icon: hIcon('\u2725', 'move'), zIndexOffset: 2000 }).addTo(this._mg.handle);
    let rh = null;
    if (rotatable) rh = L.marker(rPos(), { draggable: true, icon: hIcon('\u27F3', 'grab'), zIndexOffset: 2000 }).addTo(this._mg.handle);
    mh.on('drag', (e) => { cur.lat = e.latlng.lat; cur.lng = e.latlng.lng; applyFn(cur); if (rh) rh.setLatLng(rPos()); });
    mh.on('dragend', persist);
    if (rh) { rh.on('drag', (e) => { const dN = e.latlng.lat - cur.lat, dE = (e.latlng.lng - cur.lng) * Math.cos(cur.lat * Math.PI / 180); cur.hdg = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360; applyFn(cur); }); rh.on('dragend', persist); }
  }
  _offset(lat, lng, distM, brgDeg) { const R = 6378137, br = brgDeg * Math.PI / 180, dN = distM * Math.cos(br), dE = distM * Math.sin(br); return [lat + (dN / R) * 180 / Math.PI, lng + (dE / (R * Math.cos(lat * Math.PI / 180))) * 180 / Math.PI]; }
  _corners(lat, lng, len, wid, hdg) { const h = len / 2, w = wid / 2; const f = this._offset(lat, lng, h, hdg), b = this._offset(lat, lng, h, hdg + 180); const fl = this._offset(f[0], f[1], w, hdg + 90), fr = this._offset(f[0], f[1], w, hdg - 90), bl = this._offset(b[0], b[1], w, hdg + 90), br = this._offset(b[0], b[1], w, hdg - 90); return [fl, fr, br, bl]; }
  _mapRef = (el) => {
    if (!el) { if (this._map) { try { this._map.remove(); } catch (e) {} this._map = null; } this._mapEl = null; return; }
    this._mapEl = el;
    const tryInit = () => { if (window.L) { this._initMap(); return true; } return false; };
    if (!tryInit()) { let n = 0; const t = setInterval(() => { if (tryInit() || ++n > 100) clearInterval(t); }, 80); }
  };
  _initMap() {
    if (this._map || !this._mapEl) return;
    const L = window.L, g = this.yardGeo();
    const m = L.map(this._mapEl, { preferCanvas: true, zoomControl: true, attributionControl: true, minZoom: 2, maxZoom: 19, scrollWheelZoom: true, worldCopyJump: true }).setView(g.center, g.zoom);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 20, attribution: '&copy; OpenStreetMap &copy; CARTO · Norfolk Naval Shipyard' }).addTo(m);
    this._map = m;
    this._mg = { supply: L.layerGroup().addTo(m), berth: L.layerGroup().addTo(m), crane: L.layerGroup().addTo(m), laydown: L.layerGroup().addTo(m), shore: L.layerGroup().addTo(m), lbl: L.layerGroup().addTo(m), handle: L.layerGroup().addTo(m) };
    this._drawMap();
    setTimeout(() => { try { m.invalidateSize(); } catch (e) {} }, 140);
  }
  _drawMap() {
    if (!this._map || !window.L) return;
    const L = window.L, g = this.yardGeo(), st = this.state, sel = st.yrSel, edit = st.yrEdit;
    Object.values(this._mg).forEach((grp) => grp.clearLayers());
    const colFor = (b) => b.kind === 'drydock' ? '#f59e0b' : '#4ade80';
    // supply-chain flow lines + critical delay markers
    if (st.yrSupplyLines) this._drawSupply(g);
    // shore trunk
    if (st.yrShore) { L.polyline(g.shore, { color: '#f59e0b', weight: 2.5, dashArray: '3 6', opacity: 0.85 }).addTo(this._mg.shore); }
    // laydown
    if (st.yrLaydown) g.laydowns.forEach((l) => {
      const seld = sel === 'res:' + l.id;
      const poly = L.polygon(this._corners(l.lat, l.lng, l.dims[0], l.dims[1], l.hdg), { color: seld ? '#3D6BFF' : '#6e7480', weight: 1.3, dashArray: '5 4', fill: true, fillColor: seld ? '#3D6BFF' : '#6e7480', fillOpacity: seld ? 0.18 : 0.1 });
      poly.bindTooltip('<div class="tid">' + l.label + '</div><div class="trow">' + l.use + '</div>', { className: 'ym-tip', direction: 'top', sticky: true });
      poly.on('click', () => this.setState((s) => ({ yrSel: s.yrSel === 'res:' + l.id ? null : 'res:' + l.id })));
      poly.addTo(this._mg.laydown);
      const lbl = L.marker([l.lat, l.lng], { interactive: false, icon: L.divIcon({ className: 'ym-lbl', html: l.id, iconSize: [40, 12], iconAnchor: [20, 6] }) }).addTo(this._mg.lbl);
      if (edit) this._editHandle(l, (cur) => { poly.setLatLngs(this._corners(cur.lat, cur.lng, l.dims[0], l.dims[1], cur.hdg)); lbl.setLatLng([cur.lat, cur.lng]); }, true, l.dims[0] / 2 + 28);
    });
    // crane rail + cranes
    L.polyline(g.rail, { color: '#424656', weight: 4 }).addTo(this._mg.crane);
    g.cranes.forEach((c) => {
      const seld = sel === 'res:' + c.id, col = seld ? '#3D6BFF' : '#5ec2ec';
      const cov = st.yrCrane ? L.circle([c.lat, c.lng], { radius: c.r, color: '#5ec2ec', weight: 1, dashArray: '4 4', fill: true, fillColor: '#5ec2ec', fillOpacity: 0.05 }).addTo(this._mg.crane) : null;
      const mk = L.circleMarker([c.lat, c.lng], { radius: 7, color: col, weight: 2.5, fillColor: '#0b0c0e', fillOpacity: 1 });
      mk.bindTooltip('<div class="tid">' + c.label + '</div><div class="trow">Portal crane · ' + c.cap + ' · shared rail</div>', { className: 'ym-tip', direction: 'top' });
      mk.on('click', () => this.setState((s) => ({ yrSel: s.yrSel === 'res:' + c.id ? null : 'res:' + c.id })));
      mk.addTo(this._mg.crane);
      const clbl = L.marker([c.lat, c.lng], { interactive: false, icon: L.divIcon({ className: 'ym-lbl', html: c.id, iconSize: [44, 12], iconAnchor: [-9, 6] }) }).addTo(this._mg.lbl);
      if (edit) this._editHandle(c, (cur) => { mk.setLatLng([cur.lat, cur.lng]); if (cov) cov.setLatLng([cur.lat, cur.lng]); clbl.setLatLng([cur.lat, cur.lng]); }, false, 0);
    });
    // berths
    g.berths.forEach((b) => {
      const seld = sel === 'dock:' + b.id, base = colFor(b);
      const poly = L.polygon(this._corners(b.lat, b.lng, b.dims[0], b.dims[1], b.hdg), { color: seld ? '#3D6BFF' : base, weight: seld ? 2.6 : 1.8, fill: true, fillColor: seld ? '#3D6BFF' : base, fillOpacity: seld ? 0.22 : 0.12 });
      const fit = this.berthFit(b);
      poly.bindTooltip('<div class="tid">' + b.name + '</div><div class="trow">' + (b.kind === 'drydock' ? 'Graving dry dock' : 'Pier / quaywall') + ' · <b>' + b.hull + '</b></div><div class="trow">Depth <b>' + b.depth + '</b> · Draft ' + b.draft + '</div><div class="trow">Shore <b>' + b.shore.voltage + ' · ' + (b.shore.capacityKW / 1000).toFixed(1) + ' MW</b></div><div class="trow">Fit <b style="color:' + fit.color + '">' + fit.verdict + '</b> — ' + fit.limit + '</div>', { className: 'ym-tip', direction: 'top', sticky: true });
      poly.on('click', () => this.setState((s) => ({ yrSel: s.yrSel === 'dock:' + b.id ? null : 'dock:' + b.id })));
      poly.addTo(this._mg.berth);
      const blbl = L.marker([b.lat, b.lng], { interactive: false, icon: L.divIcon({ className: 'ym-lbl', html: b.hull, iconSize: [60, 12], iconAnchor: [30, 6] }) }).addTo(this._mg.lbl);
      if (edit) this._editHandle(b, (cur) => { poly.setLatLngs(this._corners(cur.lat, cur.lng, b.dims[0], b.dims[1], cur.hdg)); blbl.setLatLng([cur.lat, cur.lng]); }, true, b.dims[0] / 2 + 30);
    });
  }
  _bearing(a, b) { const dN = b[0] - a[0], dE = (b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180); return Math.atan2(dE, dN) * 180 / Math.PI; }
  _drawSupply(g) {
    const meta = { at_risk: { c: '#f59e0b', label: 'At risk', anim: 'deflareA' }, delayed: { c: '#dc2626', label: 'Delayed', anim: 'deflare' }, not_contracted: { c: '#5ec2ec', label: 'GFE — not on contract', anim: 'deflareA' }, on_track: { c: '#22c55e', label: 'On track', anim: '' } };
    const L = window.L, sel = this.state.yrSel, center = g.center;
    const berthCenter = (id) => { const b = g.berths.find((x) => x.id === id) || g.berths[0]; return [b.lat, b.lng]; };
    const items = this.supplyData().filter((m) => this._supVisible(m));
    const flagN = {}; // fan delay flags around each berth
    // draw on-track lines first (under), then problem lines on top
    items.slice().sort((a, b) => (a.status === 'on_track' ? 0 : 1) - (b.status === 'on_track' ? 0 : 1)).forEach((m, i) => {
      const mm = meta[m.status], off = m.status !== 'on_track', important = off || m.big || m.gfe;
      const dest = berthCenter(m.dock);
      // origin = supplier's REAL world location; line bows toward it as a great-circle-style arc
      const origin = m.oll;
      const d = this._distM(origin, dest), bend = Math.min(d * 0.12, 1100000);
      const mid = [(origin[0] + dest[0]) / 2, (origin[1] + dest[1]) / 2];
      const ctrl = this._offset(mid[0], mid[1], bend, this._bearing(origin, dest) + 90);
      const pts = []; for (let t = 0; t <= 1.0001; t += 1 / 28) { const u = 1 - t; pts.push([u * u * origin[0] + 2 * u * t * ctrl[0] + t * t * dest[0], u * u * origin[1] + 2 * u * t * ctrl[1] + t * t * dest[1]]); }
      const slip = (m.onDock - m.need), seld = sel === 'mat:' + m.id;
      const line = L.polyline(pts, { color: mm.c, weight: seld ? 3.4 : (off ? 2.2 : 1.4), opacity: seld ? 1 : (off ? 0.9 : 0.42), dashArray: m.status === 'not_contracted' ? '2 7' : (m.status === 'on_track' ? null : '7 6') });
      const tip = '<div class="tid">' + m.id + ' · ' + m.name + '</div><div class="trow">' + m.supplier + ' · ' + m.city + '</div><div class="trow">Lead ' + (m.lead ? m.lead + ' wk' : '—') + ' · on-dock ' + (m.onDock ? 'W' + m.onDock : 'TBD') + ' / need ' + (m.need ? 'W' + m.need : '—') + '</div><div class="trow">Status <b style="color:' + mm.c + '">' + mm.label + '</b></div>';
      line.bindTooltip(tip, { className: 'ym-tip', direction: 'top', sticky: true });
      line.on('click', () => this.setState((s) => ({ yrSel: s.yrSel === 'mat:' + m.id ? null : 'mat:' + m.id })));
      line.addTo(this._mg.supply);
      // supplier origin node
      const onode = L.circleMarker(origin, { radius: off ? 5 : 3.5, color: mm.c, weight: 2, fillColor: '#0b0c0e', fillOpacity: 1 });
      onode.bindTooltip('<div class="tid">' + (m.gfe ? 'GFE source' : 'Supplier') + '</div><div class="trow">' + m.supplier + ' · ' + m.city + '</div>', { className: 'ym-tip', direction: 'top' });
      onode.on('click', () => this.setState((s) => ({ yrSel: s.yrSel === 'mat:' + m.id ? null : 'mat:' + m.id })));
      onode.addTo(this._mg.supply);
      if (important) L.marker(origin, { interactive: false, icon: L.divIcon({ className: 'ym-lbl', html: m.city + (m.gfe ? ' · GFE' : ''), iconSize: [130, 12], iconAnchor: [-8, 6] }) }).addTo(this._mg.supply);
      // critical delay flag — only for off-track / GFE items, fanned around the destination berth
      if (off) {
        const k = flagN[m.dock] = (flagN[m.dock] || 0) + 1;
        const fpos = this._offset(dest[0], dest[1], 44 + (k % 3) * 26, (k * 52) % 360);
        const lateTxt = m.status === 'not_contracted' ? 'GFE' : (slip > 0 ? '+' + slip + 'w' : 'late');
        const ring = mm.anim ? ('animation:' + mm.anim + ' 1.4s ease-in-out infinite;') : '';
        const dm = L.marker(fpos, { zIndexOffset: 1500, icon: L.divIcon({ className: '', html: '<div style="display:flex;align-items:center;gap:4px;transform:translate(8px,-8px);"><span style="width:15px;height:15px;border-radius:50%;background:' + mm.c + ';border:2px solid #0b0c0e;box-shadow:0 0 0 2px ' + mm.c + ';' + ring + 'display:flex;align-items:center;justify-content:center;color:#0b0c0e;font-size:9px;font-weight:800;">\u2691</span><span style="font-family:\'Roboto Mono\',monospace;font-size:9px;font-weight:700;color:' + mm.c + ';background:rgba(6,14,30,0.85);padding:1px 5px;border-radius:3px;white-space:nowrap;">' + m.id + ' ' + lateTxt + '</span></div>', iconSize: [92, 18], iconAnchor: [0, 0] }) });
        dm.bindTooltip(tip, { className: 'ym-tip', direction: 'top' });
        dm.on('click', () => this.setState((s) => ({ yrSel: s.yrSel === 'mat:' + m.id ? null : 'mat:' + m.id })));
        dm.addTo(this._mg.supply);
      }
    });
  }
  berthFit(b) {
    const loadPct = b.shore.capacityKW ? Math.round((b.shore.loadKW || 0) / b.shore.capacityKW * 100) : 0;
    if (b.kind !== 'drydock') {
      const depthFt = parseInt((b.depth || '40').replace(/[^0-9]/g, '')) || 40, draftFt = parseInt((b.draft || '21').replace(/[^0-9]/g, '')) || 21;
      if (depthFt < draftFt + 3) return { verdict: 'WON\u2019T SUPPORT', color: '#dc2626', limit: 'depth ' + depthFt + ' ft < draft ' + draftFt + ' ft + margin' };
    }
    if (loadPct > 100) return { verdict: 'WON\u2019T SUPPORT', color: '#dc2626', limit: 'shore power over capacity for cold-iron at peak' };
    if (loadPct >= 90) return { verdict: 'TIGHT', color: '#f59e0b', limit: 'shore power ' + loadPct + '% of capacity — manage simultaneous loads' };
    return { verdict: 'SUPPORTS', color: '#22c55e', limit: 'shore power, depth, and length within limits' };
  }
  supplyData() {
    // Full CVN modernization (PIA, no refueling) — long-lead equipment & material.
    // oll = real [lat,lng] of the supplier city (global perspective); hull = destination ship.
    const raw = [
      { id: 'M-01', name: 'Ship-service switchboard (1S)', wi: 'WI-1905', supplier: 'Powell Switchgear', city: 'Houston, TX', oll: [29.76, -95.37], lead: 16, onDock: 7, need: 6, status: 'at_risk', res: 'PC-14 lift', dock: 'DD4', big: true, gfe: false, note: 'On-dock 1 wk after need — gates switchboard rip-out & re-install.' },
      { id: 'M-02', name: 'Tank coating · MIL-PRF-23236', wi: 'WI-3318', supplier: 'Sherwin Marine', city: 'Norfolk, VA', oll: [36.85, -76.29], lead: 6, onDock: 1, need: 2, status: 'on_track', res: 'Lay-down A', dock: 'DD4', big: false, gfe: false, note: 'On dock ahead of need.' },
      { id: 'M-03', name: 'Combat-system cable plant (GFE)', wi: 'WI-8810', supplier: 'NAVSUP WSS', city: 'Mechanicsburg, PA', oll: [40.21, -77.00], lead: 0, onDock: 0, need: 0, status: 'not_contracted', res: 'DD8 / FY28', dock: 'DD8', big: true, gfe: true, note: 'Critical GFE — not yet on contract; coordinate route into PIA-26.' },
      { id: 'M-04', name: 'Duct insulation board', wi: 'WI-5571', supplier: 'Johns Manville', city: 'Denver, CO', oll: [39.74, -104.99], lead: 8, onDock: 10, need: 10, status: 'on_track', res: 'Shop 71', dock: 'DD4', big: false, gfe: false, note: 'On dock at need — tight, no float.' },
      { id: 'M-05', name: 'FD blower valve repair kits', wi: 'WI-2210', supplier: 'Flowserve', city: 'Springville, UT', oll: [40.16, -111.61], lead: 10, onDock: 6, need: 7, status: 'on_track', res: 'Shop 31', dock: 'DD4', big: false, gfe: false, note: 'On dock ahead of need.' },
      { id: 'M-06', name: 'Foundation steel (HY-80)', wi: 'WI-1888', supplier: 'Nucor Steel', city: 'Norfolk, VA', oll: [36.84, -76.30], lead: 5, onDock: 2, need: 3, status: 'on_track', res: 'Shop 11', dock: 'DD4', big: true, gfe: false, note: 'On dock ahead of need.' },
      { id: 'M-07', name: 'Mineral-wool lagging blanket', wi: 'WI-2255', supplier: 'Johns Manville', city: 'Denver, CO', oll: [39.73, -104.97], lead: 9, onDock: 9, need: 8, status: 'delayed', res: 'Shop 71', dock: 'DD4', big: false, gfe: false, note: 'On-dock 1 wk late — delays blower-room lagging.' },
      { id: 'M-08', name: 'CuNi pipe & flanged fittings', wi: 'WI-3402', supplier: 'Mueller Industries', city: 'Memphis, TN', oll: [35.15, -90.05], lead: 12, onDock: 5, need: 4, status: 'delayed', res: 'Lay-down A', dock: 'DD4', big: true, gfe: false, note: 'On-dock 1 wk late — on the tank-work critical path to Undock.' },
      { id: 'M-09', name: 'Aircraft elevator cables & sheaves', wi: 'WI-4120', supplier: 'Wire Rope Works', city: 'Williamsport, PA', oll: [41.24, -76.99], lead: 22, onDock: 12, need: 11, status: 'at_risk', res: 'PC-12 lift', dock: 'DD4', big: true, gfe: false, note: 'Long-lead elevator wire — at-risk to elevator certification.' },
      { id: 'M-10', name: 'Steam catapult trough & cylinders', wi: 'WI-4310', supplier: 'NAVSEA / GFE', city: 'Lakehurst, NJ', oll: [40.03, -74.32], lead: 0, onDock: 0, need: 9, status: 'not_contracted', res: 'Flight deck', dock: 'DD4', big: true, gfe: true, note: 'GFE catapult components — contract action pending.' },
      { id: 'M-11', name: 'Arresting-gear (Mk 7) overhaul kit', wi: 'WI-4350', supplier: 'GFE · NAWCAD', city: 'Lakehurst, NJ', oll: [40.01, -74.35], lead: 0, onDock: 14, need: 13, status: 'at_risk', res: 'Flight deck', dock: 'DD4', big: true, gfe: true, note: 'GFE arresting-gear kit — 1 wk late to need.' },
      { id: 'M-12', name: 'Main reduction-gear bearings', wi: 'WI-2510', supplier: 'Philadelphia Gear', city: 'King of Prussia, PA', oll: [40.09, -75.39], lead: 28, onDock: 8, need: 10, status: 'on_track', res: 'Shaft alley', dock: 'DD4', big: true, gfe: false, note: 'Long-lead propulsion bearings — on dock ahead of need.' },
      { id: 'M-13', name: 'Distilling plant (RO) modules', wi: 'WI-5210', supplier: 'Aqua-Chem', city: 'Knoxville, TN', oll: [35.96, -83.92], lead: 18, onDock: 13, need: 12, status: 'delayed', res: 'Shop 38', dock: 'DD4', big: true, gfe: false, note: 'RO modules 1 wk late — slips potable-water restoration.' },
      { id: 'M-14', name: 'SSTG turbine spares', wi: 'WI-2620', supplier: 'GE Vernova', city: 'Schenectady, NY', oll: [42.81, -73.94], lead: 20, onDock: 9, need: 11, status: 'on_track', res: 'Shop 31', dock: 'DD4', big: true, gfe: false, note: 'Ship-service turbine-generator spares on dock ahead of need.' },
      { id: 'M-15', name: 'AN/SPS-48 radar array (GFE)', wi: 'WI-8420', supplier: 'GFE · NSWC', city: 'Crane, IN', oll: [38.89, -86.84], lead: 0, onDock: 16, need: 15, status: 'at_risk', res: 'Island / mast', dock: 'DD4', big: true, gfe: true, note: 'GFE radar array — tight to island re-assembly.' },
      { id: 'M-16', name: 'Combat-direction cabinets (GFE)', wi: 'WI-8460', supplier: 'GFE · NAVSUP WSS', city: 'Mechanicsburg, PA', oll: [40.22, -77.02], lead: 0, onDock: 0, need: 14, status: 'not_contracted', res: 'CIC', dock: 'DD4', big: true, gfe: true, note: 'GFE combat-direction cabinets — contract action pending.' },
      { id: 'M-17', name: 'Anchor windlass & chain', wi: 'WI-6110', supplier: 'Baldt Anchor', city: 'Chester, PA', oll: [39.85, -75.36], lead: 14, onDock: 7, need: 9, status: 'on_track', res: 'Forecastle', dock: 'DD4', big: false, gfe: false, note: 'On dock ahead of need.' },
      { id: 'M-18', name: 'JP-5 pump & filtration skids', wi: 'WI-5410', supplier: 'IMO / Colfax', city: 'Monroe, NC', oll: [34.99, -80.55], lead: 15, onDock: 11, need: 10, status: 'delayed', res: 'Shop 38', dock: 'DD4', big: true, gfe: false, note: 'JP-5 skids 1 wk late — fuel-system restoration risk.' },
      { id: 'M-19', name: 'AC&R (375-ton) plant', wi: 'WI-5160', supplier: 'York / Johnson Ctrls', city: 'York, PA', oll: [39.96, -76.73], lead: 24, onDock: 17, need: 16, status: 'at_risk', res: 'Shop 38', dock: 'DD4', big: true, gfe: false, note: 'AC&R plant 1 wk late — habitability & magazine cooling.' },
      { id: 'M-20', name: 'LV switchgear & cableway', wi: 'WI-3210', supplier: 'Eaton', city: 'Pittsburgh, PA', oll: [40.44, -79.99], lead: 17, onDock: 8, need: 10, status: 'on_track', res: 'Shop 51', dock: 'DD4', big: true, gfe: false, note: 'Electrical-mod switchgear on dock ahead of need.' },
      { id: 'M-21', name: 'Weapons-elevator upgrade kit', wi: 'WI-7510', supplier: 'GFE · NSWC', city: 'Port Hueneme, CA', oll: [34.15, -119.20], lead: 0, onDock: 19, need: 17, status: 'at_risk', res: 'Magazine', dock: 'DD4', big: true, gfe: true, note: 'GFE weapons-elevator kit — 2 wk late to magazine work.' },
      { id: 'M-22', name: 'Nonskid & flight-deck coating', wi: 'WI-6340', supplier: 'American Safety Tech', city: 'Roanoke, VA', oll: [37.27, -79.94], lead: 7, onDock: 6, need: 7, status: 'on_track', res: 'Flight deck', dock: 'DD4', big: false, gfe: false, note: 'On dock at need.' },
      { id: 'M-23', name: 'CHT sewage system components', wi: 'WI-5290', supplier: 'EVAC / Wilo', city: 'Chicago, IL', oll: [41.88, -87.63], lead: 11, onDock: 9, need: 9, status: 'on_track', res: 'Shop 31', dock: 'DD4', big: false, gfe: false, note: 'On dock at need.' },
      { id: 'M-24', name: 'Berthing habitability outfit', wi: 'WI-6410', supplier: 'NASSCO Mfg', city: 'San Diego, CA', oll: [32.72, -117.16], lead: 13, onDock: 12, need: 13, status: 'on_track', res: 'Shop 64', dock: 'DD4', big: false, gfe: false, note: 'On dock ahead of need.' },
      { id: 'M-25', name: 'Mast section & antenna mod', wi: 'WI-7110', supplier: 'BAE Systems', city: 'Jacksonville, FL', oll: [30.33, -81.66], lead: 16, onDock: 9, need: 10, status: 'on_track', res: 'PC-14 lift', dock: 'P3', big: true, gfe: false, note: 'CVN-71 mast section — on dock ahead of need.' },
      { id: 'M-26', name: 'Shaft seal & strut bearings', wi: 'WI-2540', supplier: 'Duramax Marine', city: 'Hiram, OH', oll: [41.31, -81.14], lead: 19, onDock: 10, need: 12, status: 'on_track', res: 'Shaft alley', dock: 'DD4', big: false, gfe: false, note: 'On dock ahead of need.' },
      { id: 'M-27', name: 'Propulsion shaft forging', wi: 'WI-2505', supplier: 'Sheffield Forgemasters', city: 'Sheffield, UK', oll: [53.38, -1.47], lead: 34, onDock: 6, need: 9, status: 'on_track', res: 'Shaft alley', dock: 'DD4', big: true, gfe: false, note: 'Single-source forging (UK) — on dock ahead of need.' },
      { id: 'M-28', name: 'Valve actuators (precision)', wi: 'WI-2230', supplier: 'Rotork', city: 'Bath, UK', oll: [51.38, -2.36], lead: 21, onDock: 12, need: 11, status: 'at_risk', res: 'Shop 31', dock: 'DD4', big: false, gfe: false, note: 'UK-sourced actuators — 1 wk late; customs clearance risk.' },
      { id: 'M-29', name: 'ACB power breakers', wi: 'WI-3240', supplier: 'Siemens Energy', city: 'Erlangen, DE', oll: [49.59, 11.00], lead: 26, onDock: 15, need: 13, status: 'delayed', res: 'Shop 51', dock: 'DD4', big: true, gfe: false, note: 'Germany-sourced breakers — 2 wk late; ocean freight slip.' },
      { id: 'M-30', name: 'Marine bearings (super-precision)', wi: 'WI-2545', supplier: 'NSK', city: 'Tokyo, JP', oll: [35.68, 139.69], lead: 23, onDock: 11, need: 12, status: 'on_track', res: 'Shaft alley', dock: 'DD4', big: false, gfe: false, note: 'Japan-sourced bearings — on dock ahead of need.' },
      { id: 'M-31', name: 'Specialty steel plate', wi: 'WI-1120', supplier: 'POSCO', city: 'Pohang, KR', oll: [36.02, 129.34], lead: 25, onDock: 14, need: 12, status: 'at_risk', res: 'Shop 11', dock: 'DD4', big: true, gfe: false, note: 'Korea-sourced plate — 2 wk at risk; sub-tier mill capacity.' },
      { id: 'M-32', name: 'Davit & boat-handling system', wi: 'WI-7210', supplier: 'Fincantieri', city: 'Genoa, IT', oll: [44.41, 8.93], lead: 20, onDock: 10, need: 12, status: 'on_track', res: 'PC-14 lift', dock: 'P3', big: false, gfe: false, note: 'Italy-sourced davit — CVN-71; on dock ahead of need.' },
    ];
    const hullOf = { DD4: 'CVN-73', DD8: 'CVN-75', P3: 'CVN-71' };
    return raw.map((m) => Object.assign({}, m, { hull: hullOf[m.dock] }));
  }
  berthData() {
    return [
      { id: 'DD4', kind: 'drydock', name: 'Graving Dry Dock 4', hull: 'CVN-73', ship: 'USS George Washington', avail: 'PIA-26', status: 'At Risk', statusColor: '#f59e0b',
        lat: 36.81055, lng: -76.29725, hdg: 62, dims: [300, 42],
        gate: 'Undock', gateWhen: '18 days', gateWk: 22, floodWk: 21, dryWindow: 'W1 → W22',
        shore: { voltage: '4160 V', capacityKW: 2200, loadKW: 1980, coldIron: true }, crane: 'Portal PC-12 / PC-14 · 50 LT',
        depth: 'Graving — dewatered', draft: '37 ft docked', sill: '-31 ft MLLW', pierLength: '960 ft graving dock', nesting: 'Single', loadRating: 'Dock floor 8,000 psf', laydown: '11,000 sq ft', pumpDown: 'Dewater 14 h · flood-up 9 h',
        utils: { 'Shore Power': '4160 V · 2.2 MW (90% load)', 'Potable Water': '8-in main', 'Compressed Air': '125 psi LP / 3,000 psi HP', 'Steam': '150 psi saturated', 'Oily Waste / CHT': '6-in CHT', 'Comms': 'Fiber · SIPR / NIPR' },
        ties: ['WI-3318 Tank preservation', 'WI-3402 Sounding / vent piping', 'WI-4471 Hull hot work'], tie: 'Hull & tank work must complete before flood-up' },
      { id: 'DD8', kind: 'drydock', name: 'Dry Dock 8', hull: 'CVN-75', ship: 'USS Harry S. Truman', avail: 'DPIA-28', status: 'Planning', statusColor: '#94a3b8',
        lat: 36.80945, lng: -76.29835, hdg: 62, dims: [330, 46],
        gate: 'Float-off', gateWhen: 'FY28', gateWk: 0, floodWk: 0, dryWindow: 'FY28 (planning)',
        shore: { voltage: '4160 V', capacityKW: 2400, loadKW: 0, coldIron: true }, crane: 'Portal PC-12 / PC-14 · 50 LT',
        depth: 'Graving — flooded', draft: '—', sill: '-34 ft MLLW', pierLength: '1,090 ft graving dock', nesting: 'Single', loadRating: 'Dock floor 8,500 psf', laydown: '13,500 sq ft', pumpDown: 'Dewater 16 h · flood-up 10 h',
        utils: { 'Shore Power': '4160 V · 2.4 MW (cold-iron)', 'Potable Water': '8-in main', 'Compressed Air': '125 psi LP / 3,000 psi HP', 'Steam': '150 psi saturated', 'Oily Waste / CHT': '6-in CHT', 'Comms': 'Fiber · SIPR / NIPR' },
        ties: ['WI-8810 Combat-system cable pull (FY28)'], tie: 'Docking plan in development' },
      { id: 'P3', kind: 'pier', name: 'Pier 3', hull: 'CVN-71', ship: 'USS Theodore Roosevelt', avail: 'SRA-26', status: 'On Track', statusColor: '#22c55e',
        lat: 36.8091, lng: -76.2945, hdg: 335, dims: [240, 26],
        gate: 'Move-Aboard', gateWhen: '31 days', gateWk: 13, floodWk: 0, dryWindow: 'Waterborne',
        shore: { voltage: '450 V', capacityKW: 1800, loadKW: 1520, coldIron: true }, crane: 'PC-14 / Mobile pad · 50 LT',
        depth: '40 ft MLLW', draft: '21 ft', sill: '—', pierLength: '820 ft berthing face', nesting: '2 abreast', loadRating: 'Pier deck 1,000 psf', laydown: '7,200 sq ft', pumpDown: 'N/A — waterborne',
        utils: { 'Shore Power': '450 V · 1.8 MW (84% load)', 'Potable Water': '6-in main', 'Compressed Air': '125 psi LP', 'Steam': '150 psi saturated', 'Oily Waste / CHT': '6-in CHT', 'Comms': 'Fiber + POTS' },
        ties: ['WI-7110 Hot work', 'WI-7240 Pump overhaul'], tie: 'Crew move-aboard gate' },
    ];
  }

  woSeed() {
    if (this._wo) return this._wo;
    const S = { pres: 'Shop 71 Preservation', weld: 'Shop 26 Welding', elec: 'Shop 51 Electrical', mach: 'Shop 31 Inside Machinists', fit: 'Shop 11 Shipfitters' };
    const sp = (gf, hw, to, cs, au) => ({ gasFree: gf, hotWork: hw, tagOut: to, confined: cs, auth: au });
    const anchored = [
      { id: 'WI-3318', awr: 'AWR 73-26-3318', title: 'Reserve feed water tank preservation', type: 'preservation', trade: S.pres, comps: ['4-110-2-W'], compName: 'Reserve Feed Water Tank', deck: '4th', zone: 'Z3', frame: 'Fr 108–114', system: '506 Tanks & Voids', start: 'W02', finish: 'W06', dur: '24 d', preds: ['WI-3300'], succs: ['WI-3402'], status: 'In-Work', pct: 65, estMH: 680, actMH: 512, crit: 'High', onCP: true, event: 'Undock', growth: false, space: sp(true, false, true, true, true), material: 'Ready', materialNeed: '—', conflicts: ['SR-0142'], conf: 0.97, ingested: '09 May 26', verified: '12 May 26', originator: 'Code 256 · Tank Team',
        desc: 'Blast and coat the interior of 4-110-2-W reserve feed water tank to specification. Apply final coat per PRES-07; boundary integrity must be maintained — no breach after final-coat cure.', refs: ['NSTM 631', 'Spec 6310-001', 'Dwg 803-7402112'], qa: ['ITP-A surface prep / WSP', 'ITP-B dry-film thickness', 'G-point hold — final cure'], matList: ['Coating MIL-PRF-23236 Type V', 'Abrasive media, garnet'], srcTitle: 'RESV FEED WTR TK PRES — 4-110-2-W', srcComp: '4-110-2-W RES FEED WTR TK' },
      { id: 'WI-3402', awr: 'AWR 73-26-3402', title: 'Sounding & vent piping modification', type: 'mechanical', trade: S.mach, comps: ['4-110-2-W'], compName: 'Reserve Feed Water Tank', deck: '4th', zone: 'Z3', frame: 'Fr 108–114', system: '529 Drainage & Tank Level', start: 'W05', finish: 'W08', dur: '14 d', preds: ['WI-3318'], succs: ['WI-3450'], status: 'Planned', pct: 0, estMH: 240, actMH: 0, crit: 'High', onCP: true, event: 'Undock', growth: false, space: sp(true, false, true, true, false), material: 'Awaiting', materialNeed: 'W04', conflicts: ['SR-0142'], conf: 0.94, ingested: '09 May 26', verified: '11 May 26', originator: 'Code 256 · Piping',
        desc: 'Modify sounding and vent piping penetrations on the reserve feed water tank. Coordinate to avoid breaching the preservation boundary established by WI-3318.', refs: ['Spec 5290-114', 'Dwg 803-7402980'], qa: ['ITP — hydro test', 'Tank tightness'], matList: ['Sch-80 CuNi pipe', 'Flanged fittings'], srcTitle: 'SOUND/VENT PIPE MOD — 4-110', srcComp: '4-110-2-W RES FEED WTR TK' },
      { id: 'WI-4471', awr: 'AWR 73-26-4471', title: 'Hangar Bay 2 structural hot work', type: 'hot work', trade: S.weld, comps: ['1-136-0-Q'], compName: 'Hangar Bay 2', deck: 'Main', zone: 'Z4', frame: 'Fr 132–140', system: '130 Hull Decks', start: 'W06', finish: 'W09', dur: '16 d', preds: ['WI-4400'], succs: ['WI-4490'], status: 'Released', pct: 4, estMH: 410, actMH: 12, crit: 'High', onCP: true, event: 'Undock', growth: false, space: sp(false, true, false, false, true), material: 'Ready', materialNeed: '—', conflicts: ['SR-0129'], conf: 0.96, ingested: '08 May 26', verified: '10 May 26', originator: 'Code 920 · Structures',
        desc: 'Structural hot work on Hangar Bay 2 deck. Hot-work boundary extends vertically — coordinate with uptake lagging directly below (WI-4480).', refs: ['NSTM 074 Vol 3', 'Dwg 803-6841120'], qa: ['Fire watch posted', 'NDT — weld VT/MT', 'Gas-free certificate'], matList: ['HY-80 insert plate', 'E-7018 electrode'], srcTitle: 'HANGAR BAY 2 HOT WORK', srcComp: '1-136-0-Q HANGAR BAY 2' },
      { id: 'WI-4480', awr: 'AWR 73-26-4480', title: 'Uptake space lagging install', type: 'lagging', trade: S.pres, comps: ['1-136-0-Q'], compName: 'Uptake Space No. 2', deck: 'Main', zone: 'Z4', frame: 'Fr 132–140', system: '512 Ventilation & Uptakes', start: 'W06', finish: 'W10', dur: '20 d', preds: ['WI-4460'], succs: [], status: 'Planned', pct: 0, estMH: 360, actMH: 0, crit: 'Med', onCP: false, event: 'Undock', growth: false, space: sp(false, false, false, true, false), material: 'Ready', materialNeed: '—', conflicts: ['SR-0129'], conf: 0.92, ingested: '08 May 26', verified: '10 May 26', originator: 'Code 256 · Insulation',
        desc: 'Install thermal lagging on uptake trunk. Combustible lagging cannot be present within the vertical hot-work boundary of WI-4471.', refs: ['NSTM 635', 'Spec 6350-220'], qa: ['ITP — lagging density', 'Lagging coverage VT'], matList: ['Mineral wool blanket', 'Lagging cloth / wire'], srcTitle: 'UPTAKE LAGGING — 1-136', srcComp: '1-136-0-Q UPTAKE SPC 2' },
      { id: 'WI-2210', awr: 'AWR 73-26-2210', title: 'Forced draft blower valve overhaul', type: 'mechanical', trade: S.mach, comps: ['4-149-2-Q'], compName: 'Forced Draft Blower Room No. 3', deck: '4th', zone: 'Z5', frame: 'Fr 146–152', system: '233 Propulsion Units', start: 'W07', finish: 'W12', dur: '26 d', preds: [], succs: ['WI-2280'], status: 'In-Work', pct: 40, estMH: 520, actMH: 214, crit: 'Med', onCP: false, event: 'Undock', growth: false, space: sp(false, false, true, true, true), material: 'Ready', materialNeed: '—', conflicts: ['SR-0137'], conf: 0.95, ingested: '07 May 26', verified: '10 May 26', originator: 'Code 230 · Machinery',
        desc: 'Overhaul forced-draft blower isolation and control valves. Staging occupies the single access route shared with lagging crew (WI-2255).', refs: ['NSTM 221', 'Dwg 803-2330512'], qa: ['ITP — valve set / lap', 'Operational test'], matList: ['Valve repair kits', 'Gasket / packing set'], srcTitle: 'FD BLOWER VALVE OH — 4-149', srcComp: '4-149-2-Q FD BLWR RM 3' },
      { id: 'WI-2255', awr: 'AWR 73-26-2255', title: 'Blower room lagging install', type: 'lagging', trade: S.pres, comps: ['4-149-2-Q'], compName: 'Forced Draft Blower Room No. 3', deck: '4th', zone: 'Z5', frame: 'Fr 146–152', system: '512 Ventilation & Uptakes', start: 'W09', finish: 'W12', dur: '15 d', preds: ['WI-2210'], succs: [], status: 'Planned', pct: 0, estMH: 180, actMH: 0, crit: 'Low', onCP: false, event: 'Undock', growth: false, space: sp(false, false, false, true, false), material: 'Awaiting', materialNeed: 'W08', conflicts: ['SR-0137'], conf: 0.9, ingested: '07 May 26', verified: '10 May 26', originator: 'Code 256 · Insulation',
        desc: 'Install lagging on blower room piping. Requires the shared access route currently occupied by valve-overhaul staging (WI-2210).', refs: ['NSTM 635'], qa: ['ITP — coverage VT'], matList: ['Pipe lagging sections', 'Lagging cloth'], srcTitle: 'BLWR RM LAGGING — 4-149', srcComp: '4-149-2-Q FD BLWR RM 3' },
      { id: 'WI-1888', awr: 'AWR 73-26-1888', title: 'Switchboard foundation modification', type: 'structural', trade: S.fit, comps: ['4-102-2-E'], compName: 'Switchboard Room No. 1', deck: '4th', zone: 'Z2', frame: 'Fr 100–104', system: '161 Structural Bulkheads', start: 'W03', finish: 'W06', dur: '15 d', preds: [], succs: ['WI-1905'], status: 'In-Work', pct: 70, estMH: 300, actMH: 232, crit: 'Med', onCP: false, event: 'Fast Cruise', growth: false, space: sp(false, true, true, false, true), material: 'Ready', materialNeed: '—', conflicts: ['SR-0118'], conf: 0.96, ingested: '06 May 26', verified: '09 May 26', originator: 'Code 920 · Structures',
        desc: 'Modify the switchboard foundation to accept the replacement unit. Predecessor to removal WI-1905.', refs: ['Dwg 803-3110450', 'Spec 1610-070'], qa: ['ITP — weld VT/MT', 'Dimensional check'], matList: ['Foundation steel', 'Mounting hardware'], srcTitle: 'SWBD FDN MOD — 4-102', srcComp: '4-102-2-E SWBD RM 1' },
      { id: 'WI-1905', awr: 'AWR 73-26-1905', title: 'Switchboard No. 1 rip-out', type: 'rip-out', trade: S.elec, comps: ['4-102-2-E'], compName: 'Switchboard Room No. 1', deck: '4th', zone: 'Z2', frame: 'Fr 100–104', system: '322 Power Distribution', start: 'W06', finish: 'W08', dur: '10 d', preds: ['WI-1888'], succs: ['WI-1940'], status: 'Planned', pct: 0, estMH: 160, actMH: 0, crit: 'Med', onCP: false, event: 'Fast Cruise', growth: false, space: sp(false, false, true, false, false), material: 'Ready', materialNeed: '—', conflicts: ['SR-0118'], conf: 0.85, ingested: '06 May 26', verified: '', originator: 'Code 300 · Electrical',
        desc: 'Remove switchboard No. 1 after foundation modification. No completed predecessor currently sequenced — requires WI-1888 first.', refs: ['Dwg 803-3220190'], qa: ['Tag-out verified', 'De-energized check'], matList: ['Rigging / lift gear'], srcTitle: 'SWBD 1 REMOVAL — 4-102', srcComp: '4-102-2-E SWBD RM 1' },
      { id: 'WI-6602', awr: 'AWR 73-26-6602', title: 'CPO living space deck covering', type: 'installation', trade: S.fit, comps: ['3-185-0-L'], compName: 'CPO Living Space', deck: '3rd', zone: 'Z5', frame: 'Fr 182–188', system: '634 Deck Covering', start: 'W11', finish: 'W14', dur: '16 d', preds: ['WI-6580'], succs: [], status: 'Planned', pct: 0, estMH: 280, actMH: 0, crit: 'Med', onCP: true, event: 'Fast Cruise', growth: false, space: sp(false, false, false, false, false), material: 'Ready', materialNeed: '—', conflicts: ['SR-0096'], conf: 0.93, ingested: '06 May 26', verified: '09 May 26', originator: 'Code 640 · Outfit',
        desc: 'Install deck covering in CPO living space. Must follow overhead install (WI-6610) to avoid damaging new covering — current order is inverted.', refs: ['NSTM 634', 'Spec 6340-300'], qa: ['ITP — surface prep', 'Bond / adhesion'], matList: ['Deck covering, terrazzo', 'Underlayment'], srcTitle: 'CPO DECK COVERING — 3-185', srcComp: '3-185-0-L CPO LIV SPC' },
      { id: 'WI-6610', awr: 'AWR 73-26-6610', title: 'CPO living space overhead install', type: 'installation', trade: S.fit, comps: ['3-185-0-L'], compName: 'CPO Living Space', deck: '3rd', zone: 'Z5', frame: 'Fr 182–188', system: '640 Living Spaces', start: 'W12', finish: 'W15', dur: '14 d', preds: [], succs: ['WI-6602'], status: 'Planned', pct: 0, estMH: 220, actMH: 0, crit: 'Med', onCP: true, event: 'Fast Cruise', growth: false, space: sp(false, false, false, false, false), material: 'Ready', materialNeed: '—', conflicts: ['SR-0096'], conf: 0.92, ingested: '06 May 26', verified: '09 May 26', originator: 'Code 640 · Outfit',
        desc: 'Install overhead joiner and lighting in CPO living space. Should precede deck covering (WI-6602).', refs: ['Spec 6400-110'], qa: ['ITP — overhead alignment'], matList: ['Joiner panels', 'Lighting fixtures'], srcTitle: 'CPO OVERHEAD — 3-185', srcComp: '3-185-0-L CPO LIV SPC' },
      { id: 'WI-5560', awr: 'AWR 73-26-5560', title: 'Fan room ventilation modification', type: 'mechanical', trade: S.mach, comps: ['4-120-4-Q'], compName: 'Fan Room', deck: '4th', zone: 'Z3', frame: 'Fr 118–124', system: '512 Ventilation & Uptakes', start: 'W08', finish: 'W11', dur: '15 d', preds: [], succs: ['WI-5571'], status: 'In-Work', pct: 55, estMH: 300, actMH: 168, crit: 'Low', onCP: false, event: 'Sea Trials', growth: false, space: sp(false, false, true, true, true), material: 'Ready', materialNeed: '—', conflicts: ['SR-0101'], conf: 0.95, ingested: '05 May 26', verified: '08 May 26', originator: 'Code 510 · HVAC',
        desc: 'Modify supply ventilation ductwork in fan room. Predecessor to insulation WI-5571.', refs: ['NSTM 510', 'Dwg 803-5120770'], qa: ['ITP — duct leak test', 'Airflow balance'], matList: ['Galvanized duct', 'Flex connectors'], srcTitle: 'FAN RM VENT MOD — 4-120', srcComp: '4-120-4-Q FAN RM' },
      { id: 'WI-5571', awr: 'AWR 73-26-5571', title: 'Fan room duct insulation', type: 'lagging', trade: S.pres, comps: ['4-120-4-Q'], compName: 'Fan Room', deck: '4th', zone: 'Z3', frame: 'Fr 118–124', system: '512 Ventilation & Uptakes', start: 'W11', finish: 'W13', dur: '12 d', preds: ['WI-5560'], succs: [], status: 'Planned', pct: 0, estMH: 140, actMH: 0, crit: 'Low', onCP: false, event: 'Sea Trials', growth: false, space: sp(false, false, false, true, false), material: 'Awaiting', materialNeed: 'W10', conflicts: ['SR-0101'], conf: 0.88, ingested: '05 May 26', verified: '08 May 26', originator: 'Code 256 · Insulation',
        desc: 'Install duct insulation in fan room. Material not on dock until after vent-mod completion.', refs: ['NSTM 635'], qa: ['ITP — coverage VT'], matList: ['Duct insulation board', 'Facing / tape'], srcTitle: 'FAN RM DUCT INSUL — 4-120', srcComp: '4-120-4-Q FAN RM' },
      { id: 'WI-3905', awr: 'AWR 73-26-3905', title: 'Aft IC preservation & cableway closure', type: 'preservation', trade: S.elec, comps: ['4-141-0-C'], compName: 'Aft IC & Gyro Room', deck: '4th', zone: 'Z5', frame: 'Fr 138–144', system: '431 Interior Comm', start: 'W10', finish: 'W14', dur: '18 d', preds: ['WI-3880'], succs: [], status: 'Planned', pct: 0, estMH: 340, actMH: 0, crit: 'High', onCP: false, event: 'Cross', growth: false, space: sp(true, false, true, true, false), material: 'Ready', materialNeed: '—', conflicts: ['XR-0007'], conf: 0.83, ingested: '05 May 26', verified: '', originator: 'Code 400 · IC/Gyro',
        desc: 'Preserve the aft IC & gyro room and close out the cableway. Cableway closure blocks a future combat-system cable pull (WI-8810, DPIA-28).', refs: ['NSTM 631', 'Dwg 803-4310330'], qa: ['ITP — coating DFT', 'Cableway closure VT'], matList: ['Coating system', 'Cableway hardware'], srcTitle: 'AFT IC PRES / CABLEWAY — 4-141', srcComp: '4-141-0-C AFT IC & GYRO' },
      { id: 'WI-8810', awr: 'AWR 75-28-8810', title: 'Combat-system cable pull (FY28)', type: 'installation', trade: S.elec, comps: ['4-141-0-C'], compName: 'Aft IC & Gyro Room', deck: '4th', zone: 'Z5', frame: 'Fr 138–144', system: '400 Command & Surveillance', start: 'FY28', finish: 'FY28', dur: 'TBD', preds: [], succs: [], status: 'On-Hold', pct: 0, estMH: 0, actMH: 0, crit: 'High', onCP: false, event: 'Cross', growth: true, space: sp(false, false, true, true, false), material: 'Awaiting', materialNeed: 'FY28', conflicts: ['XR-0007'], conf: 0.78, ingested: '05 May 26', verified: '', originator: 'Program Office · Cross-Avail',
        desc: 'Future combat-system cable pull tied to CVN-75 / CVN-73 DPIA-28. Route must be coordinated into PIA-26 scope before WI-3905 closes the cableway.', refs: ['XAV-01 Coordination Memo'], qa: ['Route survey'], matList: ['Combat-system cable (FY28)'], srcTitle: 'CS CABLE PULL FY28 — 4-141', srcComp: '4-141-0-C AFT IC & GYRO' },
    ];

    const types = ['preservation', 'mechanical', 'electrical', 'structural', 'installation', 'rip-out', 'interference removal', 'lagging', 'hot work', 'test', 'button-up'];
    const tShop = { preservation: S.pres, lagging: S.pres, mechanical: S.mach, electrical: S.elec, structural: S.fit, installation: S.fit, 'rip-out': S.fit, 'interference removal': S.fit, 'hot work': S.weld, test: S.elec, 'button-up': S.fit };
    const tTitle = { preservation: 'Preservation & coating', lagging: 'Lagging / insulation install', mechanical: 'Valve & pump overhaul', electrical: 'Switchboard & cableway work', structural: 'Structural insert & foundation', installation: 'Equipment foundation install', 'rip-out': 'Rip-out & removal', 'interference removal': 'Interference removal', 'hot work': 'Hot-work / welding repair', test: 'System test & NDT', 'button-up': 'Closure & button-up' };
    const decks = [['Main', '1'], ['2nd', '2'], ['3rd', '3'], ['4th', '4'], ['O-2', '02']];
    const uses = ['Q', 'E', 'L', 'M', 'C', 'A', 'W', 'T', 'V'];
    const useName = { Q: 'Machinery space', E: 'Electrical space', L: 'Living space', M: 'Magazine', C: 'Control / IC', A: 'Stowage', W: 'Water / tank', T: 'Access trunk', V: 'Void' };
    const systems = ['110 Shell & Plating', '130 Hull Decks', '161 Structural Bulkheads', '233 Propulsion Units', '300 Electric Plant', '311 Power Generation', '322 Power Distribution', '431 Interior Comm', '512 Ventilation & Uptakes', '516 Refrigeration', '521 Firemain', '529 Drainage', '541 JP-5 Fuel', '593 Environmental', '611 Hull Fittings', '631 Preservation', '634 Deck Covering', '640 Living Spaces'];
    const owners = ['J. Reyes · Planner', 'M. Cole · Planner', 'L. Park · IPT', 'T. Okafor · Zone Mgr', 'K. Doyle · Material', '—'];
    const statuses = ['Planned', 'Released', 'In-Work', 'Complete', 'On-Hold'];
    const events = ['Undock', 'Fast Cruise', 'Sea Trials', 'Move-Aboard', '—'];
    const linkSR = { 4: 'SR-0210', 9: 'SR-0215', 14: 'SR-0221' };
    const gen = [];
    const N = 32;
    for (let i = 0; i < N; i++) {
      const type = types[i % types.length];
      const d = decks[i % decks.length];
      const use = uses[i % uses.length];
      const fr = 60 + i * 5;
      const frEnd = fr + 5 + (i % 5);
      const pos = (i % 3 === 0) ? 0 : ((i % 2) ? 1 : 2);
      const comp = d[1] + '-' + fr + '-' + pos + '-' + use;
      const sys = systems[i % systems.length];
      const st = statuses[(i * 3) % statuses.length];
      const pct = st === 'Complete' ? 100 : st === 'Planned' ? 0 : st === 'Released' ? (i % 2 ? 3 : 0) : st === 'On-Hold' ? (20 + (i % 3) * 10) : (25 + (i * 7) % 60);
      const est = 120 + (i * 53) % 620;
      const act = (st === 'Planned' || st === 'Released') ? 0 : Math.round(est * pct / 100 * (0.9 + (i % 3) * 0.06));
      const crit = (i % 7 === 0) ? 'High' : (i % 3 === 0) ? 'Med' : 'Low';
      const onCP = i % 7 === 0;
      const growth = (i === 5 || i === 17 || i === 26);
      const awaiting = (i % 6 === 2);
      const lowConf = (i % 9 === 4);
      const conf = lowConf ? (0.70 + (i % 3) * 0.03) : (0.90 + ((i * 7) % 9) / 100);
      const wk = 2 + (i % 18);
      const fwk = wk + 2 + (i % 5);
      const idn = 9000 + i * 13;
      const id = 'WI-' + idn;
      const isHot = type === 'hot work';
      const isWet = type === 'preservation' || type === 'lagging' || use === 'W';
      const isElec = type === 'electrical' || type === 'rip-out' || use === 'E';
      gen.push({
        id, awr: 'AWR 73-26-' + idn, title: tTitle[type] + ' — ' + useName[use], type, trade: tShop[type], comps: [comp], compName: useName[use], deck: d[0], zone: 'Z' + (1 + (fr % 5)), frame: 'Fr ' + fr + '–' + frEnd, system: sys,
        start: 'W' + (wk < 10 ? '0' + wk : wk), finish: 'W' + (fwk < 10 ? '0' + fwk : fwk), dur: (4 + (i % 6) * 3) + ' d',
        preds: i % 4 === 0 ? [] : ['WI-' + (idn - 7)], succs: i % 3 === 0 ? ['WI-' + (idn + 5)] : [],
        status: st, pct, estMH: est, actMH: act, crit, onCP, event: events[i % events.length], growth,
        space: sp(isWet, isHot, isElec || i % 4 === 0, isWet || use === 'V', st !== 'Planned'),
        material: awaiting ? 'Awaiting' : 'Ready', materialNeed: awaiting ? ('W' + (wk - 1 < 10 ? '0' + (wk - 1) : (wk - 1))) : '—',
        conflicts: linkSR[i] ? [linkSR[i]] : [], conf: Math.round(conf * 100) / 100,
        ingested: (3 + (i % 9)) + ' May 26', verified: lowConf ? '' : ((5 + (i % 9)) + ' May 26'), originator: owners[i % owners.length] === '—' ? 'Code 200 · Production' : owners[i % owners.length],
        desc: tTitle[type] + ' in ' + comp + ' (' + useName[use] + '). Standardized work order extracted from the availability package and ESWBS-coded ' + sys + '.', refs: ['Dwg 803-' + (1000000 + idn), 'Spec ' + sys.split(' ')[0] + '-0' + (10 + i % 80)], qa: ['ITP — ' + (isHot ? 'weld VT/MT' : isWet ? 'coating DFT' : 'functional test'), st === 'Complete' ? 'Final QA accepted' : 'In-process hold point'], matList: [tTitle[type].split(' ')[0] + ' material kit', 'Consumables'],
        srcTitle: tTitle[type].toUpperCase() + ' — ' + comp, srcComp: comp + ' ' + useName[use].toUpperCase(),
      });
    }
    this._wo = anchored.concat(gen);
    return this._wo;
  }

  cfgFlash(msg) {
    this.setState({ cfgToast: msg });
    clearTimeout(this._cfgT);
    this._cfgT = setTimeout(() => { if (this.state.cfgToast === msg) this.setState({ cfgToast: null }); }, 4200);
  }

  icon(key) {
    const c = React.createElement;
    const svg = (ch) => c('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }, ch);
    const p = (d, k) => c('path', { d, key: k });
    const r = (x, y, w, h, k) => c('rect', { x, y, width: w, height: h, rx: 1, key: k });
    const ln = (x1, y1, x2, y2, k) => c('line', { x1, y1, x2, y2, key: k });
    const ci = (cx, cy, rr, k) => c('circle', { cx, cy, r: rr, key: k });
    switch (key) {
      case 'dailyOps': return svg([r(4,4.5,16,16.5,'a'), ln(9,3,9,7,'b'), ln(15,3,15,7,'c'), p('M8.5 14l2.5 2.5 5-5','d')]);
      case 'commandCenter': return svg([r(3,3,7,7,'a'), r(14,3,7,7,'b'), r(3,14,7,7,'c'), r(14,14,7,7,'d')]);
      case 'availabilities': return svg([p('M3 13l1.4 4.6a2 2 0 0 0 1.9 1.4h11.4a2 2 0 0 0 1.9-1.4L21 13z','a'), p('M5.4 13V8a1 1 0 0 1 1-1h7.6l3.6 3v3','b'), ln(9.5,7,9.5,4,'c'), p('M9.5 4l4.5 1.6','d')]);
      case 'workOrders': return svg([r(4,3,16,18,'a'), ln(8,8,16,8,'b'), ln(8,12,16,12,'c'), ln(8,16,13,16,'d')]);
      case 'deckExplorer': return svg([p('M12 3l9 5-9 5-9-5 9-5z','a'), p('M3 12l9 5 9-5','b'), p('M3 16l9 5 9-5','c')]);
      case 'sequenceBoard': return svg([r(3,5,9,3,'a'), r(8,10.5,12,3,'b'), r(3,16,7,3,'c')]);
      case 'conflictsRisk': return svg([p('M12 4l9 15.5H3z','a'), ln(12,10,12,14,'b'), ci(12,16.6,0.35,'c')]);
      case 'cascade': return svg([ci(12,6,2.2,'a'), ci(6,17,2.2,'b'), ci(18,17,2.2,'c'), ln(10.6,7.8,7.4,15.2,'d'), ln(13.4,7.8,16.6,15.2,'e'), ln(8.2,17,15.8,17,'f')]);
      case 'distPackages': return svg([ln(4,5,20,5,'a'), ln(8,5,8,12,'b'), ln(16,5,16,19,'c'), r(2.5,10.5,5,3,'d'), r(13.5,10.5,5,3,'e'), r(13.5,17.5,5,3,'f')]);
      case 'mitigationStudio': return svg([ln(4,7,20,7,'a'), ln(4,12,20,12,'b'), ln(4,17,20,17,'c'), ci(9,7,2,'d'), ci(15,12,2,'e'), ci(7,17,2,'f')]);
      case 'yardResources': return svg([ln(6,4,6,20,'a'), ln(6,5,19,5,'b'), ln(19,5,19,9,'c'), ln(13,5,13.4,8,'d'), ln(4,20,20,20,'e')]);
      case 'crossAvailability': return svg([p('M10.5 13.5a3.5 3.5 0 0 0 5 0l2-2a3.5 3.5 0 0 0-5-5l-1 1','a'), p('M13.5 10.5a3.5 3.5 0 0 0-5 0l-2 2a3.5 3.5 0 0 0 5 5l1-1','b')]);
      case 'materialReadiness': return svg([p('M12 3l8 4v8l-8 4-8-4V7l8-4z','a'), p('M4 7l8 4 8-4','b'), ln(12,11,12,20,'c')]);
      case 'briefings': return svg([p('M6 3h8l5 5v13H6z','a'), p('M14 3v5h5','b'), ln(9,13,16,13,'c'), ln(9,16.5,16,16.5,'d')]);
      case 'ingest': return svg([ln(12,3,12,14,'a'), p('M8 10l4 4 4-4','b'), p('M4 17v3h16v-3','c')]);
      case 'admin': return svg([ci(12,12,3.2,'a'), p('M12 4v2.5M12 17.5V20M4 12h2.5M17.5 12H20M6.3 6.3l1.8 1.8M15.9 15.9l1.8 1.8M17.7 6.3l-1.8 1.8M8.1 15.9l-1.8 1.8','b')]);
      case 'configHistory': return svg([p('M5 3.5h9l3.5 3.5v4','a'), ln(8,8,13,8,'b'), ln(8,11.5,12,11.5,'c'), p('M5 3.5v14a1 1 0 0 0 1 1h4','d'), ci(16.5,15.5,4.5,'e'), p('M16.5 13.4v2.3l1.7 1.1','f')]);
      case 'wadlField': return svg([p('M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z','a')]);
      case 'wadlConsole': return svg([p('M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z','a'), p('M9 12l2 2 4-4','b')]);
      default: return svg([ci(12,12,8,'a')]);
    }
  }

  initialsOf(name) {
    const parts = name.split(' ');
    if (parts.length === 1) return name.slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // ===== SECTION / ZONE MODEL (from the Section Erection Diagram) =====
  _zoneModel() {
    if (this._zm) return this._zm;
    const directors = [
      { id: 'topside', name: 'R. Vance', title: 'Construction Director', role: 'Topside', band: 'Island → Main' },
      { id: 'plant', name: 'D. Kimura', title: 'Construction Director', role: 'Plant', band: '2nd → Double Bottom' },
      { id: 'finish', name: 'A. Serrano', title: 'Construction Director', role: 'Compartment Completion', band: 'Cross-cutting' },
    ];
    const trades = [
      { id: 'fit', code: '11', name: 'Shipfitters', color: '#3D6BFF' },
      { id: 'weld', code: '26', name: 'Welding', color: '#dc2626' },
      { id: 'mach', code: '31', name: 'Inside Machinists', color: '#f59e0b' },
      { id: 'elec', code: '51', name: 'Electrical', color: '#8b9cf0' },
      { id: 'pres', code: '71', name: 'Preservation', color: '#22c55e' },
    ];
    const tradeById = {}; trades.forEach((t) => tradeById[t.id] = t);
    const services = [
      { id: 'chem', name: 'Chemist · gas-free', abbr: 'GF', color: '#7E9CFF', cap: 3, owner: 'Gas-Free Shop · Code 106' },
      { id: 'ndt', name: 'NDT', abbr: 'NDT', color: '#c084fc', cap: 2, owner: 'NDT · Code 138' },
      { id: 'scaf', name: 'Scaffolding', abbr: 'SCAF', color: '#fbbf24', cap: 4, owner: 'Staging · Code 07' },
    ];
    const svcById = {}; services.forEach((s) => svcById[s.id] = s);
    const workDecks = [
      { id: 'main', n: '1', label: 'Main' }, { id: '2nd', n: '2', label: '2nd' }, { id: '3rd', n: '3', label: '3rd' },
      { id: '4th', n: '4', label: '4th' }, { id: '1stplat', n: '5', label: '1st Plat' }, { id: '2ndplat', n: '6', label: '2nd Plat' },
      { id: 'hold', n: '7', label: 'Hold' }, { id: 'db', n: '8', label: 'Dbl Btm' },
    ];
    const wdIdx = {}; workDecks.forEach((d, i) => wdIdx[d.id] = i);
    // seams = continuous bulkheads (natural zone boundaries), fore→aft
    const seams = [0, 60, 120, 185, 240, 280];
    const zones = [
      { id: 'Z1', name: 'Bow · Fwd Weapons', dir: 'plant', supt: 'M. Ortiz', fr: [0, 60], band: ['main', 'db'], leads: ['fit', 'pres'] },
      { id: 'Z2', name: 'Fwd Machinery', dir: 'plant', supt: 'L. Chen', fr: [60, 120], band: ['2nd', 'db'], leads: ['mach', 'elec'] },
      { id: 'Z3', name: 'Amidships · Lower', dir: 'plant', supt: 'T. Boland', fr: [120, 185], band: ['4th', 'db'], leads: ['mach', 'pres'] },
      { id: 'Z4', name: 'Amidships · Hangar', dir: 'topside', supt: 'J. Alvarez', fr: [120, 185], band: ['main', '3rd'], leads: ['weld', 'fit'] },
      { id: 'Z5', name: 'Aft Machinery', dir: 'plant', supt: 'R. Feld', fr: [185, 240], band: ['2nd', 'db'], leads: ['weld', 'mach'] },
      { id: 'Z6', name: 'Fantail · Steering', dir: 'plant', supt: 'S. Ivey', fr: [240, 280], band: ['3rd', 'db'], leads: ['fit', 'elec'] },
    ];
    // cross-zone incursions (H) — a handful, ~3x on a carrier
    const incursions = [
      { id: 'CZ-1', into: 'Z3', from: 'Z4', frame: 150, wi: 'WI-4471', what: 'Hangar hot-work boundary drops into the uptake space below the Fr 150 flat', wk: [4, 7], sev: 'High' },
      { id: 'CZ-2', into: 'Z2', from: 'Z1', frame: 60, wi: 'WI-2210', what: 'Fwd-bulkhead penetration staging crosses the Fr 60 continuous bulkhead', wk: [6, 10], sev: 'Med' },
      { id: 'CZ-3', into: 'Z5', from: 'Z6', frame: 240, wi: 'WI-8810', what: 'Shaft-alley combat-system cable pull breaches the Fr 240 seam', wk: [9, 14], sev: 'Med' },
    ];
    // generate compartments per zone (frame × deck-band grid), deterministic
    const comps = [];
    zones.forEach((z) => {
      const ti = wdIdx[z.band[0]], bi = wdIdx[z.band[1]];
      const bandDecks = workDecks.slice(ti, bi + 1);
      const frames = [];
      for (let f = z.fr[0] + 9; f < z.fr[1] - 2; f += 16) frames.push(f);
      z.compIds = [];
      frames.forEach((f, fx) => {
        bandDecks.forEach((dk, dx) => {
          const h = (f * 7 + dx * 13 + fx * 3) % 1000;
          if ((h % 5) === 0 && fx !== 0 && dx !== 0) return; // sparsity
          const pos = [0, 1, 2][h % 3];
          const use = ['Q', 'E', 'L', 'W', 'M', 'C'][h % 6];
          const comp = dk.n + '-' + f + '-' + pos + '-' + use;
          const lead = z.leads[h % z.leads.length];
          const rmod = h % 9;
          let readiness = 'open';
          if (rmod === 0 || rmod === 6) readiness = 'offlimits';
          const req = [];
          if (h % 2 === 0) req.push({ id: 'chem', clearWk: 3 + (h % 9) });
          if (h % 4 === 1) req.push({ id: 'ndt', clearWk: 6 + (h % 8) });
          if (h % 3 === 0) req.push({ id: 'scaf', clearWk: 2 + (h % 6) });
          if (h % 13 === 4 && req.length) req[0].clearWk = 40; // hard blocker, never cleared in horizon
          const s = 1 + (h % 12);
          const e = s + 4 + (h % 6);
          const onCP = (h % 11 === 0);
          const crew = 4 + (h % 11);
          const mh = crew * 8;
          const cpDays = onCP ? (2 + (h % 5)) : 0;
          const rec = { id: comp, zone: z.id, dir: z.dir, deck: dk.id, deckLabel: dk.label, deckN: dk.n, frame: f, pos, use, lead, readiness, req, s, e, onCP, crew, mh, cpDays };
          comps.push(rec);
          z.compIds.push(comp);
        });
      });
    });
    this._zm = { directors, trades, tradeById, services, svcById, workDecks, wdIdx, seams, zones, incursions, comps, useName: { Q: 'Machinery', E: 'Electrical', L: 'Berthing', W: 'Tank / void', M: 'Magazine', C: 'Control / IC' } };
    return this._zm;
  }
  // live status of a compartment at week wk
  _compStatus(c, wk) {
    if (wk < c.s || wk > c.e) return { key: 'idle', active: false };
    if (c.readiness === 'offlimits') return { key: 'blocked', active: true, reason: 'Off-limits — space not released', svc: null };
    const pending = c.req.filter((r) => wk < r.clearWk);
    if (pending.length) {
      const zm = this._zm;
      return { key: 'blocked', active: true, reason: 'Awaiting ' + pending.map((p) => zm.svcById[p.id].name).join(' + '), svc: pending[0].id };
    }
    return { key: 'doable', active: true, reason: 'All services cleared — cleared to work', svc: null };
  }

  csData() {
    const G = (cols, rows) => ({ cols, rows });
    return {
      newbuild: {
        key: 'newbuild', tab: 'New construction', ctx: 'Unit 5320 · Build Hall Bay 2 · pre-erection · KEEL+340 d',
        trigger: { id: 'HYD-5320-1', kind: 'TEST AUTHORIZED', title: 'Hydrostatic test — Tank 5-82-1-F', at: '06:40',
          detail: '1.5 × design pressure, 4-hour hold. From set-up to acceptance the tank boundary is a pressurized structure, and the unit is a different place to work.', by: 'Test engineer TE-114 · witnessed by government rep' },
        grid: G(['Fr 82–84', 'Fr 84–86', 'Fr 86–88', 'Fr 88–90', 'Fr 90–92', 'Fr 92–96'], ['01 Level', 'Main Deck', '2nd Deck', 'Tank Top']),
        base: 'U5320',
        hit: {
          '3-1': { hop: 0, d: 'SOURCE', name: 'Tank 5-82-1-F', act: 'HYD-5320-1 · hydrostatic test', rule: '—', path: 'ORIGIN', why: 'The authorized test itself. Everything below is a consequence the yard would otherwise discover by walking into it.' },
          '3-0': { hop: 1, d: 'BLOCK', name: 'Tank 5-80-1-F', act: 'WI-6110 · boundary seam grinding', rule: 'R4', path: 'STRUCTURE', why: 'Shares the forward boundary plate with the tank under test. No grinding or arc strike on a pressurized boundary — the plate is carrying test load.' },
          '3-2': { hop: 1, d: 'BLOCK', name: 'Tank 5-86-1-F', act: 'WI-6118 · bracket welding', rule: 'R4', path: 'STRUCTURE', why: 'Shares the after boundary. Structural attachment inside a live test boundary is refused until acceptance.' },
          '2-1': { hop: 1, d: 'BLOCK', name: '2-84-1-Q Pump flat', act: 'WI-6142 · deck penetration for sounding tube', rule: 'R11', path: 'STRUCTURE', why: 'Penetrations of a test boundary are frozen from set-up to acceptance. Cutting the crown of a pressurized tank is the classic new-build near-miss.' },
          '2-0': { hop: 2, d: 'WARN', name: '2-82-1-Q Store', act: 'WI-6150 · staging build-out', rule: 'R7', path: 'SPACE', why: 'Adjacent to the boundary. Permitted with a load limit and no impact loading — the condition is recorded on the permit, not left to judgement.' },
          '2-2': { hop: 2, d: 'WARN', name: '2-86-1-Q Passage', act: 'WI-6155 · cable pull', rule: 'R7', path: 'SPACE', why: 'Egress from the test space runs through here. Work proceeds only while the route stays clear and the test boundary is signed and posted.' },
          '3-3': { hop: 2, d: 'SUSPEND', name: 'Fill & drain flat', act: 'WI-6203 · pump motor termination', rule: 'R13', path: 'SYSTEM', why: 'The fill main is lined up to the tank and tagged out for the test. Electrical work on that circuit is suspended for the duration — the isolation is what makes the test safe.' },
          '1-1': { hop: 2, d: 'BLOCK', name: '1-84-0-L Main deck', act: 'WI-6171 · hot work, foundation chocks', rule: 'R4', path: 'STRUCTURE', why: 'Directly over the tank crown. Heat into a pressurized boundary is refused regardless of how it is staged.' },
          '1-2': { hop: 3, d: 'WARN', name: '1-86-0-L Main deck', act: 'WI-6188 · boundary coating', rule: 'R24', path: 'ITP', why: 'Coating of the test boundary follows acceptance and never precedes it — otherwise the test is run against a surface nobody can inspect afterwards.' },
          '0-1': { hop: 3, d: 'WARN', name: '01-84-0-Q', act: 'IP-5320-c · unit close-out survey', rule: 'R21', path: 'ITP', why: 'The unit close-out hold point cannot be signed before hydro acceptance. This is the point the ITP carries forward into the ship record.' },
        },
        ladder: [
          { hop: 1, id: 'R4', path: 'STRUCTURE', d: 'BLOCK', t: 'No hot work, grinding or attachment on a boundary under test', src: 'Yard test procedure + S9074-AR-GIB-010/278', n: 3 },
          { hop: 1, id: 'R11', path: 'STRUCTURE', d: 'BLOCK', t: 'Penetrations of a test boundary frozen from set-up to acceptance', src: 'Unit test plan · hold point', n: 1 },
          { hop: 2, id: 'R7', path: 'SPACE', d: 'WARN', t: 'Adjacent spaces: load limit, no impact loading, egress kept clear', src: 'Yard safety standard', n: 2 },
          { hop: 2, id: 'R13', path: 'SYSTEM', d: 'SUSPEND', t: 'Fill/drain system isolated — work on the isolated circuit suspended', src: 'Energy isolation (LOTO) procedure', n: 1 },
          { hop: 3, id: 'R21', path: 'ITP', d: 'HOLD', t: 'Unit close-out hold point armed until hydro accepted', src: 'ITP 5320 · witness: government rep', n: 1 },
          { hop: 3, id: 'R24', path: 'ITP', d: 'WARN', t: 'Boundary coating sequenced after test acceptance', src: 'ITP 5320 · sequence constraint', n: 1 },
        ],
        conseq: [['Activities touched', '9', '#f2f3f6'], ['Crews affected', '5', '#f2f3f6'], ['Man-hours at risk', '148', '#f59e0b'], ['Hold points armed', '1', '#c4b5fd'], ['Erection gate', '−2 d', '#dc2626']],
        clear: 'Boundary released on hydro acceptance — forecast 11:10 today. Close-out hold point clears when the government rep signs IP-5320-c.',
      },
      inservice: {
        key: 'inservice', tab: 'In service', ctx: 'CVN-73 · PIA-26 · Graving Dry Dock 4 · W5/26',
        trigger: { id: 'CT-3160-4', kind: 'COATING TICKET OPENED', title: 'Final coat — 3-160-2-Q overhead', at: '07:15',
          detail: 'Eight-hour cure. The compartment becomes a flammable-vapour space, and the deck above becomes a heat path into it.', by: 'Coatings supervisor · verified by gas-free engineer' },
        grid: G(['Fr 154–158', 'Fr 158–162', 'Fr 162–166', 'Fr 166–170', 'Fr 170–174', 'Fr 174–178'], ['2nd Deck', '3rd Deck', '4th Deck', 'Hold']),
        base: 'CVN73',
        hit: {
          '1-1': { hop: 0, d: 'SOURCE', name: '3-160-2-Q', act: 'CT-3160-4 · final coat, curing', rule: '—', path: 'ORIGIN', why: 'The coating ticket. From this moment the space has a vapour hazard and a cure clock.' },
          '0-1': { hop: 1, d: 'BLOCK', name: '2-160-2-Q', act: 'WI-4471 · hot work, foundation', rule: 'R3', path: 'STRUCTURE', why: 'Directly above the curing coat. Heat conducts through the deck into a flammable-vapour space — this is the refusal that prevents the fire.' },
          '2-1': { hop: 1, d: 'BLOCK', name: '4-160-2-Q', act: 'WI-4489 · torch cutting', rule: 'R3', path: 'STRUCTURE', why: 'Directly below. Vapour is heavier than air and the boundary is a deck, not a wall.' },
          '1-0': { hop: 1, d: 'WARN', name: '3-156-2-Q', act: 'WI-4502 · lagging install', rule: 'R6', path: 'SPACE', why: 'Shares a bulkhead. Permitted with the boundary posted and no ignition source carried across it.' },
          '1-2': { hop: 2, d: 'SUSPEND', name: '3-164-2-Q', act: 'WI-4510 · grinding', rule: 'R8', path: 'SYSTEM', why: 'On the same ventilation zone. While the zone is exhausting solvent vapour, spark-producing work in it is suspended — not refused, suspended, because it resumes when the zone clears.' },
          '2-2': { hop: 2, d: 'SUSPEND', name: '4-164-2-Q', act: 'WI-4518 · cable pull', rule: 'R8', path: 'SYSTEM', why: 'Same exhaust trunk. The condition follows the air, not the deck plan.' },
          '1-3': { hop: 2, d: 'WARN', name: '3-168-2-Q', act: 'WI-4523 · valve overhaul', rule: 'R14', path: 'SPACE', why: 'On the egress route from the coated space. Route must stay clear for the duration of the cure.' },
          '0-2': { hop: 3, d: 'WARN', name: '2-164-2-Q', act: 'WI-4530 · deck preservation', rule: 'R24', path: 'ITP', why: 'Sequenced behind the cure so the inspection of the coat below is not compromised by work above it.' },
          '2-0': { hop: 3, d: 'WARN', name: '4-156-2-Q', act: 'IP-4471-c · weld visual hold point', rule: 'R21', path: 'ITP', why: 'The inspector cannot reach the hold point while the boundary is posted. The point stays armed; the schedule is told.' },
        },
        ladder: [
          { hop: 1, id: 'R3', path: 'STRUCTURE', d: 'BLOCK', t: 'No hot work within the vertical boundary of a curing coat', src: 'NSTM Ch. 074 · yard coatings standard', n: 2 },
          { hop: 1, id: 'R6', path: 'SPACE', d: 'WARN', t: 'Bulkhead-adjacent work: boundary posted, no ignition source', src: 'Yard safety standard', n: 1 },
          { hop: 2, id: 'R8', path: 'SYSTEM', d: 'SUSPEND', t: 'Shared ventilation zone — spark-producing work suspended while exhausting', src: 'Gas-free engineering procedure', n: 2 },
          { hop: 2, id: 'R14', path: 'SPACE', d: 'WARN', t: 'Egress route from the affected space kept clear', src: 'NSI 009-32', n: 1 },
          { hop: 3, id: 'R21', path: 'ITP', d: 'HOLD', t: 'Inspection hold point unreachable — stays armed, schedule notified', src: 'ITP · availability test plan', n: 1 },
          { hop: 3, id: 'R24', path: 'ITP', d: 'WARN', t: 'Work above a cured coat sequenced after inspection', src: 'Coating ITP · sequence constraint', n: 1 },
        ],
        conseq: [['Activities touched', '8', '#f2f3f6'], ['Crews affected', '6', '#f2f3f6'], ['Man-hours at risk', '96', '#f59e0b'], ['Hold points armed', '1', '#c4b5fd'], ['Critical path', '−1 d', '#dc2626']],
        clear: 'Cure complete 15:15. Ventilation zone clears on gas-free re-survey; suspended activities resume automatically when it does.',
      },
      credential: {
        key: 'credential', tab: 'Credential lapse', ctx: 'CVN-73 · PIA-26 · mid-shift · 13:40',
        trigger: { id: 'CR-FW-2291', kind: 'CREDENTIAL EXPIRING', title: 'Fire-watch qualification FW-2291 expires 14:00', at: '13:40',
          detail: 'One holder, three active permits, three compartments. Nothing in the yard has physically changed — but in twenty minutes three authorizations stop being valid.', by: 'Detected by the authorization layer, not by a supervisor' },
        grid: G(['Fr 154–158', 'Fr 158–162', 'Fr 162–166', 'Fr 166–170', 'Fr 170–174', 'Fr 174–178'], ['2nd Deck', '3rd Deck', '4th Deck', 'Hold']),
        base: 'CVN73',
        hit: {
          '1-2': { hop: 0, d: 'SOURCE', name: 'D. Alvarez · FW-2291', act: 'Fire watch on three permits', rule: '—', path: 'ORIGIN', why: 'A person, not a place. The credential is the object that expires — and it is attached to work in three separate compartments.' },
          '0-1': { hop: 1, d: 'SUSPEND', name: '2-160-2-Q', act: 'HW-1043 · hot work', rule: 'R17', path: 'CREDENTIAL', why: 'Loses its fire watch at 14:00. Suspended at the boundary, not stopped mid-cut — the torch goes down, the watch stays until the hold elapses.' },
          '1-1': { hop: 1, d: 'SUSPEND', name: '3-160-2-Q', act: 'HW-1051 · hot work', rule: 'R17', path: 'CREDENTIAL', why: 'Same holder, same expiry, different deck. A paper permit system cannot see this at all.' },
          '2-3': { hop: 1, d: 'SUSPEND', name: '4-168-2-Q', act: 'HW-1062 · hot work', rule: 'R17', path: 'CREDENTIAL', why: 'Third permit. One lapse, three spaces — the reason credentials are modelled as first-class objects.' },
          '1-3': { hop: 2, d: 'WARN', name: '3-168-2-Q', act: 'Relief watch R. Okafor FW-3310', rule: 'R18', path: 'CREDENTIAL', why: 'A qualified relief is on shift two compartments away. The layer offers the swap before the expiry rather than reporting the violation after it.' },
          '0-2': { hop: 2, d: 'WARN', name: '2-164-2-Q', act: 'HW-1043 fire-watch hold', rule: 'R9', path: 'SPACE', why: 'The post-work fire-watch hold still has 20 minutes to run. The hold does not care that the shift is ending.' },
          '2-1': { hop: 3, d: 'BLOCK', name: '4-160-2-Q', act: 'Re-arm without relief', rule: 'R19', path: 'ITP', why: 'If no relief is accepted, the permits close and re-arming tomorrow requires a fresh gas-free survey. The cost of doing nothing is made explicit now, not discovered at 06:00.' },
        },
        ladder: [
          { hop: 1, id: 'R17', path: 'CREDENTIAL', d: 'SUSPEND', t: 'Authorization suspended when a required qualification lapses', src: 'NAVSEA qualification requirements', n: 3 },
          { hop: 2, id: 'R18', path: 'CREDENTIAL', d: 'WARN', t: 'Qualified relief offered before expiry, with location and ETA', src: 'Yard watch-standing procedure', n: 1 },
          { hop: 2, id: 'R9', path: 'SPACE', d: 'WARN', t: 'Post-work fire-watch hold runs to completion regardless of shift boundary', src: 'NSI 009-07', n: 1 },
          { hop: 3, id: 'R19', path: 'ITP', d: 'BLOCK', t: 'Closed permits require a fresh gas-free survey before re-arming', src: 'Gas-free engineering procedure', n: 1 },
        ],
        conseq: [['Permits affected', '3', '#f2f3f6'], ['Compartments', '3', '#f2f3f6'], ['Man-hours at risk', '34', '#f59e0b'], ['Relief available', 'Yes', '#4ade80'], ['If unresolved', '+1 survey', '#dc2626']],
        clear: 'Accepting the relief swap keeps all three permits live. Declining closes them at 14:00 and costs a gas-free re-survey tomorrow morning.',
      },
    };
  }

  // ===================== DISTRIBUTED PACKAGES =====================
  // A distributed package is ONE work order whose execution is spread over many
  // compartments and whose segments form a network. Two facts follow, and the
  // whole module exists to make them visible:
  //   1. authorization state is a DISTRIBUTION over the footprint, not a value;
  //   2. a segment cannot be tested until it AND everything upstream is complete,
  //      so one held compartment can strand man-hours it does not contain.
  dpData() {
    return {
      hvac: {
        tab: 'HVAC · AC-2 supply', id: 'DP-2201', wi: 'WI-2201', testVerb: 'leak-tested',
        name: 'AC Plant No. 2 — supply & return distribution',
        system: 'Ventilation & air conditioning · Zone 3 forward and aft',
        std: 'MIL-STD-1689A · duct close-out per S9074-AR-GIB-010/278 · balance per NSTM Ch. 510',
        segs: [
          { id: 'T1', kind: 'Trunk', name: 'Main supply trunk — AC-2 to Fr 148', up: null, fn: 'Feeds every branch in the package', comps: ['3-172-0-M', '3-160-2-Q', '3-148-0-L'] },
          { id: 'B1', kind: 'Branch', name: 'Branch 1 — Zone 3 upper, mess and scullery', up: 'T1', fn: 'Terminal supply, 6 diffusers', comps: ['2-160-1-Q', '2-152-0-Q'] },
          { id: 'B2', kind: 'Branch', name: 'Branch 2 — switchgear and berthing', up: 'T1', fn: 'Switchgear cooling + berthing supply', comps: ['3-148-2-E', '3-140-0-Q'] },
          { id: 'T2', kind: 'Trunk', name: 'Aft supply trunk — Fr 176 to Fr 192', up: 'T1', fn: 'Feeds Branch 3 and the hangar riser', comps: ['3-184-0-Q', '3-192-2-E'] },
          { id: 'B3', kind: 'Branch', name: 'Branch 3 — wardroom terminal', up: 'T2', fn: 'Terminal supply, 3 diffusers', comps: ['2-176-0-Q'] },
          { id: 'R1', kind: 'Riser', name: 'Riser — Hangar Bay 2 supply', up: 'T2', fn: 'Vertical riser, 3rd deck to hangar', comps: ['1-160-0-Q'] },
        ],
        comps: {
          '3-172-0-M': { use: 'AC Plant No. 2', zone: 'Zone 3', deck: '3rd', trade: 'Sheet metal', mh: 620, done: 620, auth: 'ALLOW', rule: null, why: 'Gas-free certificate current, no adjacent restriction. Duct set, hangers torqued, close-out signed.', earliest: null },
          '3-160-2-Q': { use: 'Pump Room No. 3', zone: 'Zone 3', deck: '3rd', trade: 'Sheet metal', mh: 380, done: 380, auth: 'ALLOW', rule: null, why: 'Complete and closed out. Leak test witnessed 22 Jul.', earliest: null },
          '3-148-0-L': { use: 'Passage 3-148', zone: 'Zone 3', deck: '3rd', trade: 'Sheet metal', mh: 240, done: 240, auth: 'ALLOW', rule: null, why: 'Complete. Insulation and lagging accepted.', earliest: null },
          '2-160-1-Q': { use: 'Mess Deck Forward', zone: 'Zone 2', deck: '2nd', trade: 'Sheet metal', mh: 560, done: 410, auth: 'WARN', rule: 'R09', why: 'Coating cure in 2-158-0-Q shares the ventilation branch. Work permitted with continuous monitoring; no grinding or cutting until 06:00.', earliest: 'Unrestricted 06:00 tomorrow' },
          '2-152-0-Q': { use: 'Scullery', zone: 'Zone 2', deck: '2nd', trade: 'Sheet metal', mh: 400, done: 180, auth: 'ALLOW', rule: null, why: 'Clear. Two crews assignable today; access through 2-154 is open.', earliest: null },
          '3-148-2-E': { use: 'Switchgear Room No. 2', zone: 'Zone 3', deck: '3rd', trade: 'Sheet metal + EL', mh: 320, done: 96, auth: 'BLOCK', rule: 'R07', why: 'Bus 3-SG-2 is energized. Duct penetration work inside the switchgear envelope requires energy isolation and a verified zero-energy state.', earliest: 'Isolation window Thu 0600–1400' },
          '3-140-0-Q': { use: 'Berthing 3-140', zone: 'Zone 3', deck: '3rd', trade: 'Sheet metal', mh: 480, done: 0, auth: 'PENDING', rule: null, why: 'Predecessor not complete — overhead cableway pull CBL-3310 must clear the same overhead before duct can be hung.', earliest: 'After CBL-3310 segment C2' },
          '3-184-0-Q': { use: 'Auxiliary Machinery 2', zone: 'Zone 3', deck: '3rd', trade: 'Sheet metal', mh: 340, done: 300, auth: 'SUSPEND', rule: 'R04', why: 'Hot work authorized in 2-184-0-Q directly above. Overhead work in this space is suspended for the duration plus the post-work fire watch.', earliest: 'Resumes 15:40 (fire watch ends)' },
          '3-192-2-E': { use: 'IC Room', zone: 'Zone 3', deck: '3rd', trade: 'Sheet metal', mh: 210, done: 210, auth: 'ALLOW', rule: null, why: 'Complete and closed out.', earliest: null },
          '2-176-0-Q': { use: 'Wardroom', zone: 'Zone 2', deck: '2nd', trade: 'Sheet metal', mh: 300, done: 165, auth: 'ALLOW', rule: null, why: 'Clear. Install proceeding; terminal boxes staged.', earliest: null },
          '1-160-0-Q': { use: 'Hangar Bay 2 — riser', zone: 'Zone 1', deck: 'Main', trade: 'Sheet metal + NDT', mh: 300, done: 60, auth: 'BLOCK', rule: 'R21', why: 'ITP hold point IP-4471-r is open on weld W-4471-c in the riser foundation. Radiography returned rejectable porosity; the weld is in rework.', earliest: 'After re-shoot and disposition' },
        },
        gates: [
          { id: 'G1', name: 'Install and hang', need: 'All 11 compartments duct set and hangers torqued' },
          { id: 'G2', name: 'Duct close-out and insulation', need: 'Close-out signed per compartment; insulation accepted' },
          { id: 'G3', name: 'Leak test, per segment', need: 'Each segment and everything upstream of it complete' },
          { id: 'G4', name: 'Air balance, system-wide', need: 'Every segment leak-tested — one open segment holds the whole system' },
          { id: 'G5', name: 'System sell-off', need: 'Balance report + OQE package complete' },
        ],
      },
      cable: {
        tab: 'Cableway · CBL-3310', id: 'DP-3310', wi: 'WI-3310', testVerb: 'continuity- and megger-tested',
        name: 'Zone 3 overhead cableway — power and IC pulls',
        system: 'Electrical distribution and interior communications',
        std: 'MIL-STD-2003 · terminations per NSTM Ch. 320 · segregation per MIL-STD-1310',
        segs: [
          { id: 'C1', kind: 'Run', name: 'Main run — Fr 140 to Fr 160, overhead 3rd deck', up: null, fn: 'Primary hanger run, 84 cables', comps: ['3-148-0-L', '3-152-0-Q'] },
          { id: 'C2', kind: 'Run', name: 'Berthing overhead — Fr 140', up: 'C1', fn: 'Branch pulls, 22 cables', comps: ['3-140-0-Q'] },
          { id: 'C3', kind: 'Run', name: 'Switchgear terminations', up: 'C1', fn: 'Terminations at bus 3-SG-2', comps: ['3-148-2-E'] },
        ],
        comps: {
          '3-148-0-L': { use: 'Passage 3-148', zone: 'Zone 3', deck: '3rd', trade: 'Electrical', mh: 410, done: 410, auth: 'ALLOW', rule: null, why: 'Hangers set, cables pulled and tagged.', earliest: null },
          '3-152-0-Q': { use: 'Storeroom 3-152', zone: 'Zone 3', deck: '3rd', trade: 'Electrical', mh: 260, done: 240, auth: 'ALLOW', rule: null, why: 'Pull complete; tie-off and tagging in progress.', earliest: null },
          '3-140-0-Q': { use: 'Berthing 3-140', zone: 'Zone 3', deck: '3rd', trade: 'Electrical', mh: 520, done: 310, auth: 'ALLOW', rule: null, why: 'Clear and working. This run must clear the overhead before HVAC DP-2201 can hang duct in the same space.', earliest: null },
          '3-148-2-E': { use: 'Switchgear Room No. 2', zone: 'Zone 3', deck: '3rd', trade: 'Electrical', mh: 300, done: 40, auth: 'BLOCK', rule: 'R07', why: 'Bus 3-SG-2 energized. Terminations require a verified zero-energy state — the same isolation window HVAC needs.', earliest: 'Isolation window Thu 0600–1400' },
        },
        gates: [
          { id: 'G1', name: 'Hanger and pull', need: 'All runs pulled, tagged and tied off' },
          { id: 'G2', name: 'Segregation inspection', need: 'Separation between power and IC verified per MIL-STD-1310' },
          { id: 'G3', name: 'Terminations', need: 'Both ends terminated under isolation' },
          { id: 'G4', name: 'Continuity and megger', need: 'Every cable tested end to end' },
          { id: 'G5', name: 'System sell-off', need: 'Test record + OQE package complete' },
        ],
      },
      chw: {
        tab: 'Chilled water · CHW-2450', id: 'DP-2450', wi: 'WI-2450', testVerb: 'hydrostatically tested',
        name: 'Chilled water loop No. 2 — piping renewal',
        system: 'Chilled water, pressure boundary',
        std: 'S9074-AR-GIB-010/278 · hydrostatic per S9074-AQ-GIB-010/248 · two-key disposition',
        segs: [
          { id: 'P1', kind: 'Header', name: 'Supply header — AC-2 to Fr 160', up: null, fn: 'Pressure boundary, 150 psig service', comps: ['3-172-0-M', '3-160-2-Q'] },
          { id: 'P2', kind: 'Branch', name: 'Branch — cooling coil supply, Zone 2', up: 'P1', fn: 'Feeds three coil banks', comps: ['2-160-1-Q'] },
          { id: 'P3', kind: 'Return', name: 'Return header — Fr 160 to AC-2', up: 'P1', fn: 'Return side, common with supply test', comps: ['3-164-0-L'] },
        ],
        comps: {
          '3-172-0-M': { use: 'AC Plant No. 2', zone: 'Zone 3', deck: '3rd', trade: 'Pipefitting + NDT', mh: 540, done: 540, auth: 'ALLOW', rule: null, why: 'Welds complete; RT accepted with second attest (pressure boundary).', earliest: null },
          '3-160-2-Q': { use: 'Pump Room No. 3', zone: 'Zone 3', deck: '3rd', trade: 'Pipefitting + NDT', mh: 460, done: 395, auth: 'WARN', rule: 'R12', why: 'Two ITP hold points open — VT accepted, RT awaiting the independent Level III attest. Fit-up may continue; the header cannot be hydro-tested.', earliest: 'Attest expected today 16:00' },
          '2-160-1-Q': { use: 'Mess Deck Forward', zone: 'Zone 2', deck: '2nd', trade: 'Pipefitting', mh: 380, done: 120, auth: 'WARN', rule: 'R09', why: 'Coating cure on the shared ventilation branch. No hot work; mechanical joints only until 06:00.', earliest: 'Unrestricted 06:00 tomorrow' },
          '3-164-0-L': { use: 'Passage 3-164', zone: 'Zone 3', deck: '3rd', trade: 'Pipefitting', mh: 300, done: 300, auth: 'ALLOW', rule: null, why: 'Complete. Return side ready for the common hydrostatic test.', earliest: null },
        },
        gates: [
          { id: 'G1', name: 'Fit-up and weld', need: 'All joints welded' },
          { id: 'G2', name: 'NDT and disposition', need: 'RT/VT dispositioned; second attest on pressure boundary' },
          { id: 'G3', name: 'Hydrostatic test', need: 'Header and return complete and dispositioned together' },
          { id: 'G4', name: 'Flush and fill', need: 'Cleanliness verified, system charged' },
          { id: 'G5', name: 'System sell-off', need: 'Hydro record + OQE package complete' },
        ],
      },
    };
  }

  dpVals() {
    const T = {
      ALLOW:   { fg: '#4ade80', bg: 'rgba(34,197,94,0.13)', bd: 'rgba(34,197,94,0.36)', label: 'ALLOW' },
      WARN:    { fg: '#fbbf24', bg: 'rgba(245,158,11,0.13)', bd: 'rgba(245,158,11,0.36)', label: 'WARN' },
      BLOCK:   { fg: '#f87171', bg: 'rgba(220,38,38,0.14)', bd: 'rgba(220,38,38,0.4)', label: 'BLOCK' },
      SUSPEND: { fg: '#c4b5fd', bg: 'rgba(124,58,237,0.16)', bd: 'rgba(124,58,237,0.42)', label: 'SUSPEND' },
      PENDING: { fg: '#8b93a1', bg: 'rgba(148,163,184,0.09)', bd: '#3a3f4b', label: 'NOT READY' },
    };
    const all = this.dpData();
    const key = this.state.dpPkg || 'hvac';
    const pk = all[key];
    const C = pk.comps;

    const tabs = Object.keys(all).map(k => ({
      key: k, label: all[k].tab, active: k === key,
      bg: k === key ? '#3D6BFF' : '#16171b', fg: k === key ? '#ffffff' : '#94a3b8', bd: k === key ? '#3D6BFF' : '#2b2d36',
      onClick: () => this.setState({ dpPkg: k, dpSel: null, dpSeg: null }),
    }));

    // --- topology: depth, ancestry, descendants ---
    const byId = {}; pk.segs.forEach(s => { byId[s.id] = s; });
    const depthOf = (s) => { let d = 0, cur = s; while (cur.up) { d++; cur = byId[cur.up]; } return d; };
    const ancestors = (s) => { const out = []; let cur = byId[s.up]; while (cur) { out.push(cur); cur = byId[cur.up]; } return out; };
    const descendants = (id) => {
      const out = []; const walk = (pid) => pk.segs.filter(s => s.up === pid).forEach(s => { out.push(s); walk(s.id); });
      walk(id); return out;
    };

    // --- per-segment completeness ---
    const segStat = {};
    pk.segs.forEach(s => {
      const mh = s.comps.reduce((a, c) => a + C[c].mh, 0);
      const done = s.comps.reduce((a, c) => a + C[c].done, 0);
      const open = s.comps.filter(c => C[c].done < C[c].mh);
      const complete = open.length === 0;
      segStat[s.id] = { mh, done, open, complete, pct: Math.round(done / mh * 100) };
    });
    // testable = self complete AND every ancestor complete
    pk.segs.forEach(s => {
      const blockers = [s].concat(ancestors(s)).filter(x => !segStat[x.id].complete);
      segStat[s.id].testable = blockers.length === 0;
      segStat[s.id].heldBy = blockers.filter(x => x.id !== s.id).map(x => x.id);
      segStat[s.id].upstreamHeld = segStat[s.id].heldBy.length > 0;
    });

    // --- governing constraint: the compartment stranding the most man-hours it does not contain ---
    const strand = {};
    Object.keys(C).forEach(cid => {
      const own = C[cid].mh - C[cid].done;
      if (own === 0) { strand[cid] = { own: 0, down: 0, segs: [], total: 0 }; return; }
      const homes = pk.segs.filter(s => s.comps.indexOf(cid) >= 0);
      const downSegs = [];
      homes.forEach(h => descendants(h.id).forEach(d => { if (downSegs.indexOf(d) < 0) downSegs.push(d); }));
      const down = downSegs.reduce((a, s) => a + (segStat[s.id].mh - segStat[s.id].done), 0);
      strand[cid] = { own, down, segs: downSegs.map(s => s.id), total: down * 10 + own };
    });
    const govId = Object.keys(strand).sort((a, b) => strand[b].total - strand[a].total)[0];
    const gov = C[govId], govS = strand[govId];
    const govT = T[gov.auth];
    // Two different kinds of pacing item, and the banner must not conflate them:
    // an AUTHORIZATION constraint (a rule refuses the work) and a COMPLETION
    // constraint (nothing refuses it — there is simply work left, and downstream
    // test scope is waiting on it). The second has no earliest-clear time.
    const verb = pk.testVerb || 'tested';
    const isAuth = !!gov.rule;
    const governing = {
      id: govId, use: gov.use, auth: govT.label, fg: govT.fg, bg: govT.bg, bd: govT.bd,
      rule: gov.rule || '—', hasRule: isAuth, why: gov.why,
      earliestLabel: isAuth ? 'Earliest clear' : 'Nature of the hold',
      earliest: isAuth ? (gov.earliest || 'No window published — refer to the rule owner')
        : (govS.segs.length
          ? 'No authorization restriction — a completion constraint. ' + govS.own.toLocaleString() + ' MH of work left here is holding ' + govS.down.toLocaleString() + ' MH of test scope.'
          : 'No authorization restriction — ' + govS.own.toLocaleString() + ' MH simply outstanding.'),
      line: govS.segs.length
        ? 'Holds ' + govS.segs.length + ' downstream segment' + (govS.segs.length > 1 ? 's' : '') + ' (' + govS.segs.join(', ') + ') — ' + govS.down.toLocaleString() + ' MH that are not in this compartment cannot be ' + verb + ' until this one clears.'
        : govS.own.toLocaleString() + ' MH remain in this compartment. No downstream segment depends on it.',
      ownMh: govS.own.toLocaleString(), downMh: govS.down.toLocaleString(),
      onClick: () => this.setState({ dpSel: govId }),
    };

    // --- gates: computed, not asserted ---
    const totalMh = Object.keys(C).reduce((a, c) => a + C[c].mh, 0);
    const doneMh = Object.keys(C).reduce((a, c) => a + C[c].done, 0);
    const installPct = Math.round(doneMh / totalMh * 100);
    const notComplete = Object.keys(C).filter(c => C[c].done < C[c].mh);
    const testableSegs = pk.segs.filter(s => segStat[s.id].testable);
    // Gate copy is derived from THIS package's gate names — the gates are not
    // positionally interchangeable between an HVAC package, a cableway and a
    // pressure boundary, so nothing here may assume HVAC's semantics.
    const gname = (i) => (pk.gates[i] ? pk.gates[i].name.toLowerCase() : 'the preceding gate');
    const gateState = [
      { done: notComplete.length === 0, n: (Object.keys(C).length - notComplete.length) + ' of ' + Object.keys(C).length + ' compartments complete', held: notComplete.length ? notComplete.length + ' open' : null },
      { done: false, n: 'Follows install, per compartment', held: notComplete.length ? 'waiting on install' : null },
      { done: false, n: testableSegs.length + ' of ' + pk.segs.length + ' segments ready for ' + gname(2), held: (pk.segs.length - testableSegs.length) + ' segments held' },
      { done: false, n: 'Requires all ' + pk.segs.length + ' segments cleared through ' + gname(2), held: 'held by ' + (pk.segs.length - testableSegs.length) + ' segments' },
      { done: false, n: 'Follows ' + gname(3), held: 'not started' },
    ];
    const gates = pk.gates.map((g, i) => {
      const st = gateState[i];
      const active = !st.done && (i === 0 || gateState[i - 1].done);
      const tone = st.done ? '#4ade80' : (st.held && !active ? '#6e7480' : '#fbbf24');
      return { key: g.id, id: g.id, name: g.name, need: g.need, n: st.n,
        hasHeld: !!st.held, held: st.held || '', tone,
        dotBg: st.done ? '#22c55e' : (active ? '#f59e0b' : '#2b2d36'),
        dotBd: st.done ? '#4ade80' : (active ? '#fbbf24' : '#3a3f4b'),
        nameColor: st.done ? '#ccd1da' : (active ? '#f2f3f6' : '#8b93a1'),
        notLast: i !== pk.gates.length - 1 };
    });

    // --- compartment chip factory ---
    const sel = this.state.dpSel || null;
    const chip = (cid, segId) => {
      const c = C[cid], t = T[c.auth];
      const pct = Math.round(c.done / c.mh * 100);
      const isSel = sel === cid;
      return {
        key: segId + '-' + cid, id: cid, use: c.use, trade: c.trade,
        state: t.label, fg: t.fg, bg: isSel ? t.bg : '#16171b', bd: isSel ? t.fg : t.bd,
        barW: pct + '%', barBg: t.fg, pct: pct + '%',
        mh: (c.mh - c.done).toLocaleString() + ' MH left',
        hasRule: !!c.rule, rule: c.rule || '',
        onClick: () => this.setState({ dpSel: isSel ? null : cid }),
      };
    };

    // --- run tree ---
    const order = [];
    const walkOrder = (pid, d) => pk.segs.filter(s => (s.up || null) === pid).forEach(s => { order.push([s, d]); walkOrder(s.id, d + 1); });
    walkOrder(null, 0);
    const segRows = order.map(([s, d]) => {
      const st = segStat[s.id];
      const stateLabel = st.testable ? 'TESTABLE' : (st.complete ? 'INSTALLED — HELD UPSTREAM' : 'INSTALL INCOMPLETE');
      const stateFg = st.testable ? '#4ade80' : (st.complete ? '#c4b5fd' : '#fbbf24');
      const stateBg = st.testable ? 'rgba(34,197,94,0.13)' : (st.complete ? 'rgba(124,58,237,0.16)' : 'rgba(245,158,11,0.13)');
      return {
        key: s.id, id: s.id, kind: s.kind, name: s.name, fn: s.fn,
        indent: (d * 26) + 'px', hasUp: !!s.up, upId: s.up || '',
        pct: st.pct + '%', barW: st.pct + '%',
        barBg: st.testable ? '#22c55e' : (st.complete ? '#7c3aed' : '#f59e0b'),
        stateLabel, stateFg, stateBg,
        heldNote: st.upstreamHeld ? 'Cannot be tested — ' + st.heldBy.join(' and ') + ' upstream is not complete' : '',
        hasHeldNote: st.upstreamHeld,
        mh: st.done.toLocaleString() + ' / ' + st.mh.toLocaleString() + ' MH',
        comps: s.comps.map(c => chip(c, s.id)),
      };
    });

    // --- footprint strip, grouped by zone ---
    const zones = [];
    Object.keys(C).forEach(cid => {
      const z = C[cid].zone;
      let g = zones.find(x => x.name === z);
      if (!g) { g = { key: z, name: z, cells: [], mh: 0, open: 0 }; zones.push(g); }
      g.cells.push(chip(cid, 'fp'));
      g.mh += C[cid].mh - C[cid].done;
      if (C[cid].auth !== 'ALLOW') g.open++;
    });
    zones.forEach(z => { z.sub = z.cells.length + ' compartments · ' + z.mh.toLocaleString() + ' MH left' + (z.open ? ' · ' + z.open + ' restricted' : ''); });

    // --- distribution bar: authorization state across the footprint ---
    const counts = {};
    Object.keys(C).forEach(c => { counts[C[c].auth] = (counts[C[c].auth] || 0) + 1; });
    const nComp = Object.keys(C).length;
    const dist = ['ALLOW', 'WARN', 'SUSPEND', 'BLOCK', 'PENDING'].filter(k => counts[k]).map(k => ({
      key: k, label: T[k].label, n: counts[k], fg: T[k].fg, bg: T[k].fg,
      w: (counts[k] / nComp * 100) + '%',
    }));
    const workable = Object.keys(C).filter(c => (C[c].auth === 'ALLOW' || C[c].auth === 'WARN') && C[c].done < C[c].mh);

    // --- selected compartment detail ---
    let detail = false;
    if (sel && C[sel]) {
      const c = C[sel], t = T[c.auth], s = strand[sel];
      const homes = pk.segs.filter(x => x.comps.indexOf(sel) >= 0);
      detail = {
        id: sel, use: c.use, meta: c.zone + ' · ' + c.deck + ' deck · ' + c.trade,
        state: t.label, fg: t.fg, bg: t.bg, bd: t.bd,
        hasRule: !!c.rule, rule: c.rule || '', why: c.why,
        hasEarliest: !!c.earliest, earliest: c.earliest || '',
        pct: Math.round(c.done / c.mh * 100) + '%', barW: Math.round(c.done / c.mh * 100) + '%', barBg: t.fg,
        mhLine: c.done.toLocaleString() + ' of ' + c.mh.toLocaleString() + ' MH booked',
        segLine: homes.map(h => h.id + ' · ' + h.kind).join(', '),
        hasDown: s.segs.length > 0,
        downLine: s.segs.length ? 'Blocks ' + s.segs.join(', ') + ' — ' + s.down.toLocaleString() + ' MH downstream' : '',
        onClose: () => this.setState({ dpSel: null }),
      };
    }

    return {
      tabs, segRows, zones, gates, governing, dist, detail, hasDetail: !!detail,
      pkgId: pk.id, pkgWi: pk.wi, pkgName: pk.name, pkgSystem: pk.system, pkgStd: pk.std,
      nComp: nComp, nZone: zones.length, nSeg: pk.segs.length,
      footprintLine: (function (p) { return p(nComp, 'compartment') + ' · ' + p(zones.length, 'zone') + ' · ' + p(pk.segs.length, 'segment'); })(function (n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }),
      govSegLine: govS.segs.length === 1 ? 'one other segment' : govS.segs.length + ' other segments',
      totalMh: totalMh.toLocaleString(), installPct: installPct + '%', installBarW: installPct + '%',
      testableLine: testableSegs.length + ' of ' + pk.segs.length + ' segments testable',
      workableLine: workable.length + ' of ' + nComp + ' compartments workable this shift',
      stranded: (function () { const s = Object.keys(C).filter(c => C[c].done < C[c].mh).length; return s + ' compartments still open'; })(),
    };
  }

  csVals() {
    const D = { SOURCE: ['#3D6BFF', 'rgba(61,107,255,0.16)'], BLOCK: ['#dc2626', 'rgba(220,38,38,0.13)'], SUSPEND: ['#7c3aed', 'rgba(124,58,237,0.16)'], WARN: ['#f59e0b', 'rgba(245,158,11,0.13)'], HOLD: ['#a78bfa', 'rgba(124,58,237,0.14)'] };
    const all = this.csData();
    const key = this.state.csScenario || 'newbuild';
    const sc = all[key];
    const hop = this.state.csHop === undefined ? 3 : this.state.csHop;
    const selK = this.state.csSel || null;
    const tabs = Object.keys(all).map(k => ({ key: k, label: all[k].tab, active: k === key,
      bg: k === key ? '#3D6BFF' : '#16171b', fg: k === key ? '#ffffff' : '#94a3b8', bd: k === key ? '#3D6BFF' : '#2b2d36',
      onClick: () => this.setState({ csScenario: k, csHop: 3, csSel: null }) }));
    const rows = sc.grid.rows.map((rl, r) => ({
      key: 'r' + r, label: rl,
      cells: sc.grid.cols.map((cl, c) => {
        const h = sc.hit[r + '-' + c];
        const on = h && h.hop <= hop;
        const col = on ? D[h.d === 'SOURCE' ? 'SOURCE' : h.d] : null;
        const sel = selK === (r + '-' + c);
        return {
          key: 'c' + r + '-' + c, label: on ? h.name : cl, sub: on ? h.act : '—',
          bg: on ? col[1] : '#101115', bd: sel ? '#ffffff' : (on ? col[0] : '#22242b'),
          bw: on ? '1.5px' : '1px', fg: on ? '#f2f3f6' : '#4d525c', subFg: on ? '#c9cfd8' : '#33363d',
          chip: on ? (h.d === 'SOURCE' ? 'SOURCE EVENT' : h.d) : '', chipFg: on ? col[0] : 'transparent',
          chipBg: on ? 'rgba(0,0,0,0.35)' : 'transparent', hasChip: !!on,
          op: (h && !on) ? '0.35' : '1',
          onClick: on ? (() => this.setState({ csSel: r + '-' + c })) : (() => this.setState({ csSel: null })),
        };
      }),
    }));
    const steps = [0, 1, 2, 3].map(i => ({ key: 's' + i, n: String(i),
      label: ['Source event', 'Direct boundary', 'System & air', 'Schedule & ITP'][i],
      active: hop === i, done: hop > i,
      bg: hop === i ? '#3D6BFF' : (hop > i ? '#1b2233' : '#16171b'),
      fg: hop === i ? '#ffffff' : (hop > i ? '#9fb8ff' : '#6e7480'),
      bd: hop >= i ? '#3D6BFF' : '#2b2d36',
      onClick: () => this.setState({ csHop: i, csSel: null }) }));
    const lad = sc.ladder.filter(l => l.hop <= hop).map((l, i) => {
      const col = D[l.d] || D.WARN;
      return { key: 'l' + i, id: l.id, path: l.path, d: l.d, t: l.t, src: l.src,
        n: l.n + (l.n === 1 ? ' activity' : ' activities'), hopLabel: 'HOP ' + l.hop,
        dFg: col[0], dBg: col[1] };
    });
    const hits = Object.keys(sc.hit).filter(k => sc.hit[k].hop <= hop && sc.hit[k].hop > 0);
    const selH = selK && sc.hit[selK] ? sc.hit[selK] : null;
    const selCol = selH ? (D[selH.d === 'SOURCE' ? 'SOURCE' : selH.d] || D.WARN) : null;
    return {
      tabs, rows, steps, lad, ctx: sc.ctx, cols: sc.grid.cols.map((c, i) => ({ key: 'h' + i, label: c })),
      trigger: sc.trigger, clear: sc.clear,
      conseq: sc.conseq.map((c, i) => ({ key: 'k' + i, label: c[0], val: c[1], color: c[2] })),
      count: String(hits.length), rules: String(lad.length),
      sel: selH ? { name: selH.name, act: selH.act, why: selH.why, path: selH.path, d: selH.d,
        rule: selH.rule === '—' ? 'Source event' : 'Rule ' + selH.rule, fg: selCol[0], bg: selCol[1] } : false,
      hint: !selH,
    };
  }

  renderVals() {
    const { collapsed, activeModule, persona, contextId, openMenu, subTab, deDeck, deMode, deWeek, deSel, deFSev, deFClass, deFTrade, deFEvent, deReview, deScale, dePanX, dePanY, deNatW, deNatH, deReady, deDragging, deView, vScale, vPanX, vReady, deSpaceLayer, deHoverXFrac, deHoverComp, deFull, deFullVH, deAlt, deLens, deZoneSel, deReadiness, deLead, deShow, deZoneComp, deDir, deTradeSel, woSearch, woType, woTrade, woDeck, woStatus, woSystem, woEvent, woGrowth, woConflict, woMaterial, woSpace, woSort, woGroup, woDensity, woSel, woDetailTab, woSourceId, woChecked, woColsOpen, woCols, woToast, yrTab, yrSel, yrCrane, yrLaydown, yrShore, yrSupplyLines, yrSupplyStatus, yrEdit, yrMapFull, yrHull, yrCritOnly, sbGroup, sbReleasedOnly, sbGasLayer, sbSandbox, sbSel, sbShift, sbCollapsed, sbProposed, sbConflictSel, sbFixSel, sbApplied, sbConflictsOnly, sbLegendOpen, sbToast, crSort, crClass, crSev, crCP, crDeck, crTrade, crAvail, crEvent, crSearch, crSel, crStatus, crOwner, crChecked, crMatrix, sbDragging } = this.state;

    // ---- module defs ----
    const moduleDefs = [
      ['dailyOps', 'Daily Ops', 'Operate'],
      ['deckExplorer', 'Deck Explorer', ''],
      ['sequenceBoard', 'Sequence Board', 'Plan'],
      ['workOrders', 'Work Orders', ''],
      ['conflictsRisk', 'Conflicts & Risk', 'Decide'],
      ['mitigationStudio', 'Mitigation Studio', ''],
      ['availabilities', 'Availabilities', 'Yard'],
      ['yardResources', 'Yard & Resources', ''],
      ['materialReadiness', 'Material Readiness', ''],
      ['configHistory', 'Configuration & History', 'Life cycle'],
      ['admin', 'Admin & Ingest', 'System'],
      ['cascade', 'Deconfliction Cascade', 'Authorization'],
      ['distPackages', 'Distributed Packages', ''],
      ['wadlField', 'Field App ↗', ''],
      ['wadlConsole', 'Approvals Console ↗', ''],
    ];
    const wadlHrefs = { wadlField: 'WADL Field App.dc.html', wadlConsole: 'WADL Console.dc.html' };
    const modules = moduleDefs.map(([id, label, group]) => {
      const active = id === activeModule;
      return {
        id, label, group, hasGroup: !!group,
        icon: this.icon(id),
        accent: active ? '#3D6BFF' : 'transparent',
        rowBg: active ? 'linear-gradient(90deg,rgba(61,107,255,0.16),rgba(61,107,255,0.02))' : 'transparent',
        iconColor: active ? '#3D6BFF' : '#94a3b8',
        labelColor: active ? '#f2f3f6' : '#aab0bd',
        weight: active ? 600 : 500,
        onClick: () => { if (wadlHrefs[id]) { window.location.href = wadlHrefs[id]; return; } this.setState({ activeModule: id }); },
      };
    });

    // ---- contexts ----
    const confStyle = {
      'At Risk': { color: '#f59e0b', bg: 'rgba(245,158,11,0.13)', dot: '#f59e0b' },
      'On Track': { color: '#22c55e', bg: 'rgba(34,197,94,0.13)', dot: '#22c55e' },
      'Planning': { color: '#94a3b8', bg: 'rgba(148,163,184,0.12)', dot: '#6e7480' },
    };
    const ctxDefs = [
      { id: 'cvn73', hull: 'CVN-73', name: 'USS George Washington', avail: 'PIA-26', loc: 'Graving Dry Dock 4', phase: 'Execution · W5/26', conf: 'At Risk', keyEvent: 'Undock · 18 d', alerts: 6 },
      { id: 'cvn71', hull: 'CVN-71', name: 'USS Theodore Roosevelt', avail: 'SRA-26', loc: 'Pier 3', phase: 'Execution · W9/14', conf: 'On Track', keyEvent: 'Move-Aboard · 31 d', alerts: 3 },
      { id: 'cvn75', hull: 'CVN-75', name: 'USS Harry S. Truman', avail: 'DPIA-28', loc: 'Graving Dry Dock 8', phase: 'Planning', conf: 'Planning', keyEvent: 'Future', alerts: 0 },
    ];
    const contexts = ctxDefs.map((c) => {
      const sel = c.id === contextId;
      const cs = confStyle[c.conf];
      return {
        ...c,
        confColor: cs.color, confBg: cs.bg,
        accent: sel ? '#3D6BFF' : 'transparent',
        rowBg: sel ? '#20222b' : 'transparent',
        onClick: () => { this.setState({ contextId: c.id, openMenu: null });
          this._ctxPush && this._ctxPush({ vessel: c.hull }); },
      };
    });
    const ctx = contexts.find((c) => c.id === contextId);

    // ---- personas ----
    const personaMeta = {
      'Planner': { focus: 'Conflicts & sequence', land: 'conflictsRisk' },
      'Zone Manager': { focus: 'Daily Ops — your zone muster', land: 'dailyOps' },
      'Production Super': { focus: 'Daily Ops — shift plan', land: 'dailyOps' },
      'Project Super': { focus: 'Availability health', land: 'availabilities' },
      'IPT': { focus: 'Mitigation decisions', land: 'mitigationStudio' },
      'Program Office': { focus: 'Risk / on-time confidence', land: 'conflictsRisk' },
      'Material Manager': { focus: 'Material readiness', land: 'materialReadiness' },
      'Executive': { focus: 'Throughput / dock utilization', land: 'yardResources' },
    };
    const personas = Object.keys(personaMeta).map((name) => {
      const sel = name === persona;
      return {
        name,
        initials: this.initialsOf(name),
        focus: personaMeta[name].focus,
        accent: sel ? '#3D6BFF' : 'transparent',
        rowBg: sel ? '#20222b' : 'transparent',
        initColor: sel ? '#3D6BFF' : '#94a3b8',
        nameColor: sel ? '#f2f3f6' : '#ccd1da',
        onClick: () => { this.setState({ persona: name, openMenu: null, activeModule: personaMeta[name].land, deAlt: null, deZoneSel: null });
          const back = { Planner: 'supervisor', 'Production Super': 'gforeman', 'Zone Manager': 'marshal', 'Project Super': 'qa' }[name];
          if (back && this._ctxPush) this._ctxPush({ persona: back }); },
      };
    });

    // ---- content placeholder ----
    const hasActive = !!activeModule;
    const activeLabel = hasActive ? modules.find((m) => m.id === activeModule).label : '';

    // ====== COMMAND CENTER ======
    const doActive = activeModule === 'dailyOps';
    const ccActive = activeModule === 'commandCenter';
    const avwActive = activeModule === 'availabilities';
    const deActive = activeModule === 'deckExplorer';
    const sbActive = activeModule === 'sequenceBoard';
    const crActive = activeModule === 'conflictsRisk';
    const woActive = activeModule === 'workOrders';
    const yrActive = activeModule === 'yardResources';
    const cfgActive = activeModule === 'configHistory';
    const csActive = activeModule === 'cascade';
    const cascade = csActive ? this.csVals() : null;
    const dpActive = activeModule === 'distPackages';
    const dp = dpActive ? this.dpVals() : null;
    const showEmpty = !doActive && !ccActive && !avwActive && !deActive && !sbActive && !crActive && !woActive && !yrActive && !cfgActive && !csActive && !dpActive && activeModule !== 'mitigationStudio';

    const goConflicts = (avId) => this.setState({ contextId: avId || contextId, activeModule: 'conflictsRisk', openMenu: null });
    const goAvailability = (avId) => this.setState({ contextId: avId, activeModule: 'availabilities', openMenu: null });
    const goCell = (avId) => this.setState({ contextId: avId, activeModule: 'deckExplorer', openMenu: null });

    // persona lens
    const lensMap = {
      'Planner': { note: 'Conflicts & sequence prioritized', a: ['Open conflicts', '10', '#f2f3f6'], b: ['On critical path', '4', '#dc2626'] },
      'Zone Manager': { note: 'Deck Explorer scoped to your zone', a: ['Your zone', '4th Deck', '#f2f3f6'], b: ['Zone conflicts', '4', '#f59e0b'] },
      'Production Super': { note: 'Threats to next key event foregrounded', a: ['Next gate', 'CVN-73 Undock · 18 d', '#f2f3f6'], b: ['On-CP threats', '2', '#dc2626'] },
      'Project Super': { note: 'Availability health foregrounded', a: ['Availability', 'CVN-73 PIA-26', '#f2f3f6'], b: ['% complete', '72%', '#22c55e'] },
      'IPT': { note: 'Mitigation decisions foregrounded', a: ['Open mitigations', '6', '#f2f3f6'], b: ['Awaiting decision', '3', '#f59e0b'] },
      'Program Office': { note: 'Risk & on-time confidence foregrounded', a: ['Portfolio risk', 'High', '#dc2626'], b: ['On-time confidence', 'At Risk', '#f59e0b'] },
      'Material Manager': { note: 'Material readiness foregrounded', a: ['Material holds', '2', '#f59e0b'], b: ['Late deliveries', '1', '#dc2626'] },
      'Executive': { note: 'Dock utilization & throughput foregrounded', a: ['Dock utilization', '2 / 3 · 67%', '#22c55e'], b: ['Throughput', '41 WI/wk closed', '#f2f3f6'] },
    };
    const lens = lensMap[persona] || lensMap['Planner'];

    const empSet = {
      'Executive': ['avail'],
      'Program Office': ['cp', 'conf'],
      'Production Super': ['events'],
      'Planner': ['open', 'cp'],
      'IPT': ['open'],
      'Zone Manager': ['open'],
      'Project Super': ['avail'],
      'Material Manager': [],
    }[persona] || [];
    const emp = (k) => empSet.includes(k) ? '#3D6BFF' : '#2b2d36';
    const threatsRing = persona === 'Production Super' ? '#3D6BFF' : '#2b2d36';

    // heatmap
    const heatCols = ['Dock / Pier', 'Preservation', 'Hot Work', 'Mechanical', 'Electrical', 'Combat Sys', 'Undock / MA', 'Sea Trials'];
    const riskStyle = {
      ok: { bg: 'rgba(34,197,94,0.16)', bd: 'rgba(34,197,94,0.30)', tx: '#4ade80' },
      watch: { bg: 'rgba(245,158,11,0.16)', bd: 'rgba(245,158,11,0.34)', tx: '#fbbf24' },
      high: { bg: 'rgba(220,38,38,0.20)', bd: 'rgba(220,38,38,0.42)', tx: '#f87171' },
      na: { bg: '#111d26', bd: '#1c1d23', tx: 'transparent' },
    };
    const heatDefs = [
      { id: 'cvn73', label: 'CVN-73', avail: 'PIA-26', cells: [['ok', 0], ['high', 1], ['high', 1], ['watch', 2], ['watch', 1], ['watch', 1], ['high', 0], ['ok', 0]] },
      { id: 'cvn71', label: 'CVN-71', avail: 'SRA-26', cells: [['ok', 0], ['ok', 0], ['high', 1], ['watch', 1], ['ok', 0], ['ok', 0], ['ok', 0], ['ok', 0]] },
      { id: 'cvn75', label: 'CVN-75', avail: 'DPIA-28', cells: [['watch', 0], ['na', 0], ['na', 0], ['na', 0], ['na', 0], ['watch', 0], ['na', 0], ['na', 0]] },
    ];
    const heatRows = heatDefs.map((r) => ({
      id: r.id, label: r.label, avail: r.avail,
      labelColor: r.id === contextId ? '#f2f3f6' : '#aab0bd',
      onClick: () => goAvailability(r.id),
      cells: r.cells.map(([risk, count]) => {
        const s = riskStyle[risk];
        return { bg: s.bg, bd: s.bd, tx: s.tx, count, showCount: count > 0, onClick: () => goCell(r.id) };
      }),
    }));

    // availabilities table
    const tableDefs = [
      { id: 'cvn73', hull: 'CVN-73', avail: 'PIA-26', loc: 'Graving Dry Dock 4', phase: 'Execution', pct: 72, next: 'Undock · 18 d', hard: true, sev: { high: 2, med: 3, low: 1 }, conf: 'At Risk' },
      { id: 'cvn71', hull: 'CVN-71', avail: 'SRA-26', loc: 'Pier 3', phase: 'Execution', pct: 38, next: 'Move-Aboard · 31 d', hard: false, sev: { high: 1, med: 1, low: 1 }, conf: 'On Track' },
      { id: 'cvn75', hull: 'CVN-75', avail: 'DPIA-28', loc: 'Graving Dry Dock 8', phase: 'Planning', pct: 8, next: '— future', hard: false, sev: { high: 0, med: 0, low: 0 }, conf: 'Planning' },
    ];
    const availTable = tableDefs.map((r) => {
      const total = r.sev.high + r.sev.med + r.sev.low;
      const cs = confStyle[r.conf];
      const pctFor = (n) => total ? (n / total * 100).toFixed(1) + '%' : '0%';
      return {
        id: r.id, hull: r.hull, avail: r.avail, loc: r.loc, phase: r.phase, pct: r.pct, next: r.next, conf: r.conf, total,
        rowBg: r.id === contextId ? '#20222b' : 'transparent',
        pctW: r.pct + '%',
        hpW: pctFor(r.sev.high), mpW: pctFor(r.sev.med), lpW: pctFor(r.sev.low),
        hasConf: total > 0, noConf: total === 0,
        confColor: cs.color, confBg: cs.bg,
        nextColor: r.hard ? '#f59e0b' : '#aab0bd',
        onClick: () => goAvailability(r.id),
        onConflicts: (e) => { if (e && e.stopPropagation) e.stopPropagation(); goConflicts(r.id); },
      };
    });

    // threats rail
    const threats = [
      {
        hull: 'CVN-73', event: 'Undock', days: '18', accent: '#dc2626', tag: 'HARD GATE', urgency: '86%',
        avId: 'cvn73',
        conflicts: [
          { id: 'SR-0142', sevColor: '#dc2626', cp: '+6 CP-d', comp: '4-110-2-W Reserve Feed Water Tank' },
          { id: 'SR-0129', sevColor: '#dc2626', cp: '+4 CP-d', comp: '4-136-0-Q Uptake Space No. 2' },
        ],
      },
      {
        hull: 'CVN-71', event: 'Crew Move-Aboard', days: '31', accent: '#f59e0b', tag: 'KEY EVENT', urgency: '52%',
        avId: 'cvn71',
        conflicts: [
          { id: 'SR-0221', sevColor: '#dc2626', cp: 'ON CP', comp: 'Hot-work deconfliction' },
        ],
      },
    ].map((t) => ({ ...t, onConf: () => goConflicts(t.avId) }));

    // ====== AVAILABILITY WORKSPACE ======
    const goModule = (mod) => this.setState({ activeModule: mod, openMenu: null });
    const sevColor = (s) => s === 'High' ? '#dc2626' : (s === 'Med' ? '#f59e0b' : '#94a3b8');

    const avDataDefs = {
      cvn73: {
        hull: 'CVN-73', ship: 'USS George Washington', typeLabel: 'PIA-26 · Planned Incremental Availability',
        phase: 'Execution · W5/26', pct: 72, loc: 'Graving Dry Dock 4',
        nextEvent: 'Undock', nextWhen: '18 d', hard: true, conf: 'At Risk',
        sev: { high: 2, med: 3, low: 1 }, onCP: 2, cpDays: 10, pkgPct: 94, pkgDetail: '312 / 332 WI ingested',
        gates: [
          { name: 'Undock', when: '18 d', hard: true, threats: 2, marker: '#dc2626' },
          { name: 'Fast Cruise', when: '\u2248 +9 d', hard: false, threats: 1, marker: '#f59e0b' },
          { name: 'Sea Trials', when: '\u2248 +24 d', hard: false, threats: 0, marker: '#22c55e' },
        ],
        classes: [
          { short: 'Preservation', count: 1, sev: 'High' },
          { short: 'Hot-work', count: 1, sev: 'High' },
          { short: 'Access / staging', count: 1, sev: 'Med' },
          { short: 'Missing pred.', count: 1, sev: 'Med' },
          { short: 'Seq. inversion', count: 1, sev: 'Med' },
          { short: 'Material timing', count: 1, sev: 'Low' },
        ],
        trades: [
          { name: '71 Preservation', load: 0.9, loadColor: 'linear-gradient(90deg,#b91c1c,#ef4444)' },
          { name: '26 Welding', load: 0.85, loadColor: 'linear-gradient(90deg,#d97706,#f59e0b)' },
          { name: '51 Electrical', load: 0.6, loadColor: 'linear-gradient(90deg,#d97706,#f59e0b)' },
          { name: '31 Inside Machinists', load: 0.55, loadColor: 'linear-gradient(90deg,#0e7490,#3D6BFF)' },
          { name: '11 Shipfitters', load: 0.4, loadColor: 'linear-gradient(90deg,#0e7490,#3D6BFF)' },
        ],
        cross: { id: 'XR-0007', text: '4-141-0-C Aft IC & Gyro Room \u2014 cableway closure conflicts with CVN-75 DPIA-28 combat-system cable pull.' },
        conflicts: [
          { id: 'SR-0142', sev: 'High', onCP: true, cls: 'Preservation-boundary rework', comp: '4-110-2-W Reserve Feed Water Tank', frame: 'Fr 110', deck: '4th Deck', cp: '+6 CP-d', mit: 'Re-sequence WI-3402 ahead of WI-3318 final coat.' },
          { id: 'SR-0129', sev: 'High', onCP: true, cls: 'Hot-work deconfliction', comp: '4-136-0-Q Uptake Space No. 2', frame: 'Fr 136', deck: 'Main Deck', cp: '+4 CP-d', mit: 'Deconflict the hot-work window.' },
          { id: 'SR-0137', sev: 'Med', onCP: false, cls: 'Access / staging', comp: '4-149-2-Q Forced Draft Blower Room No. 3', frame: 'Fr 149', deck: '4th Deck', cp: '\u2014', mit: 'Stagger access windows.' },
          { id: 'SR-0118', sev: 'Med', onCP: false, cls: 'Missing predecessor', comp: '4-102-2-E Switchboard Room No. 1', frame: 'Fr 102', deck: '4th Deck', cp: '\u2014', mit: 'Insert predecessor.' },
          { id: 'SR-0096', sev: 'Med', onCP: true, cls: 'Sequence inversion', comp: '3-185-0-L CPO Living Space', frame: 'Fr 185', deck: '3rd Deck', cp: 'ON CP', mit: 'Invert order.' },
          { id: 'SR-0101', sev: 'Low', onCP: false, cls: 'Material timing', comp: '4-120-4-Q Fan Room', frame: 'Fr 120', deck: '4th Deck', cp: '\u2014', mit: 'Align insulation delivery.' },
        ],
      },
      cvn71: {
        hull: 'CVN-71', ship: 'USS Theodore Roosevelt', typeLabel: 'SRA-26 · Selected Restricted Availability',
        phase: 'Execution · W9/14', pct: 38, loc: 'Pier 3',
        nextEvent: 'Crew Move-Aboard', nextWhen: '31 d', hard: false, conf: 'On Track',
        sev: { high: 1, med: 1, low: 1 }, onCP: 1, cpDays: 3, pkgPct: 88, pkgDetail: '210 / 239 WI ingested',
        gates: [
          { name: 'Crew Move-Aboard', when: '31 d', hard: false, threats: 1, marker: '#f59e0b' },
          { name: 'Sea Trials', when: '\u2248 +40 d', hard: false, threats: 0, marker: '#22c55e' },
        ],
        classes: [
          { short: 'Hot-work', count: 1, sev: 'High' },
          { short: 'Access / staging', count: 1, sev: 'Med' },
          { short: 'Material timing', count: 1, sev: 'Low' },
        ],
        trades: [
          { name: '26 Welding', load: 0.7, loadColor: 'linear-gradient(90deg,#d97706,#f59e0b)' },
          { name: '51 Electrical', load: 0.5, loadColor: 'linear-gradient(90deg,#0e7490,#3D6BFF)' },
          { name: '31 Inside Machinists', load: 0.45, loadColor: 'linear-gradient(90deg,#0e7490,#3D6BFF)' },
          { name: '11 Shipfitters', load: 0.35, loadColor: 'linear-gradient(90deg,#0e7490,#3D6BFF)' },
        ],
        cross: null,
        conflicts: [
          { id: 'SR-0221', sev: 'High', onCP: true, cls: 'Hot-work deconfliction', comp: '2-130-0-L Berthing (hot-work boundary)', frame: 'Fr 130', deck: '2nd Deck', cp: 'ON CP', mit: 'Deconflict the hot-work window.' },
          { id: 'SR-0210', sev: 'Med', onCP: false, cls: 'Access / staging', comp: '3-160-2-Q Pump Room', frame: 'Fr 160', deck: '3rd Deck', cp: '\u2014', mit: 'Stagger access windows.' },
          { id: 'SR-0215', sev: 'Low', onCP: false, cls: 'Material timing', comp: '4-140-4-Q Vent Space', frame: 'Fr 140', deck: '4th Deck', cp: '\u2014', mit: 'Align material delivery.' },
        ],
      },
      cvn75: {
        hull: 'CVN-75', ship: 'USS Harry S. Truman', typeLabel: 'DPIA-28 · Docking Planned Incremental Availability',
        phase: 'Planning', pct: 8, loc: 'Graving Dry Dock 8',
        nextEvent: 'In planning', nextWhen: 'FY28', hard: false, conf: 'Planning',
        sev: { high: 0, med: 0, low: 0 }, onCP: 0, cpDays: 0, pkgPct: 34, pkgDetail: '\u2014 package in build',
        gates: [
          { name: 'Planning complete', when: 'TBD', hard: false, threats: 0, marker: '#94a3b8' },
          { name: 'Dock CVN-75', when: 'FY28', hard: false, threats: 0, marker: '#94a3b8' },
        ],
        classes: [
          { short: 'Preservation', count: 0, sev: 'Low' },
          { short: 'Hot-work', count: 0, sev: 'Low' },
          { short: 'Access / staging', count: 0, sev: 'Low' },
          { short: 'Missing pred.', count: 0, sev: 'Low' },
          { short: 'Seq. inversion', count: 0, sev: 'Low' },
          { short: 'Material timing', count: 0, sev: 'Low' },
        ],
        trades: [],
        cross: { id: 'XR-0007', text: 'Holds the FY28 combat-system cable route that re-opens CVN-73 PIA-26 trunk \u2014 coordinate into PIA-26 scope now.' },
        conflicts: [],
      },
    };
    const avRaw = avDataDefs[contextId] || avDataDefs.cvn73;
    const avTotal = avRaw.sev.high + avRaw.sev.med + avRaw.sev.low;
    const avPctFor = (n) => avTotal ? (n / avTotal * 100).toFixed(1) + '%' : '0%';
    const csA = confStyle[avRaw.conf];
    const av = {
      hull: avRaw.hull, ship: avRaw.ship, typeLabel: avRaw.typeLabel, phase: avRaw.phase,
      pct: avRaw.pct, loc: avRaw.loc, nextEvent: avRaw.nextEvent, nextWhen: avRaw.nextWhen, conf: avRaw.conf,
      onCP: avRaw.onCP, cpDays: avRaw.cpDays, pkgPct: avRaw.pkgPct, pkgDetail: avRaw.pkgDetail,
      total: avTotal, sevHigh: avRaw.sev.high, sevMed: avRaw.sev.med, sevLow: avRaw.sev.low,
      hpW: avPctFor(avRaw.sev.high), mpW: avPctFor(avRaw.sev.med), lpW: avPctFor(avRaw.sev.low),
      hasConf: avTotal > 0, noConf: avTotal === 0,
      confColor: csA.color, confBg: csA.bg,
      pctW: avRaw.pct + '%', pkgW: avRaw.pkgPct + '%',
      tradesCount: avRaw.trades.length,
      hardTag: avRaw.hard, nextColor: avRaw.hard ? '#dc2626' : '#f59e0b',
      hasCross: !!avRaw.cross, crossText: avRaw.cross ? avRaw.cross.text : '', crossId: avRaw.cross ? avRaw.cross.id : '',
      hasTrades: avRaw.trades.length > 0,
      noTrades: avRaw.trades.length === 0,
      gates: avRaw.gates.map((g, i) => ({
        name: g.name, when: g.when, threats: g.threats, hard: g.hard, marker: g.marker,
        hasThreats: g.threats > 0,
        threatColor: g.threats > 0 ? '#f59e0b' : '#6e7480',
        threatBg: g.threats > 0 ? 'rgba(245,158,11,0.13)' : '#0b0c0e',
        showArrow: i < avRaw.gates.length - 1,
        onClick: () => goConflicts(contextId),
      })),
      classes: avRaw.classes.map((c) => ({
        short: c.short, count: c.count,
        accent: c.count === 0 ? '#2b2d36' : sevColor(c.sev),
        countColor: c.count === 0 ? '#6e7480' : '#f2f3f6',
        onClick: () => goConflicts(contextId),
      })),
      trades: avRaw.trades.map((t) => ({ name: t.name, loadW: Math.round(t.load * 100) + '%', loadColor: t.loadColor })),
      conflicts: avRaw.conflicts.map((c) => ({
        id: c.id, sev: c.sev, cls: c.cls, comp: c.comp, frame: c.frame, deck: c.deck, cp: c.cp, mit: c.mit,
        sevColor: sevColor(c.sev),
        onCpTag: c.onCP,
        cpColor: (c.cp.charAt(0) === '+' || c.cp === 'ON CP') ? '#dc2626' : '#6e7480',
        onClick: () => goConflicts(contextId),
      })),
      onCross: () => goModule('yardResources'),
    };

    // sub-tabs
    const subTabDefs = [['overview', 'Overview'], ['sequence', 'Sequence Board'], ['deck', 'Deck Explorer'], ['conflicts', 'Conflicts']];
    const subTabs = subTabDefs.map(([id, label]) => ({
      id, label, active: subTab === id,
      color: subTab === id ? '#f2f3f6' : '#94a3b8',
      bb: subTab === id ? '#f59e0b' : 'transparent',
      onClick: () => this.setState({ subTab: id }),
    }));
    const subOverview = subTab === 'overview';
    const subScoped = subTab !== 'overview';
    const scopedLabel = (subTabDefs.find((d) => d[0] === subTab) || [null, ''])[1];
    const scopedModuleMap = { sequence: 'sequenceBoard', deck: 'deckExplorer', conflicts: 'conflictsRisk' };
    const openScoped = () => goModule(scopedModuleMap[subTab] || 'availabilities');

    // ====== DECK EXPLORER ======
    const frX = (f) => Math.max(0.05, Math.min(0.96, 0.95 - (f / 280) * 0.86));
    const sideY = (side, lvl) => side === 'cl' ? 0.5 : (side === 'port' ? 0.5 - lvl * 0.16 : 0.5 + lvl * 0.16);
    const colorOf = (c) => c.cross ? '#3D6BFF' : sevColor(c.sev);

    const deDecksDef = [
      { id: 'island', label: 'Island', sub: 'Island Levels', img: (window.__resources && window.__resources.deck_island) || 'assets/d00_island.jpg' },
      { id: 'flight', label: 'Flight', sub: 'Flight Deck', img: (window.__resources && window.__resources.deck_flight) || 'assets/d01_flight.jpg' },
      { id: 'gallery', label: 'Gallery', sub: 'Gallery Deck', img: (window.__resources && window.__resources.deck_gallery) || 'assets/d02_gallery.jpg' },
      { id: 'o2', label: 'O-2', sub: 'O-2 Level', img: (window.__resources && window.__resources.deck_o2) || 'assets/d03_o2.jpg' },
      { id: 'o1', label: 'O-1', sub: 'O-1 Level', img: (window.__resources && window.__resources.deck_o1) || 'assets/d04_o1.jpg' },
      { id: 'main', label: 'Main', sub: 'Hangar Deck', img: (window.__resources && window.__resources.deck_main) || 'assets/d05_main.jpg' },
      { id: '2nd', label: '2nd', sub: 'Second Deck', img: (window.__resources && window.__resources.deck_2nd) || 'assets/d06_2nd.jpg' },
      { id: '3rd', label: '3rd', sub: 'Third Deck', img: (window.__resources && window.__resources.deck_3rd) || 'assets/d07_3rd.jpg' },
      { id: '4th', label: '4th', sub: 'Fourth Deck', img: (window.__resources && window.__resources.deck_4th) || 'assets/d08_4th.jpg' },
      { id: '1stplat', label: '1st Plat', sub: 'First Platform', img: (window.__resources && window.__resources.deck_1stplat) || 'assets/d09_1stplat.jpg' },
      { id: '2ndplat', label: '2nd Plat', sub: 'Second Platform', img: (window.__resources && window.__resources.deck_2ndplat) || 'assets/d10_2ndplat.jpg' },
      { id: 'hold', label: 'Hold', sub: 'Hold', img: (window.__resources && window.__resources.deck_hold) || 'assets/d11_hold.jpg' },
      { id: 'db', label: 'Double Btm', sub: 'Double Bottom', img: (window.__resources && window.__resources.deck_db) || 'assets/d12_db.jpg' },
    ];

    const deByCtx = {
      cvn73: [
        { id: 'SR-0142', deck: '4th', frame: 110, side: 'port', lvl: 1, comp: '4-110-2-W', name: 'Reserve Feed Water Tank', cls: 'Preservation-boundary rework', sev: 'High', onCP: true, cp: '+6 CP-d', trade: '71 Preservation', keyEvent: 'Undock', special: 'breach',
          risk: 'Final preservation coat is breached by a later piping mod cut into the tank boundary — full re-coat required.',
          why: 'WI-3402 sounding/vent piping mod opens the tank boundary after WI-3318 lays the final coat. Boundary integrity is lost.',
          traces: [{ from: 'WI-3318 Tank preservation', to: 'WI-3402 Sounding/vent piping mod', rule: 'PRES-07 · No boundary breach after final coat' }],
          wis: [{ id: 'WI-3318', name: 'Tank preservation', s: 3, e: 7, color: '#3D6BFF' }, { id: 'WI-3402', name: 'Sounding/vent piping mod', s: 5, e: 9, color: '#f59e0b' }],
          mit: 'Re-sequence WI-3402 ahead of WI-3318 final coat.' },
        { id: 'SR-0137', deck: '4th', frame: 149, side: 'port', lvl: 1, comp: '4-149-2-Q', name: 'Forced Draft Blower Room No. 3', cls: 'Access / staging', sev: 'Med', onCP: false, cp: '—', trade: '31 Inside Machinists', keyEvent: 'Undock',
          risk: 'Valve-overhaul staging blocks the only access route the lagging crew needs.',
          why: 'WI-2210 and WI-2255 both require the same hatch and route in overlapping weeks.',
          traces: [{ from: 'WI-2210 Valve overhaul', to: 'WI-2255 Lagging install', rule: 'ACC-02 · Shared access-route capacity' }],
          wis: [{ id: 'WI-2210', name: 'Valve overhaul', s: 8, e: 12, color: '#3D6BFF' }, { id: 'WI-2255', name: 'Lagging install', s: 11, e: 14, color: '#f59e0b' }],
          mit: 'Stagger access windows.' },
        { id: 'SR-0118', deck: '4th', frame: 102, side: 'port', lvl: 1, comp: '4-102-2-E', name: 'Switchboard Room No. 1', cls: 'Missing predecessor', sev: 'Med', onCP: false, cp: '—', trade: '51 Electrical', keyEvent: 'Fast Cruise',
          risk: 'Removal is scheduled before its foundation-mod predecessor — work cannot start.',
          why: 'WI-1905 removal has no completed predecessor; WI-1888 foundation mod must precede it.',
          traces: [{ from: 'WI-1888 Foundation mod', to: 'WI-1905 Removal', rule: 'SEQ-01 · Predecessor completion required' }],
          wis: [{ id: 'WI-1888', name: 'Foundation mod', s: 1, e: 3, color: '#3D6BFF' }, { id: 'WI-1905', name: 'Removal', s: 2, e: 4, color: '#f59e0b' }],
          mit: 'Insert predecessor.' },
        { id: 'SR-0101', deck: '4th', frame: 120, side: 'port', lvl: 2, comp: '4-120-4-Q', name: 'Fan Room', cls: 'Material timing', sev: 'Low', onCP: false, cp: '—', trade: '71 Preservation', keyEvent: 'Sea Trials',
          risk: 'Insulation delivery lags vent-mod completion — install slips.',
          why: 'WI-5571 insulation is not on dock until after WI-5560 vent mod completes.',
          traces: [{ from: 'WI-5560 Vent mod', to: 'WI-5571 Insulation', rule: 'MAT-05 · Material on dock before install' }],
          wis: [{ id: 'WI-5560', name: 'Vent mod', s: 12, e: 16, color: '#3D6BFF' }, { id: 'WI-5571', name: 'Insulation', s: 15, e: 18, color: '#f59e0b' }],
          mit: 'Align insulation delivery.' },
        { id: 'XR-0007', deck: '4th', frame: 141, side: 'cl', lvl: 0, comp: '4-141-0-C', name: 'Aft IC & Gyro Room', cls: 'Cross-availability', sev: 'High', onCP: false, cp: 'FY28', trade: '51 Electrical', keyEvent: 'Cross', cross: true,
          risk: 'IC preservation closes a cableway that a future DPIA-28 combat-system cable pull must re-open.',
          why: 'WI-3905 IC preservation / cableway closure (PIA-26) blocks WI-8810 cable pull (CVN-75 / CVN-73 DPIA-28).',
          traces: [{ from: 'WI-3905 IC preservation / cableway closure', to: 'WI-8810 Combat-system cable pull', rule: 'XAV-01 · Cross-availability cable-route coordination' }],
          wis: [{ id: 'WI-3905', name: 'IC preservation / cableway closure', s: 7, e: 10, color: '#3D6BFF' }],
          mit: 'Coordinate the FY28 cable route into PIA-26 scope now.' },
        { id: 'SR-0129', deck: 'main', frame: 136, side: 'cl', lvl: 0, comp: '4-136-0-Q', name: 'Uptake Space No. 2 (under Hangar Bay 2)', cls: 'Hot-work deconfliction', sev: 'High', onCP: true, cp: '+4 CP-d', trade: '26 Welding', keyEvent: 'Undock', prop: { dir: 'down', target: '4th' },
          risk: 'Hangar hot work and uptake lagging share the same vertical space and window — fire / FOD and access conflict.',
          why: 'WI-4471 hangar hot work (Main) overlaps WI-4480 uptake lagging directly below. Hot-work boundary is unsafe with lagging crews present.',
          traces: [{ from: 'WI-4471 Hangar hot work', to: 'WI-4480 Uptake lagging', rule: 'HW-03 · No combustible work within hot-work vertical boundary' }],
          wis: [{ id: 'WI-4471', name: 'Hangar hot work', s: 4, e: 6, color: '#dc2626' }, { id: 'WI-4480', name: 'Uptake lagging', s: 5, e: 7, color: '#f59e0b' }],
          mit: 'Deconflict the hot-work window.' },
        { id: 'SR-0129', ghost: true, deck: '4th', frame: 136, side: 'cl', lvl: 0, comp: '4-136-0-Q', name: 'Uptake Space No. 2 (affected from above)', cls: 'Hot-work deconfliction', sev: 'High', onCP: true, cp: '+4 CP-d', trade: '26 Welding', keyEvent: 'Undock', prop: { dir: 'up', target: 'main' },
          risk: 'Affected space — hot work on the Main (Hangar) deck above propagates into this uptake space.',
          why: 'WI-4480 uptake lagging here cannot run while WI-4471 hangar hot work is active directly above.',
          traces: [{ from: 'WI-4471 Hangar hot work', to: 'WI-4480 Uptake lagging', rule: 'HW-03 · No combustible work within hot-work vertical boundary' }],
          wis: [{ id: 'WI-4471', name: 'Hangar hot work', s: 4, e: 6, color: '#dc2626' }, { id: 'WI-4480', name: 'Uptake lagging', s: 5, e: 7, color: '#f59e0b' }],
          mit: 'Deconflict the hot-work window.' },
        { id: 'SR-0151', deck: '4th', frame: 132, side: 'cl', lvl: 0, comp: '4-132-0-Q', name: 'Machinery Space (under 3-132 coating)', cls: 'Hot-work deconfliction', sev: 'High', onCP: true, cp: '+3 CP-d', trade: '26 Welding', keyEvent: 'Undock', vstate: 'hotwork', prop: { dir: 'up', target: '3rd' },
          risk: '3rd-deck overhead coating still curing; hot work in the space directly below violates the boundary watch and risks blistering the coat.',
          why: '4-132-0-Q hot work is scheduled while 3-132-2-L overhead preservation is still curing directly above.',
          traces: [{ from: 'WI-7720 Overhead preservation (3rd, curing)', to: 'WI-7740 Hot work (4th)', rule: 'PRES-09 · No hot work within a curing-coat boundary' }],
          wis: [{ id: 'WI-7720', name: 'Overhead preservation · curing', s: 4, e: 7, color: '#22c55e' }, { id: 'WI-7740', name: 'Hot work', s: 5, e: 8, color: '#dc2626' }],
          mit: 'Re-sequence the hot work after full cure, or shift it outside the boundary; set a boundary/fire watch if it must proceed.' },
        { id: 'SR-0096', deck: '3rd', frame: 185, side: 'cl', lvl: 0, comp: '3-185-0-L', name: 'CPO Living Space', cls: 'Sequence inversion', sev: 'Med', onCP: true, cp: 'ON CP', trade: '11 Shipfitters', keyEvent: 'Fast Cruise',
          risk: 'Deck covering is scheduled before overhead install — overhead work will damage the new covering.',
          why: 'WI-6602 deck covering precedes WI-6610 overhead install; the order is inverted.',
          traces: [{ from: 'WI-6610 Overhead install', to: 'WI-6602 Deck covering', rule: 'SEQ-04 · Overhead before finish flooring' }],
          wis: [{ id: 'WI-6610', name: 'Overhead install', s: 5, e: 8, color: '#3D6BFF' }, { id: 'WI-6602', name: 'Deck covering', s: 6, e: 9, color: '#f59e0b' }],
          mit: 'Invert order.' },
        { id: 'SR-0163', deck: 'flight', frame: 40, side: 'cl', lvl: 0, comp: '01-040-0-Q', name: 'Catapult No. 1 Trough (bow)', cls: 'Hot-work deconfliction', sev: 'High', onCP: true, cp: '+5 CP-d', trade: '26 Welding', keyEvent: 'Undock',
          risk: 'Bow catapult trough hot work overlaps flight-deck nonskid application in the same zone — combustible coating inside an active hot-work boundary.',
          why: 'WI-4310 catapult trough & cylinder renewal (hot work) runs while WI-6340 nonskid / flight-deck coating is being laid over the bow catapult track. The coating is combustible and cannot be applied or cured within an active hot-work boundary.',
          traces: [{ from: 'WI-4310 Catapult trough renewal (hot work)', to: 'WI-6340 Nonskid / flight-deck coating', rule: 'HW-03 · No combustible coating within an active hot-work boundary' }],
          wis: [{ id: 'WI-4310', name: 'Catapult trough & cylinder renewal', s: 6, e: 11, color: '#dc2626' }, { id: 'WI-6340', name: 'Nonskid / flight-deck coating', s: 9, e: 13, color: '#f59e0b' }],
          mit: 'Sequence nonskid application after catapult hot work completes and the boundary is released.' },
      ],
      cvn71: [
        { id: 'SR-0221', deck: '2nd', frame: 130, side: 'cl', lvl: 0, comp: '2-130-0-L', name: 'Berthing (hot-work boundary)', cls: 'Hot-work deconfliction', sev: 'High', onCP: true, cp: 'ON CP', trade: '26 Welding', keyEvent: 'Move-Aboard',
          risk: 'Hot work runs against an occupied berthing boundary in the move-aboard window.',
          why: 'Hot-work boundary overlaps berthing prep ahead of crew move-aboard.',
          traces: [{ from: 'WI-7110 Hot work', to: 'WI-7180 Berthing prep', rule: 'HW-03 · Hot-work boundary' }],
          wis: [{ id: 'WI-7110', name: 'Hot work', s: 3, e: 6, color: '#dc2626' }, { id: 'WI-7180', name: 'Berthing prep', s: 5, e: 8, color: '#f59e0b' }],
          mit: 'Deconflict the hot-work window.' },
        { id: 'SR-0210', deck: '3rd', frame: 160, side: 'port', lvl: 1, comp: '3-160-2-Q', name: 'Pump Room', cls: 'Access / staging', sev: 'Med', onCP: false, cp: '—', trade: '31 Inside Machinists', keyEvent: 'Move-Aboard',
          risk: 'Staging blocks the access route for an adjacent job.',
          why: 'Two jobs share a single access route in overlapping weeks.',
          traces: [{ from: 'WI-7240 Pump overhaul', to: 'WI-7255 Valve work', rule: 'ACC-02 · Shared access route' }],
          wis: [{ id: 'WI-7240', name: 'Pump overhaul', s: 6, e: 10, color: '#3D6BFF' }, { id: 'WI-7255', name: 'Valve work', s: 9, e: 12, color: '#f59e0b' }],
          mit: 'Stagger access windows.' },
        { id: 'SR-0215', deck: '4th', frame: 140, side: 'port', lvl: 2, comp: '4-140-4-Q', name: 'Vent Space', cls: 'Material timing', sev: 'Low', onCP: false, cp: '—', trade: '71 Preservation', keyEvent: 'Sea Trials',
          risk: 'Material delivery lags install readiness.',
          why: 'Install material is not on dock until after the predecessor completes.',
          traces: [{ from: 'WI-7310 Vent mod', to: 'WI-7325 Insulation', rule: 'MAT-05 · Material on dock before install' }],
          wis: [{ id: 'WI-7310', name: 'Vent mod', s: 10, e: 14, color: '#3D6BFF' }, { id: 'WI-7325', name: 'Insulation', s: 13, e: 16, color: '#f59e0b' }],
          mit: 'Align material delivery.' },
      ],
      cvn75: [],
    };
    const deConflicts = deByCtx[contextId] || [];

    const deAmbientByDeck = {
      '4th': [
        { comp: '4-088-1-A', frame: 88, side: 'stbd', lvl: 1, s: 2, e: 9 },
        { comp: '4-160-0-Q', frame: 160, side: 'cl', lvl: 0, s: 6, e: 12 },
        { comp: '4-175-1-L', frame: 175, side: 'stbd', lvl: 1, s: 9, e: 16 },
        { comp: '4-072-3-Q', frame: 72, side: 'stbd', lvl: 1, s: 4, e: 8 },
      ],
      'main': [
        { comp: '01-110-0-W', frame: 110, side: 'cl', lvl: 0, s: 3, e: 11 },
        { comp: '01-170-2-L', frame: 170, side: 'port', lvl: 1, s: 7, e: 14 },
      ],
      '3rd': [
        { comp: '3-120-1-Q', frame: 120, side: 'stbd', lvl: 1, s: 5, e: 12 },
        { comp: '3-210-0-L', frame: 210, side: 'cl', lvl: 0, s: 8, e: 15 },
      ],
    };

    // deck counts (exclude ghosts)
    const deCounts = {};
    deConflicts.forEach((c) => { if (!c.ghost) deCounts[c.deck] = (deCounts[c.deck] || 0) + 1; });

    const deActiveDeck = deDeck;
    const deDeckObj = deDecksDef.find((d) => d.id === deActiveDeck) || deDecksDef[7];
    const deHasImg = !!deDeckObj.img;
    const deShowDrawing = deMode === 'drawing' && deHasImg;
    const deImg = deDeckObj.img || '';

    const decks = deDecksDef.map((d) => ({
      id: d.id, label: d.label, sub: d.sub,
      count: deCounts[d.id] || 0,
      hasCount: (deCounts[d.id] || 0) > 0,
      countColor: (deCounts[d.id] || 0) > 0 ? '#f2f3f6' : '#6e7480',
      countBg: (deCounts[d.id] || 0) > 0 ? '#0b0c0e' : 'transparent',
      hasDrawing: !!d.img,
      sel: d.id === deActiveDeck,
      rowBg: d.id === deActiveDeck ? '#20222b' : 'transparent',
      accent: d.id === deActiveDeck ? '#3D6BFF' : 'transparent',
      labelColor: d.id === deActiveDeck ? '#f2f3f6' : '#aab0bd',
      onClick: () => this.setState({ deDeck: d.id, deSel: null, deReady: false }),
    }));

    // filter helpers
    const passes = (c) => (deFSev === 'all' || c.sev === deFSev) && (deFClass === 'all' || c.cls === deFClass) && (deFTrade === 'all' || c.trade === deFTrade) && (deFEvent === 'all' || c.keyEvent === deFEvent);

    // overlays for current deck
    const deOverlays = deConflicts.filter((c) => c.deck === deActiveDeck && passes(c)).map((c, i) => {
      const color = colorOf(c);
      const xf = frX(c.frame), yf = sideY(c.side, c.lvl);
      const activeWis = c.wis.filter((w) => deWeek >= w.s && deWeek <= w.e).length;
      const flare = activeWis >= 2;
      const active = activeWis === 1;
      const isSel = deSel === c.id && !c.ghost;
      const anim = flare ? ((color === '#dc2626' ? 'deflare' : 'deflareA') + ' 1.3s ease-in-out infinite') : 'none';
      const dotBg = (flare || active) ? color : '#0b0c0e';
      return {
        key: c.id + '-' + i + (c.ghost ? '-g' : ''),
        leftPct: (xf * 100).toFixed(3) + '%',
        topPct: (yf * 100).toFixed(3) + '%',
        leftPx: Math.round(dePanX + xf * deNatW * deScale) + 'px',
        topPx: Math.round(dePanY + yf * deNatH * deScale) + 'px',
        color, id: c.id, ghost: !!c.ghost,
        dotBg, ringColor: color, boxAnim: anim,
        pinBg: color, pinText: color === '#dc2626' ? '#fff' : '#0b0c0e',
        labelOpacity: c.ghost ? 0.7 : 1,
        ringScale: isSel ? '0 0 0 3px rgba(242,243,246,0.9), 0 0 14px ' + color : '0 0 8px ' + color + '88',
        showX: c.special === 'breach',
        hasBadge: !!c.prop,
        badgeArrow: c.prop ? (c.prop.dir === 'up' ? '\u25B2' : '\u25BC') : '',
        onBadge: c.prop ? (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.setState({ deDeck: c.prop.target, deReady: false }); } : null,
        onClick: () => this.setState({ deSel: c.id }),
      };
    });

    // ambient fills for current deck at this week
    const deAmbient = (deAmbientByDeck[deActiveDeck] || []).map((a, i) => {
      const on = deWeek >= a.s && deWeek <= a.e;
      return {
        key: 'amb-' + i,
        leftPct: (frX(a.frame) * 100).toFixed(2) + '%',
        topPct: (sideY(a.side, a.lvl) * 100).toFixed(2) + '%',
        bg: on ? 'rgba(61,107,255,0.16)' : 'transparent',
        border: on ? '1px solid rgba(61,107,255,0.4)' : '1px solid #2b2d3655',
      };
    });

    // scrubber stats
    let deActiveWICount = 0, deFlareCount = 0;
    deConflicts.filter((c) => c.deck === deActiveDeck && passes(c) && !c.ghost).forEach((c) => {
      const aw = c.wis.filter((w) => deWeek >= w.s && deWeek <= w.e).length;
      deActiveWICount += aw;
      if (aw >= 2) deFlareCount++;
    });
    (deAmbientByDeck[deActiveDeck] || []).forEach((a) => { if (deWeek >= a.s && deWeek <= a.e) deActiveWICount++; });

    // ===== ALTITUDE / LENS / READINESS (zone model) =====
    const zm = this._zoneModel();
    const personaAlt = {
      'Executive': 'ship', 'Program Office': 'ship', 'Project Super': 'ship',
      'Zone Manager': 'zone', 'Production Super': 'zone',
      'Planner': 'compartment', 'IPT': 'compartment', 'Material Manager': 'compartment',
    };
    const effAlt = deAlt || personaAlt[persona] || 'zone';
    const altDefs = [['ship', 'Ship', 'Leadership board'], ['zone', 'Zone', 'Section · superintendent'], ['compartment', 'Compartment', 'Foreman · deck plan']];
    const altSeg = altDefs.map(([id, label, sub]) => ({ key: id, id, label, sub, active: effAlt === id, color: effAlt === id ? '#0b0c0e' : '#ccd1da', bg: effAlt === id ? '#3D6BFF' : 'transparent', onClick: () => this.setState({ deAlt: id }) }));
    const lensDefs = [['space', 'By space', 'Show me my zone'], ['trade', 'By trade', 'Where can my crews work']];
    const lensSeg = lensDefs.map(([id, label, sub]) => ({ key: id, id, label, sub, active: deLens === id, color: deLens === id ? '#f2f3f6' : '#94a3b8', bg: deLens === id ? '#2b2d36' : 'transparent', onClick: () => this.setState({ deLens: id, deTradeSel: null }) }));
    const isTradeLens = deLens === 'trade';

    const compTone = (c, st) => {
      if (st.key === 'doable') return '#22c55e';
      if (st.key === 'idle') return '#353842';
      if (c.readiness === 'offlimits' || c.onCP) return '#dc2626';
      return '#f59e0b';
    };
    const hexA2 = (hex, a) => { const n = hex.replace('#', ''); return 'rgba(' + parseInt(n.slice(0, 2), 16) + ',' + parseInt(n.slice(2, 4), 16) + ',' + parseInt(n.slice(4, 6), 16) + ',' + a + ')'; };
    const compLive = zm.comps.map((c) => { const st = this._compStatus(c, deWeek); return { c, st, tone: compTone(c, st) }; });
    const liveById = {}; compLive.forEach((x) => liveById[x.c.id] = x);

    // ---- zone rollups (space lens) ----
    const zoneRollup = zm.zones.map((z) => {
      const cl = compLive.filter((x) => x.c.zone === z.id);
      const active = cl.filter((x) => x.st.active);
      const doable = active.filter((x) => x.st.key === 'doable').length;
      const blocked = active.filter((x) => x.st.key === 'blocked');
      const blockedCP = blocked.filter((x) => x.c.onCP || x.c.readiness === 'offlimits').length;
      const svcCount = {}; blocked.forEach((x) => { if (x.st.svc) svcCount[x.st.svc] = (svcCount[x.st.svc] || 0) + 1; });
      let topSvc = null, topN = 0; Object.keys(svcCount).forEach((k) => { if (svcCount[k] > topN) { topN = svcCount[k]; topSvc = k; } });
      const inc = zm.incursions.filter((i) => i.into === z.id && deWeek >= i.wk[0] && deWeek <= i.wk[1]);
      const worst = blockedCP > 0 ? 'red' : (blocked.length > 0 ? 'amber' : (doable > 0 ? 'green' : 'idle'));
      return { z, cl, total: cl.length, active: active.length, doable, blocked: blocked.length, blockedCP, topSvc, topN, inc, worst };
    });
    const rollById = {}; zoneRollup.forEach((r) => rollById[r.z.id] = r);
    const worstColor = { red: '#dc2626', amber: '#f59e0b', green: '#22c55e', idle: '#6e7480' };
    const worstBg = { red: 'rgba(220,38,38,0.10)', amber: 'rgba(245,158,11,0.09)', green: 'rgba(34,197,94,0.08)', idle: '#121316' };

    // ---- trade rollups (trade lens) ----
    const tradeRollup = zm.trades.map((t) => {
      const cl = compLive.filter((x) => x.c.lead === t.id);
      const active = cl.filter((x) => x.st.active);
      const doable = active.filter((x) => x.st.key === 'doable');
      const blocked = active.filter((x) => x.st.key === 'blocked');
      const zA = {}; doable.forEach((x) => zA[x.c.zone] = true);
      const zB = {}; blocked.forEach((x) => zB[x.c.zone] = true);
      return { t, active: active.length, doable: doable.length, blocked: blocked.length, zonesAble: Object.keys(zA), zonesBlocked: Object.keys(zB) };
    });

    // ---- ship-wide "doable today" tallies ----
    const shipActive = compLive.filter((x) => x.st.active);
    const shipDoable = shipActive.filter((x) => x.st.key === 'doable').length;
    const shipBlocked = shipActive.filter((x) => x.st.key === 'blocked');
    const shipBlockedCP = shipBlocked.filter((x) => x.c.onCP || x.c.readiness === 'offlimits').length;
    const shipIncur = zm.incursions.filter((i) => deWeek >= i.wk[0] && deWeek <= i.wk[1]).length;

    // ---- SERVICE DISPATCH QUEUE (finite service capacity as the constraint) ----
    // every pending required service on an active, enterable compartment is live demand
    const pendingReqs = [];
    compLive.forEach((x) => {
      if (!x.st.active || x.c.readiness === 'offlimits') return;
      x.c.req.forEach((r) => {
        if (deWeek < r.clearWk) {
          const otherPending = x.c.req.filter((rr) => rr !== r && deWeek < rr.clearWk).length;
          pendingReqs.push({ svc: r.id, comp: x.c, cpDays: x.c.cpDays, mh: x.c.mh, crew: x.c.crew, onCP: x.c.onCP, lead: x.c.lead, fullyUnlocks: otherPending === 0, ageWk: Math.max(1, deWeek - x.c.s + 1), hard: r.clearWk > 26 });
        }
      });
    });
    const reqValue = (r) => (r.fullyUnlocks ? 1e6 : 0) + r.cpDays * 1000 + r.mh;
    const svcQueue = zm.services.map((sv) => {
      const reqs = pendingReqs.filter((p) => p.svc === sv.id).sort((a, b) => reqValue(b) - reqValue(a));
      reqs.forEach((r, i) => { r.dispatch = i < sv.cap; });
      const disp = reqs.filter((r) => r.dispatch);
      const cpUnlock = disp.filter((r) => r.fullyUnlocks).reduce((a, r) => a + r.cpDays, 0);
      const mhUnlock = disp.filter((r) => r.fullyUnlocks).reduce((a, r) => a + r.mh, 0);
      return {
        key: sv.id, id: sv.id, name: sv.name, owner: sv.owner, color: sv.color, cap: sv.cap,
        total: reqs.length, dispatched: disp.length, queued: reqs.length - disp.length, cpUnlock, mhUnlock,
        rows: reqs.map((r) => ({
          key: r.comp.id + r.svc, comp: r.comp.id, zone: r.comp.zone, zoneName: (zm.zones.find((z) => z.id === r.comp.zone) || {}).name,
          trade: zm.tradeById[r.lead].name, tradeColor: zm.tradeById[r.lead].color, crew: r.crew, mh: r.mh, cpDays: r.cpDays,
          onCP: r.onCP, fully: r.fullyUnlocks, age: 'W' + Math.max(1, r.comp.s), hard: r.hard,
          dispatch: r.dispatch, tagColor: r.dispatch ? '#22c55e' : '#6e7480', tagLabel: r.dispatch ? 'DISPATCH' : 'QUEUE',
          tagBg: r.dispatch ? 'rgba(34,197,94,0.13)' : 'rgba(148,163,184,0.10)',
          onClick: () => this.setState({ deAlt: 'zone', deZoneSel: r.comp.zone, deZoneComp: r.comp.id }),
        })),
      };
    });
    // recovery ledger: a compartment recovers this week if ALL its pending services get dispatched
    const byComp = {}; pendingReqs.forEach((p) => { (byComp[p.comp.id] = byComp[p.comp.id] || []).push(p); });
    const recoverComps = [];
    Object.keys(byComp).forEach((cid) => { const ps = byComp[cid]; if (ps.length && ps.every((p) => p.dispatch)) recoverComps.push(ps[0].comp); });
    const cpRecoverable = recoverComps.reduce((a, c) => a + c.cpDays, 0);
    const mhRecoverable = recoverComps.reduce((a, c) => a + c.mh, 0);
    const idleMh = shipBlocked.reduce((a, x) => a + x.c.mh, 0);
    const idleCrews = shipBlocked.reduce((a, x) => a + x.c.crew, 0);
    const svcActionRail = { cpRecoverable, mhRecoverable, idleMh, idleCrews, recoverN: recoverComps.length };

    const shipIncurN = shipIncur;

    // director rail (ship altitude)
    const dirSeg = [{ id: 'all', name: 'All directors', title: 'Whole ship', role: '' }].concat(zm.directors).map((d) => {
      const zones = d.id === 'all' ? zoneRollup : zoneRollup.filter((r) => r.z.dir === d.id);
      const blk = zones.reduce((a, r) => a + r.blocked, 0), doa = zones.reduce((a, r) => a + r.doable, 0);
      return { key: d.id, id: d.id, name: d.name, title: d.title, role: d.role, sel: deDir === d.id, blk, doa,
        rowBg: deDir === d.id ? '#20222b' : 'transparent', accent: deDir === d.id ? '#3D6BFF' : 'transparent',
        onClick: () => this.setState({ deDir: d.id }) };
    });

    // ship board cards
    const svcName = (id) => id ? zm.svcById[id].name : '';
    const shipZoneCards = zoneRollup.filter((r) => deDir === 'all' || r.z.dir === deDir).map((r) => {
      const dir = zm.directors.find((d) => d.id === r.z.dir);
      return {
        key: r.z.id, id: r.z.id, name: r.z.name, supt: r.z.supt, dirRole: dir ? dir.role : '',
        frames: 'Fr ' + r.z.fr[0] + '–' + r.z.fr[1], band: r.z.band[0].toUpperCase() + '→' + r.z.band[1].toUpperCase(),
        tone: worstColor[r.worst], cardBg: worstBg[r.worst], barColor: worstColor[r.worst],
        doable: r.doable, blocked: r.blocked, blockedCP: r.blockedCP, active: r.active,
        hasBlk: r.blocked > 0, hasCP: r.blockedCP > 0,
        blkPct: r.active ? Math.round(r.blocked / r.active * 100) : 0,
        doaPct: r.active ? (r.doable / r.active * 100).toFixed(0) + '%' : '0%',
        topBlk: r.topSvc ? (r.topN + '× ' + svcName(r.topSvc)) : (r.blocked ? 'off-limits / sequence' : 'none'),
        hasInc: r.inc.length > 0, incN: r.inc.length,
        leadDots: r.z.leads.map((lid) => ({ key: lid, color: zm.tradeById[lid].color })),
        onClick: () => this.setState({ deAlt: 'zone', deZoneSel: r.z.id, deZoneComp: null }),
      };
    });
    const shipTradeCards = tradeRollup.map((tr) => ({
      key: tr.t.id, id: tr.t.id, name: tr.t.name, code: tr.t.code, color: tr.t.color,
      doable: tr.doable, blocked: tr.blocked, active: tr.active,
      ableList: tr.zonesAble.map((z) => zm.zones.find((zz) => zz.id === z).name).join(', ') || '— none active —',
      blkList: tr.zonesBlocked.map((z) => zm.zones.find((zz) => zz.id === z).name).join(', ') || 'none',
      hasBlk: tr.blocked > 0,
      barDoa: tr.active ? (tr.doable / tr.active * 100) : 0,
      onClick: () => this.setState({ deLens: 'trade', deTradeSel: tr.t.id }),
      sel: deTradeSel === tr.t.id,
    }));

    // ---- ZONE ALTITUDE: matrix for the selected zone ----
    const effZone = deZoneSel || (persona === 'Zone Manager' ? 'Z4' : (persona === 'Production Super' ? 'Z3' : 'Z4'));
    const zObj = zm.zones.find((z) => z.id === effZone) || zm.zones[0];
    const zDir = zm.directors.find((d) => d.id === zObj.dir);
    const zTi = zm.wdIdx[zObj.band[0]], zBi = zm.wdIdx[zObj.band[1]];
    const zDeckRows = zm.workDecks.slice(zTi, zBi + 1);
    const zFrames = []; for (let f = zObj.fr[0] + 9; f < zObj.fr[1] - 2; f += 16) zFrames.push(f);
    const zComps = compLive.filter((x) => x.c.zone === effZone);
    const zRoll = rollById[effZone];
    // ---- DEPLOY TODAY (muster list) for the zone ----
    const svcOwnerById = {}; zm.services.forEach((sv) => svcOwnerById[sv.id] = sv);
    const zGoList = zComps.filter((x) => x.st.key === 'doable').sort((a, b) => (b.c.cpDays - a.c.cpDays) || (b.c.mh - a.c.mh)).map((x) => ({
      key: x.c.id, comp: x.c.id, use: zm.useName[x.c.use] || 'Compartment', deck: x.c.deckLabel,
      trade: zm.tradeById[x.c.lead].name, tradeColor: zm.tradeById[x.c.lead].color, crew: x.c.crew, mh: x.c.mh,
      onCP: x.c.onCP, cpDays: x.c.cpDays,
      onClick: () => this.setState({ deZoneComp: x.c.id }),
    }));
    const zHoldList = zComps.filter((x) => x.st.key === 'blocked').sort((a, b) => (b.c.cpDays - a.c.cpDays) || (b.c.mh - a.c.mh)).map((x) => {
      const c = x.c; const pend = c.req.filter((r) => deWeek < r.clearWk);
      const offlimits = c.readiness === 'offlimits';
      const first = pend[0];
      return { key: c.id, comp: c.id, use: zm.useName[c.use] || 'Compartment', deck: c.deckLabel,
        trade: zm.tradeById[c.lead].name, tradeColor: zm.tradeById[c.lead].color, crew: c.crew, mh: c.mh, onCP: c.onCP,
        blocker: offlimits ? 'Space not released — off-limits' : (svcOwnerById[first.id].name),
        owner: offlimits ? 'Zone / Safety' : svcOwnerById[first.id].owner,
        clears: offlimits ? 'on release' : (first.clearWk > 26 ? 'not scheduled' : 'W' + first.clearWk),
        tone: (offlimits || c.onCP) ? '#dc2626' : '#f59e0b',
        onClick: () => this.setState({ deZoneComp: c.id }),
      };
    });
    const zMuster = {
      goN: zGoList.length, goCrews: zGoList.reduce((a, g) => a + g.crew, 0), goMh: zGoList.reduce((a, g) => a + g.mh, 0),
      holdN: zHoldList.length, holdCrews: zHoldList.reduce((a, h) => a + h.crew, 0), holdMh: zHoldList.reduce((a, h) => a + h.mh, 0),
    };
    const zReadFill = { open: 'rgba(34,197,94,0.10)', offlimits: 'rgba(220,38,38,0.14)' };
    const zMatrix = zDeckRows.map((dk) => ({
      key: dk.id, deckLabel: dk.label, deckN: dk.n,
      cells: zFrames.map((f) => {
        const x = zComps.find((cc) => cc.c.deckN === dk.n && cc.c.frame === f);
        if (!x) return { key: dk.n + '-' + f, has: false, empty: true };
        const c = x.c, st = x.st;
        const tradeColor = zm.tradeById[c.lead].color;
        let fill, border, dot;
        if (isTradeLens) {
          const dim = deTradeSel && deTradeSel !== c.lead;
          fill = dim ? '#0f1013' : hexA2(tradeColor, 0.16);
          border = dim ? '#1a1b20' : hexA2(tradeColor, 0.55);
          dot = st.key === 'doable' ? '#22c55e' : (st.key === 'blocked' ? x.tone : '#353842');
        } else if (deReadiness) {
          fill = st.active ? hexA2(x.tone, 0.16) : '#0f1013';
          border = st.active ? hexA2(x.tone, 0.6) : '#1a1b20';
          dot = tradeColor;
        } else {
          fill = '#121316'; border = '#2b2d36'; dot = tradeColor;
        }
        const sel = deZoneComp === c.id;
        const off = c.readiness === 'offlimits';
        const word = !st.active ? '' : (off ? 'OFF' : (st.key === 'doable' ? 'GO' : 'WAIT'));
        const wordColor = off ? '#f87171' : (st.key === 'doable' ? '#4ade80' : '#fbbf24');
        const pend = c.req.filter((r) => deWeek < r.clearWk);
        const tip = c.id + ' · ' + (zm.useName[c.use] || 'Compartment') + ' — ' +
          (!st.active ? 'no work scheduled this week'
            : off ? 'OFF-LIMITS: do not enter'
            : st.key === 'doable' ? 'GO: crews can work here today'
            : 'WAIT: ' + (pend[0] ? zm.svcById[pend[0].id].name + ' needed first (clears W' + pend[0].clearWk + ')' : 'blocked'));
        return {
          key: c.id, has: true, empty: false, comp: c.id, use: zm.useName[c.use] || 'Compartment',
          fill, border, dot, tone: x.tone, statusKey: st.key, active: st.active,
          word, hasWord: !!word, wordColor, tip,
          ring: sel ? '0 0 0 2px #f2f3f6, 0 0 12px rgba(242,243,246,0.4)' : 'none',
          onCP: c.onCP, offlimits: off,
          shortId: c.id,
          onClick: () => this.setState({ deZoneComp: c.id }),
        };
      }),
    }));
    // incursion markers for the zone (at its boundary frames)
    const zIncursions = zm.incursions.filter((i) => i.into === effZone).map((i) => {
      const on = deWeek >= i.wk[0] && deWeek <= i.wk[1];
      return { key: i.id, id: i.id, from: i.from, fromName: (zm.zones.find((z) => z.id === i.from) || {}).name, frame: 'Fr ' + i.frame, what: i.what, wi: i.wi, sev: i.sev, on,
        tone: i.sev === 'High' ? '#dc2626' : '#f59e0b', bg: on ? (i.sev === 'High' ? 'rgba(220,38,38,0.10)' : 'rgba(245,158,11,0.09)') : '#121316', op: on ? 1 : 0.5 };
    });
    // zone selector rail
    const zoneRail = zm.zones.map((z) => {
      const r = rollById[z.id];
      return { key: z.id, id: z.id, name: z.name, supt: z.supt, frames: 'Fr ' + z.fr[0] + '–' + z.fr[1],
        sel: z.id === effZone, dot: worstColor[r.worst], blocked: r.blocked, hasBlk: r.blocked > 0,
        rowBg: z.id === effZone ? '#20222b' : 'transparent', accent: z.id === effZone ? '#3D6BFF' : 'transparent',
        labelColor: z.id === effZone ? '#f2f3f6' : '#aab0bd',
        onClick: () => this.setState({ deZoneSel: z.id, deZoneComp: null }) };
    });
    // compartment inspector (zone altitude)
    const zSelLive = deZoneComp ? liveById[deZoneComp] : null;
    let zInspect = null;
    if (zSelLive) {
      const c = zSelLive.c, st = zSelLive.st;
      const tr = zm.tradeById[c.lead];
      const iPend = c.req.filter((r) => deWeek < r.clearWk).sort((a2, b2) => a2.clearWk - b2.clearWk);
      const iOff = c.readiness === 'offlimits';
      const nextStep = !st.active ? 'Nothing to do here this week. Work is scheduled W' + c.s + '–W' + c.e + '.'
        : iOff ? 'Do NOT send anyone in. Space is off-limits until it is released. Check with the zone superintendent.'
        : st.key === 'doable' ? 'Send the crew. All clearances are done — this space is ready to work right now.'
        : (iPend[0] ? (iPend[0].clearWk > 26
            ? zm.svcById[iPend[0].id].name + ' is needed but has NO scheduled date. Raise it at morning ops — until then, keep the crew out.'
            : 'Wait for ' + zm.svcById[iPend[0].id].name + ' — expected to clear in W' + iPend[0].clearWk + '. Put the crew on a GO space until then.')
          : 'Blocked — check with the zone superintendent before sending anyone.');
      zInspect = {
        comp: c.id, use: zm.useName[c.use] || 'Compartment', frame: 'Fr ' + c.frame, deck: c.deckLabel + ' deck',
        trade: tr.code + ' ' + tr.name, tradeColor: tr.color,
        statusKey: st.key, statusLabel: st.key === 'doable' ? 'GO — READY TO WORK' : (st.key === 'blocked' ? (iOff ? 'OFF-LIMITS' : 'WAIT — BLOCKED') : 'NO WORK THIS WEEK'),
        nextStep,
        tone: zSelLive.tone, reason: st.reason || 'No scheduled direct work in W' + deWeek + '.',
        window: 'W' + c.s + ' → W' + c.e, active: st.active, onCP: c.onCP, offlimits: c.readiness === 'offlimits',
        readLabel: c.readiness === 'offlimits' ? 'Off-limits' : 'Cleared to enter',
        services: c.req.map((r) => { const cleared = deWeek >= r.clearWk; return { key: r.id, name: zm.svcById[r.id].name, cleared, hard: r.clearWk > 26,
          statusText: cleared ? 'Cleared' : (r.clearWk > 26 ? 'Not scheduled' : 'Pending → W' + r.clearWk),
          tone: cleared ? '#22c55e' : (r.clearWk > 26 ? '#dc2626' : '#f59e0b') }; }),
        noSvc: c.req.length === 0,
        onDeck: () => this.setState({ deAlt: 'compartment', deDeck: c.deck, deView: 'single', deReady: false, deSel: null }),
        onClose: () => this.setState({ deZoneComp: null }),
        wadl: (() => {
          const wHot = c.lead === 'weld' || c.lead === 'fit';
          const wCoat = c.lead === 'pres' && st.active;
          const desig = iOff ? 'Not Safe for Workers' : (wCoat ? 'Not Safe for Hot Work' : (wHot && st.active && st.key === 'doable' ? 'Safe for Hot Work' : 'Safe for Workers'));
          const tone = iOff ? '#dc2626' : (wCoat ? '#f59e0b' : (desig === 'Safe for Hot Work' ? '#22c55e' : '#94a3b8'));
          return { desig, tone,
            certTone: iOff ? '#dc2626' : '#22c55e',
            certLabel: iOff ? 'Invalidated — space secured; event recorded, re-test on release' : 'MC-118 valid · issued 06:05 · retest 12 h · R. Whitfield (MC-0071)',
            certSet: c.id + ' + atmospheric neighbors (1 hop)',
            act: !st.active ? 'none' : (wCoat ? '1 coating ticket ACTIVE — hot work in the cert set is blocked (R3)' : (wHot ? (st.key === 'doable' ? '1 hot-work permit ACTIVE · fire watch posted' : '1 hot-work permit SUSPENDED — see reason above') : '1 work ticket ACTIVE')) };
        })(),
      };
    }
    const zSummary = { doable: zRoll.doable, blocked: zRoll.blocked, blockedCP: zRoll.blockedCP, active: zRoll.active, idle: zRoll.total - zRoll.active };

    // ===== SATURATION (L4 density) + EARNED-VALUE VARIANCE + RECOVERY HORIZONS =====
    const satUseCap = { W: 5, M: 5, Q: 10, E: 9, L: 14, C: 11 };
    const satTradeCap = { fit: 24, weld: 20, mach: 22, elec: 18, pres: 22 };
    const satTone = (p) => p === 0 ? { bg: '#0f1013', tx: 'transparent' } : p > 110 ? { bg: 'rgba(220,38,38,0.30)', tx: '#f87171' } : p >= 85 ? { bg: 'rgba(245,158,11,0.22)', tx: '#fbbf24' } : { bg: 'rgba(34,197,94,0.15)', tx: '#4ade80' };
    const satWeeks = []; for (let sw = 1; sw <= 26; sw++) satWeeks.push(sw);
    const satSel = this.state.satSel;
    const satRows = zm.zones.map((z) => ({
      key: z.id, id: z.id, name: z.name,
      cells: satWeeks.map((w) => {
        const act = zm.comps.filter((c) => c.zone === z.id && w >= c.s && w <= c.e);
        const crews = act.reduce((a, c) => a + c.crew, 0);
        const cap = act.reduce((a, c) => a + (satUseCap[c.use] || 8), 0);
        const pct = cap ? Math.round(crews / cap * 100) : 0;
        const t = satTone(pct);
        const sel = satSel && satSel.z === z.id && satSel.w === w;
        return { key: z.id + '-' + w, pct, has: pct > 0, label: pct > 0 ? pct : '', bg: t.bg, tx: t.tx,
          ring: sel ? 'inset 0 0 0 2px #f2f3f6' : 'none',
          onClick: () => this.setState({ satSel: { z: z.id, w } }) };
      }),
    }));
    // workforce caps scaled to the synthetic crew totals (shop headcount, bodies/week)
    const satShopCap = { fit: 120, weld: 95, mach: 110, elec: 90, pres: 105 };
    const satCapTotal = Object.keys(satShopCap).reduce((a, k) => a + satShopCap[k], 0);
    const satWork = satWeeks.map((w) => {
      const act = zm.comps.filter((c) => w >= c.s && w <= c.e);
      const byTrade = {}; let total = 0;
      act.forEach((c) => { byTrade[c.lead] = (byTrade[c.lead] || 0) + c.crew; total += c.crew; });
      const over = Object.keys(byTrade).filter((t) => byTrade[t] > satShopCap[t]);
      const pct = Math.round(total / satCapTotal * 100);
      const t = satTone(pct);
      return { key: 'sw' + w, label: 'W' + w, pct, bg: t.bg, tx: t.tx, hasOver: over.length > 0,
        overList: over.length ? ('Over cap: ' + over.map((tid) => zm.tradeById[tid].name + ' ' + byTrade[tid] + '/' + satShopCap[tid]).join(' · ')) : 'All shops within headcount' };
    });
    let satDetail = null;
    if (satSel) {
      const sz = zm.zones.find((zz) => zz.id === satSel.z);
      const act = zm.comps.filter((c) => c.zone === satSel.z && satSel.w >= c.s && satSel.w <= c.e);
      const crews = act.reduce((a, c) => a + c.crew, 0);
      const cap = act.reduce((a, c) => a + (satUseCap[c.use] || 8), 0);
      const rows = act.map((c) => { const cc = satUseCap[c.use] || 8; const ratio = c.crew / cc;
        return { key: c.id, comp: c.id, use: zm.useName[c.use] || 'Compartment', crew: c.crew, cap: cc, ratio,
          over: c.crew > cc, overN: c.crew - cc,
          barW: Math.min(100, Math.round(ratio * 100)) + '%',
          tone: c.crew > cc ? '#dc2626' : (ratio >= 0.85 ? '#f59e0b' : '#22c55e') }; })
        .sort((a, b) => b.ratio - a.ratio);
      satDetail = { zone: sz.id, name: sz.name, supt: sz.supt, week: 'W' + satSel.w, crews, cap,
        pct: cap ? Math.round(crews / cap * 100) : 0,
        overBodies: rows.reduce((a, r) => a + Math.max(0, r.overN), 0), rows,
        onClose: () => this.setState({ satSel: null }) };
    }
    // earned-value variance from weekly status (planned-to-date vs earned, at deWeek)
    const evWk = (s2) => { const m = /W(\d+)/.exec(s2 || ''); return m ? parseInt(m[1], 10) : null; };
    const evAll = this.woSeed().map((w) => {
      const s2 = evWk(w.start), f2 = evWk(w.finish);
      if (s2 == null || f2 == null || w.status === 'Complete' || w.status === 'Planned' || w.status === 'On-Hold' || deWeek < s2) return null;
      const expPct = Math.min(1, (deWeek - s2 + 1) / (f2 - s2 + 1));
      const planned = Math.round(w.estMH * expPct);
      const earned = Math.round(w.estMH * w.pct / 100);
      return { w, planned, earned, varMH: earned - planned, expPct: Math.round(expPct * 100) };
    }).filter((e) => !!e);
    const evVarById = {}; evAll.forEach((e) => evVarById[e.w.id] = e.varMH);
    const evBehind = evAll.filter((e) => e.varMH < -30).sort((a, b) => a.varMH - b.varMH);
    const evShortfall = evBehind.reduce((a, e) => a + e.varMH, 0);
    // recovery horizons (Mitigation Studio)
    const msActive = activeModule === 'mitigationStudio';
    const msDonorZones = satRows.map((r) => ({ id: r.id, cell: r.cells[deWeek - 1] })).filter((x) => x.cell.pct > 0 && x.cell.pct < 70).map((x) => x.id);
    const msDonorTxt = msDonorZones.length ? msDonorZones.join(', ') : 'none — every zone is busy; overtime is the only quick fix';
    const msBuckets = { short: [], mid: [], long: [] };
    evBehind.forEach((e) => {
      const isShort = e.w.onCP || e.varMH <= -120;
      const isLong = !isShort && (e.w.crit === 'Low' || e.w.growth);
      const k = isShort ? 'short' : (isLong ? 'long' : 'mid');
      const crews = Math.max(1, Math.ceil(-e.varMH / 40));
      const action = k === 'short'
        ? (msDonorZones.length
          ? 'Move ' + crews + ' crew(s) over from ' + msDonorTxt + ' (they have room) and add Saturday overtime — catches up ~' + (-e.varMH) + ' hrs this week'
          : 'No zone has spare people this week — approve Saturday overtime (' + crews + ' crew(s)) to catch up ~' + (-e.varMH) + ' hrs')
        : k === 'mid'
          ? 'Do other ' + e.w.zone + ' work first and move this job\u2019s support services (gas-free cert, scaffolding) up the line — catches up ' + (-e.varMH) + ' hrs over ~4 weeks'
          : 'This job can\u2019t catch up in place — move it to a later window or the next maintenance period (' + (-e.varMH) + ' hrs of work). Needs sign-off above the deckplate';
      msBuckets[k].push({ key: e.w.id, id: e.w.id, title: e.w.title, comp: e.w.comps[0], zone: e.w.zone,
        trade: e.w.trade.replace('Shop ', ''), varLabel: e.varMH + ' MH', pct: e.w.pct + '%', exp: e.expPct + '%', onCP: e.w.onCP, action,
        onEvidence: () => this.setState({ activeModule: 'sequenceBoard', sbView: 'sat', satSel: { z: e.w.zone, w: deWeek } }),
        onRoute: () => { this.logDecision({ kind: 'CATCH-UP', title: e.w.id + ' — catch-up plan sent to the planning team', why: e.w.title + ' is ' + (-e.varMH) + ' hrs behind (' + e.w.pct + '% done; should be ' + e.expPct + '% by now). Suggested fix: ' + action + '. The master schedule stays as-is until the planning team agrees.', tone: '#f59e0b' }); this.setState({ msToast: e.w.id + ' catch-up plan sent — decision logged with the reason why.' }); } });
    });
    const msCols = [
      { key: 'short', label: 'This week', sub: 'Move people to it now', tone: '#dc2626', rows: msBuckets.short },
      { key: 'mid', label: 'This month', sub: 'Change the order of work', tone: '#f59e0b', rows: msBuckets.mid },
      { key: 'long', label: 'Longer term', sub: 'Change the plan itself', tone: '#7E9CFF', rows: msBuckets.long },
    ].map((c2) => ({ ...c2, n: c2.rows.length, mh: c2.rows.reduce((a, r) => a + Math.abs(parseInt(r.varLabel, 10)), 0), hasRows: c2.rows.length > 0, noRows: c2.rows.length === 0 }));

    // ===== DAILY OPS (B1) — today's shift plan =====
    const doZone = this.state.doZone || 'all';
    const goDEZone = (zid, cid) => this.setState({ activeModule: 'deckExplorer', deAlt: 'zone', deZoneSel: zid, deZoneComp: cid || null });
    const doMkGo = (x) => ({ key: x.c.id, comp: x.c.id, use: zm.useName[x.c.use] || 'Compartment', deck: x.c.deckLabel, trade: zm.tradeById[x.c.lead].name, tradeColor: zm.tradeById[x.c.lead].color, crew: x.c.crew, mh: x.c.mh, onCP: x.c.onCP, onClick: () => goDEZone(x.c.zone, x.c.id) });
    const doMkHold = (x) => { const c = x.c; const pend = c.req.filter((r) => deWeek < r.clearWk); const off = c.readiness === 'offlimits'; const first = pend[0];
      return { key: c.id, comp: c.id, crew: c.crew, onCP: c.onCP, tone: (off || c.onCP) ? '#dc2626' : '#f59e0b',
        blocker: off ? 'Not released — off-limits' : svcOwnerById[first.id].name,
        owner: off ? 'Zone / Safety' : svcOwnerById[first.id].owner,
        clears: off ? 'on release' : (first.clearWk > 26 ? 'NOT SCHED' : 'W' + first.clearWk),
        ageN: Math.max(1, deWeek - c.s + 1),
        ageLabel: 'held ' + Math.max(1, deWeek - c.s + 1) + 'w',
        ageTone: (deWeek - c.s + 1) >= 3 ? '#dc2626' : ((deWeek - c.s + 1) === 2 ? '#f59e0b' : '#6e7480'),
        onClick: () => goDEZone(c.zone, c.id) }; };
    const doZoneBoards = zoneRollup.filter((r) => doZone === 'all' || r.z.id === doZone).map((r) => {
      const cl = compLive.filter((x) => x.c.zone === r.z.id && x.st.active);
      const goAll = cl.filter((x) => x.st.key === 'doable').sort((a, b) => (b.c.cpDays - a.c.cpDays) || (b.c.mh - a.c.mh));
      const holdAll = cl.filter((x) => x.st.key === 'blocked').sort((a, b) => ((b.c.onCP ? 1 : 0) - (a.c.onCP ? 1 : 0)) || (b.c.mh - a.c.mh));
      return { key: r.z.id, id: r.z.id, name: r.z.name, supt: r.z.supt, frames: 'Fr ' + r.z.fr[0] + '\u2013' + r.z.fr[1],
        tone: worstColor[r.worst], goN: goAll.length, holdN: holdAll.length,
        goCrews: goAll.reduce((a, x) => a + x.c.crew, 0), holdCrews: holdAll.reduce((a, x) => a + x.c.crew, 0),
        hasCrew: (goAll.length + holdAll.length) > 0,
        goPctW: (goAll.length + holdAll.length) ? Math.round(goAll.reduce((a, x) => a + x.c.crew, 0) / Math.max(1, goAll.reduce((a, x) => a + x.c.crew, 0) + holdAll.reduce((a, x) => a + x.c.crew, 0)) * 100) + '%' : '0%',
        go: goAll.slice(0, 4).map(doMkGo), goMore: goAll.length - 4, hasGoMore: goAll.length > 4,
        hold: holdAll.slice(0, 3).map(doMkHold), holdMore: holdAll.length - 3, hasHoldMore: holdAll.length > 3,
        hasGo: goAll.length > 0, noGo: goAll.length === 0, hasHold: holdAll.length > 0, noHold: holdAll.length === 0,
        onOpen: () => goDEZone(r.z.id, null) };
    });
    const doGoCrews = shipActive.filter((x) => x.st.key === 'doable').reduce((a, x) => a + x.c.crew, 0);
    const doDispatchN = svcQueue.reduce((a, s) => a + s.dispatched, 0);
    const doQueuedN = svcQueue.reduce((a, s) => a + s.queued, 0);
    const doKpi = { go: shipDoable, goCrews: doGoCrews, holdCrews: idleCrews, idleMh: idleMh.toLocaleString(), cpRec: cpRecoverable, disp: doDispatchN };
    const doAlerts = [];
    if (shipBlockedCP) doAlerts.push({ tone: '#dc2626', tag: 'CRITICAL PATH', text: shipBlockedCP + ' blocked compartments sit on the critical path \u2014 every idle day here slips a key event', action: 'Open ship board', onClick: () => this.setState({ activeModule: 'deckExplorer', deAlt: 'ship' }) });
    const doHardN = compLive.filter((x) => x.st.active && x.c.readiness !== 'offlimits' && x.c.req.some((rr) => deWeek < rr.clearWk && rr.clearWk > 26)).length;
    if (doHardN) doAlerts.push({ tone: '#dc2626', tag: 'NO CLEAR DATE', text: doHardN + ' blockers have no scheduled service date \u2014 escalate to the service departments at morning ops', action: 'Open ship board', onClick: () => this.setState({ activeModule: 'deckExplorer', deAlt: 'ship' }) });
    const doSoonN = compLive.filter((x) => x.st.active && x.st.key === 'blocked' && x.c.req.some((rr) => rr.clearWk === deWeek + 1)).length;
    if (doSoonN) doAlerts.push({ tone: '#7E9CFF', tag: 'PRE-STAGE', text: doSoonN + ' held spaces clear next week (W' + (deWeek + 1) + ') \u2014 pre-stage crews and material now', action: null, onClick: null });
    if (shipIncur) doAlerts.push({ tone: '#f59e0b', tag: 'INCURSION', text: shipIncur + ' cross-zone incursions active this week \u2014 confirm boundary coordination at muster', action: null, onClick: null });
    if (doQueuedN) doAlerts.push({ tone: '#f59e0b', tag: 'CAPACITY', text: doQueuedN + ' service requests exceed today\u2019s team capacity \u2014 cutline is set by CP-days unlocked, not request age', action: null, onClick: null });
    if (evBehind.length) doAlerts.push({ tone: '#f59e0b', tag: 'VARIANCE', text: evBehind.length + ' jobs behind plan (' + evShortfall + ' hrs behind) \u2014 catch-up options ready in Mitigation Studio', action: 'Mitigation Studio', onClick: () => this.setState({ activeModule: 'mitigationStudio' }) });
    const doAlertRows = doAlerts.map((a, i) => ({ key: 'da' + i, tone: a.tone, tag: a.tag, text: a.text, hasAction: !!a.action, action: a.action || '', onClick: a.onClick || (() => {}) }));
    const doSvc = svcQueue.map((sv) => ({ key: sv.id, name: sv.name, color: sv.color, cap: sv.cap, dispatched: sv.dispatched, queued: sv.queued,
      rows: sv.rows.filter((rr) => rr.dispatch).map((rr) => Object.assign({}, rr, { onClick: () => this.setState({ activeModule: 'deckExplorer', deAlt: 'zone', deZoneSel: rr.zone, deZoneComp: rr.comp }) })) }));
    let doMaxMh = 1; doSvc.forEach((sv) => sv.rows.forEach((rr) => { if (rr.mh > doMaxMh) doMaxMh = rr.mh; }));
    doSvc.forEach((sv) => sv.rows.forEach((rr) => { rr.mhW = Math.max(4, Math.round(rr.mh / doMaxMh * 100)) + '%'; }));
    const doZoneSeg = [{ id: 'all', label: 'All zones', dot: null }].concat(zm.zones.map((z) => ({ id: z.id, label: z.id, dot: worstColor[rollById[z.id].worst] }))).map((o) => ({ key: o.id, id: o.id, label: o.label, hasDot: !!o.dot, dot: o.dot || '#6e7480', active: doZone === o.id, color: doZone === o.id ? '#f2f3f6' : '#94a3b8', bg: doZone === o.id ? '#2b2d36' : 'transparent', onClick: () => this.setState({ doZone: o.id }) }));

    // ===== WEEK PLAN (B2) — 7-day zone planning inside the Sequence Board =====
    const { sbView, wpShift, wpZone, wpCommitted } = this.state;
    const sbAvailView = sbView === 'avail', sbWeekView = sbView === 'week', sbSatView = sbView === 'sat';
    const wpDayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const wpDispClear = {}; // comp id -> latest day its dispatched service teams clear
    pendingReqs.forEach((p) => { if (p.dispatch) { const d = 2 + ((p.comp.frame + p.comp.s) % 3); wpDispClear[p.comp.id] = Math.max(wpDispClear[p.comp.id] || 0, d); } });
    const wpTradeCap = { fit: 24, weld: 20, mach: 22, elec: 18, pres: 22 };
    const wpItemsAll = [];
    compLive.forEach((x) => {
      if (!x.st.active) return;
      const c = x.c, h = c.frame * 7 + c.s * 3 + c.crew;
      const dur = 2 + (h % 3);
      const pend = c.req.filter((r) => deWeek < r.clearWk);
      const off = c.readiness === 'offlimits';
      let kind = 'go', earliest = 1, blocker = null, owner = null;
      if (x.st.key === 'blocked') {
        const undisp = pend.filter((p) => !(pendingReqs.find((q) => q.comp.id === c.id && q.svc === p.id) || {}).dispatch);
        if (off || undisp.length) {
          kind = 'park'; const f = pend[0];
          blocker = off ? 'Off-limits — not released' : svcOwnerById[f.id].name + (f.clearWk > 26 ? ' — not scheduled' : ' — clears W' + f.clearWk);
          owner = off ? 'Zone / Safety' : svcOwnerById[f.id].owner;
        } else { kind = 'svc'; earliest = Math.max(1, Math.min((wpDispClear[c.id] || 2) + 1, 8 - dur)); }
      }
      const baseD = kind === 'svc' ? earliest : 1 + (h % (8 - dur));
      const shift = wpShift[c.id] || 0;
      const d1 = Math.max(1, Math.min(8 - dur, baseD + shift));
      wpItemsAll.push({ c, kind, dur, d1, d2: d1 + dur - 1, earliest, blocker, owner });
    });
    const wpPlaced = wpItemsAll.filter((it) => it.kind !== 'park');
    const wpParked = wpItemsAll.filter((it) => it.kind === 'park');
    const wpDayLoad = wpDayNames.map((nm, i) => {
      const day = i + 1; const byTrade = {}; let crews = 0;
      wpPlaced.forEach((it) => { if (day >= it.d1 && day <= it.d2) { crews += it.c.crew; byTrade[it.c.lead] = (byTrade[it.c.lead] || 0) + it.c.crew; } });
      const over = Object.keys(byTrade).filter((t) => byTrade[t] > wpTradeCap[t]);
      return { day, nm, crews, over, byTrade };
    });
    const wpOverDays = {}; wpDayLoad.forEach((d) => { if (d.over.length) wpOverDays[d.day] = d.over; });
    const wpConf = [];
    wpPlaced.forEach((it) => {
      if (it.kind === 'svc' && it.d1 < it.earliest) { it.viol = 'Starts before its service team clears the space — earliest ' + wpDayNames[it.earliest - 1]; wpConf.push({ tone: '#dc2626', text: it.c.id + ' starts before its service clears — slide to ' + wpDayNames[it.earliest - 1] + ' or later' }); }
      if (!it.viol) { for (let day = it.d1; day <= it.d2; day++) { if ((wpOverDays[day] || []).indexOf(it.c.lead) >= 0) { it.warn = true; break; } } }
    });
    wpDayLoad.forEach((d) => d.over.forEach((t) => wpConf.push({ tone: '#f59e0b', text: zm.tradeById[t].name + ' over capacity ' + d.nm + ' (' + d.byTrade[t] + ' > ' + wpTradeCap[t] + ' crews) — slide work off ' + d.nm })));
    const wpWkndN = wpPlaced.filter((it) => it.d2 >= 6).length;
    if (wpWkndN) wpConf.push({ tone: '#7E9CFF', text: wpWkndN + ' items run into Sat / Sun — weekend premium; confirm overtime authorization' });
    const wpZones = zm.zones.filter((z) => wpZone === 'all' || z.id === wpZone).map((z) => {
      const items = wpPlaced.filter((it) => it.c.zone === z.id).sort((a, b) => (a.d1 - b.d1) || (b.c.crew - a.c.crew)).map((it) => {
        const tr = zm.tradeById[it.c.lead]; const isSvc = it.kind === 'svc';
        return { key: it.c.id, comp: it.c.id, use: zm.useName[it.c.use] || 'Compartment', crew: it.c.crew, onCP: it.c.onCP,
          trade: tr.name, tradeColor: tr.color,
          left: ((it.d1 - 1) / 7 * 100).toFixed(2) + '%', width: (it.dur / 7 * 100).toFixed(2) + '%',
          hasViol: !!it.viol, viol: it.viol || '', isSvc, svcNote: isSvc ? ('svc clears ' + wpDayNames[it.earliest - 2 >= 0 ? it.earliest - 2 : 0]) : '',
          barBg: it.viol ? 'rgba(220,38,38,0.14)' : (it.warn ? 'rgba(245,158,11,0.10)' : '#20222b'),
          barBorder: it.viol ? '1.5px solid #dc2626' : (it.warn ? '1px solid #f59e0b' : '1px solid #2b4568'),
          onDown: (e) => this._wpDrag(it.c.id, e) };
      });
      const crews = items.reduce((a, i2) => a + i2.crew, 0);
      return { key: z.id, id: z.id, name: z.name, supt: z.supt, items, n: items.length, crews, hasItems: items.length > 0 };
    }).filter((z) => z.hasItems);
    const wpParkRows = wpParked.map((it) => ({ key: it.c.id, comp: it.c.id, zone: it.c.zone, blocker: it.blocker, owner: it.owner, crew: it.c.crew }));
    const wpConfRows = wpConf.map((c2, i) => ({ key: 'wc' + i, tone: c2.tone, text: c2.text }));
    const wpCrews = wpPlaced.reduce((a, it) => a + it.c.crew, 0);
    const wpMh = wpPlaced.reduce((a, it) => a + it.c.mh * it.dur, 0);
    const wpShiftN = Object.keys(wpShift).filter((k) => wpShift[k]).length;
    const wpViolN = wpConfRows.filter((r) => r.tone === '#dc2626').length;
    const wpDayHdr = wpDayLoad.map((d) => ({ key: 'd' + d.day, nm: d.nm, crews: d.crews, over: d.over.length > 0, overList: d.over.map((t) => zm.tradeById[t].name).join(', '), tone: d.over.length ? '#f59e0b' : '#6e7480', wknd: d.day >= 6 }));
    const wpZoneSeg = [{ id: 'all', label: 'All zones' }].concat(zm.zones.map((z) => ({ id: z.id, label: z.id }))).map((o) => ({ key: o.id, id: o.id, label: o.label, active: wpZone === o.id, color: wpZone === o.id ? '#f2f3f6' : '#94a3b8', bg: wpZone === o.id ? '#2b2d36' : 'transparent', onClick: () => this.setState({ wpZone: o.id }) }));
    // ===== PAINT & HOT WORK (UC-5) — coating state, flammables, auto-adjudicated hot-work permits =====
    const doView = this.state.doView, doShiftView = doView === 'shift', doPaintView = doView === 'paint';
    const pbCoats = zm.comps.filter((c) => c.lead === 'pres' && deWeek >= c.s && deWeek <= c.e + 1).map((c) => {
      const curing = deWeek >= c.e;
      const phasePct = Math.min(100, Math.round((deWeek - c.s + 1) / (c.e - c.s + 2) * 100));
      return { key: c.id, comp: c.id, zone: c.zone, deck: c.deckLabel, frame: 'Fr ' + c.frame,
        use: zm.useName[c.use] || 'Compartment',
        phase: curing ? 'CURING' : 'COATING', phaseColor: curing ? '#f59e0b' : '#22c55e',
        cureEnd: 'W' + (c.e + 1), clock: curing ? ('cure thru W' + (c.e + 1)) : ('final coat W' + c.e),
        barW: phasePct + '%', curing, c };
    }).sort((a, b) => a.zone < b.zone ? -1 : 1);
    const pbFlam = zm.zones.map((z) => {
      const n = pbCoats.filter((p) => p.zone === z.id).length;
      return { key: z.id, zone: z.id, n, staged: n > 0,
        label: n > 0 ? (n + ' evolution(s) · locker OPEN') : 'locker SECURED',
        tone: n > 0 ? '#f59e0b' : '#22c55e' };
    });
    const hwActed = this.state.hwActed;
    const hwCand = zm.comps.filter((c) => (c.lead === 'weld' || c.lead === 'fit') && deWeek >= c.s && deWeek <= c.e).slice(0, 7);
    const hwReqs = hwCand.map((c, i) => {
      const conf = pbCoats.find((p) => p.zone === c.zone);
      const hold = !!conf;
      const zn = parseInt(String(c.zone).replace(/\D/g, '')) || 0;
      const adjConf = !conf ? pbCoats.find((p) => Math.abs((parseInt(String(p.zone).replace(/\D/g, '')) || 0) - zn) === 1) : null;
      const decision = hold ? 'BLOCK' : (adjConf ? 'WARN' : 'ALLOW');
      const rule = hold ? 'R3' : (adjConf ? 'R13' : 'CLEAR');
      const altW = conf ? 'W' + (conf.c.e + 2) : null;
      const acted = hwActed[c.id];
      const req = { key: c.id, id: 'HW-' + String(2200 + i * 7), comp: c.id, zone: c.zone, deck: c.deckLabel, frame: 'Fr ' + c.frame,
        trade: zm.tradeById[c.lead].name, tradeColor: zm.tradeById[c.lead].color,
        task: c.lead === 'weld' ? 'Structural welding / grinding' : 'Fit-up & tack, deck plating',
        from: ['R. Alvarez', 'D. Okafor', 'M. Reyes', 'T. Nguyen', 'J. Whitfield', 'C. Barnes', 'L. Ortiz'][i % 7] + ' · deckplate tablet',
        hold, verdict: decision, rule, vTone: hold ? '#ef4444' : (adjConf ? '#f59e0b' : '#22c55e'),
        reason: hold
          ? 'Active or curing coating in the certification set — ' + conf.comp + ' (' + conf.phase.toLowerCase() + ', clears ' + conf.cureEnd + '). Hard block; no override. Lifts automatically when the coat closes and the air is re-checked.'
          : adjConf
            ? 'Flammables staged for the coating evolution in adjacent ' + adjConf.zone + ' (' + adjConf.comp + '). Permitted with shielding and fire watch — the condition rides on the permit.'
            : 'All create-phase rules clear (designation, certificates, adjacency, fire watch pre-checked). Gas-free certificate bound.',
        alt: altW, acted, notActed: !acted,
        consoleHref: 'WADL Console.dc.html#' + ('HW-' + String(2200 + i * 7)),
        actLabel: hold ? ('Accept ' + altW + ' window') : (adjConf ? 'Issue with shielding condition' : 'Issue permit'),
        actedLabel: acted || '' };
      req.onAct = () => {
        const verdictTxt = hold ? ('re-slotted to ' + altW) : (adjConf ? 'issued with condition' : 'permit issued');
        this.logDecision({ kind: 'HOT WORK', title: req.id + ' ' + c.id + ' — ' + verdictTxt,
          why: hold
            ? 'Authorization layer ' + rule + ' BLOCK: ' + req.reason + ' Accepting the ' + altW + ' window avoids a fire-watch standdown and a ruined coat (~re-blast + 3 shift days). Requester notified on the deckplate with the full rule trace.'
            : adjConf
              ? 'Authorization layer ' + rule + ' WARN: ' + req.reason + ' Shielding condition attached; painter and fire marshal notified.'
              : 'Authorization layer clear: ' + req.reason + ' Permit issued same-day instead of the 24–48h paper routing.', tone: hold ? '#ef4444' : (adjConf ? '#f59e0b' : '#22c55e') });
        this.setState((st) => ({ hwActed: Object.assign({}, st.hwActed, { [c.id]: hold ? ('Re-slotted ' + altW) : (adjConf ? 'Issued w/ condition' : 'Permit issued') }) }));
      };
      return req;
    });
    const hwHoldN = hwReqs.filter((r) => r.hold).length;
    // live feed from the authorization layer (Field App + Console publish; shell consumes)
    const feedTone = (a) => a.indexOf('SUSPENDED') >= 0 ? '#c4b5fd' : (a.indexOf('REFUSED') >= 0 || a.indexOf('REJECTED') >= 0 ? '#ef4444' : (a.indexOf('PENDING') >= 0 || a.indexOf('EXTENSION_REQ') >= 0 ? '#f59e0b' : '#22c55e'));
    const fmtT = (t) => { const d = new Date(t); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); };
    const wadlFeedRows = (this.state.wadlFeed || []).slice(0, 8).map((e, i) => ({
      key: 'wf' + i, time: fmtT(e.t), action: e.action, rule: e.rule || false, detail: e.detail,
      tone: feedTone(e.action), srcLabel: e.src === 'console' ? 'Console' : 'Field',
      href: e.src === 'console' ? 'WADL Console.dc.html' : 'WADL Field App.dc.html' }));
    const wadlFeedEmpty = wadlFeedRows.length === 0;
    const pbStats = { reqs: hwReqs.length, holds: hwHoldN, coats: pbCoats.length,
      lockers: pbFlam.filter((f) => f.staged).length };
    const doViewSeg = [['shift', 'Shift Plan'], ['paint', 'Paint & Hot Work']].map(([id, label]) => ({
      key: id, label, active: doView === id,
      badge: id === 'paint' && hwHoldN ? String(hwHoldN) : '',
      hasBadge: id === 'paint' && hwHoldN > 0,
      bg: doView === id ? '#20222b' : 'transparent', color: doView === id ? '#f2f3f6' : '#94a3b8',
      onClick: () => this.setState({ doView: id }) }));
    const doShift = { planned: wpCommitted ? wpCrews : doGoCrews + idleCrews, mustered: doGoCrews, behind: evBehind.length,
      note: wpCommitted ? 'Planned = crews in the committed week plan.' : 'No committed week plan — planned = all active crews.' };
    const sbViewSeg = [['avail', 'Availability · 26 wk'], ['week', 'Week Plan · W' + deWeek], ['sat', 'Crowding Check']].map(([v, l]) => ({ key: v, val: v, label: l, active: sbView === v, color: sbView === v ? '#0b0c0e' : '#ccd1da', bg: sbView === v ? '#3D6BFF' : 'transparent', onClick: () => this.setState({ sbView: v }) }));

    // altitude gates
    const altShip = effAlt === 'ship', altZone = effAlt === 'zone', altComp = effAlt === 'compartment';
    // ===== CONFIGURATION & HISTORY (PLCM) — as-maintained baseline + availability handoff =====
    const cfgTab = this.state.cfgTab || 'baseline';
    const cfgSel = this.state.cfgSel;
    const cfgCarried = this.state.cfgCarried || {};
    const cfgData = [
      { comp: '1-136-0-Q', name: 'Hangar Bay 2', deck: 'Main', zone: 'Z4', sys: '130 Hull Decks', frame: 'Fr 130–142',
        recs: [
          { item: 'Deck plating insert, Fr 134–138', act: 'Replaced', part: 'HY-80 plate, 3/8 in · heat 4C-88201', dwg: '803-6841120 rev G', wo: 'WI-4471', when: '23 Jul 26', by: 'Shop 26 · M. Reyes', oqe: 'IP-4471-r RT — reject, rework in progress', hash: 'sha256:5e90c7b4…', st: 'open' },
          { item: 'Padeye set (4), hangar overhead', act: 'Installed', part: 'P/N 803-6841-PE4', dwg: '803-6841120 rev G', wo: 'WI-4471', when: '19 Jul 26', by: 'Shop 26 · D. Okoye', oqe: 'IP-4468-c VT — accept, S. Imai (VT-1187)', hash: 'sha256:9f21c0ab…', st: 'verified' },
          { item: 'Non-skid, hangar bay deck', act: 'Renewed', part: 'Coating system CS-3, 2-coat', dwg: 'Spec 6310-140', wo: 'WI-4489', when: '—', by: 'Shop 71', oqe: 'DFT witness point not yet taken', hash: false, st: 'pending' },
        ],
        devs: [{ id: 'LAR 73-26-0412', kind: 'Liaison action request', what: 'Insert plate 3/8 in vs 1/2 in specified — approved for this hull only; re-evaluate at next docking', status: 'Approved', by: 'NAVSEA 05 · 11 Jul 26', carries: true }],
        hist: [
          { when: 'PIA-26 · Jul 26', what: 'Deck insert replaced. RT found cluster porosity → rejected, reworked, re-shot.', tone: 'warn' },
          { when: 'DPIA-22 · Mar 22', what: 'Non-skid renewal (CS-3). Coating age at start of PIA-26: 4 yr 4 mo.', tone: 'idle' },
          { when: 'SRA-19 · Sep 19', what: 'Padeye foundations added for JP-5 handling reconfiguration.', tone: 'idle' },
        ] },
      { comp: '4-102-2-E', name: 'Switchboard Room No. 1', deck: '4th', zone: 'Z2', sys: '322 Power Distribution', frame: 'Fr 98–106',
        recs: [
          { item: 'Switchboard No. 1', act: 'Removed', part: 'Old unit S/N 1988-A2 — to disposal', dwg: '803-3220190 rev C', wo: 'WI-1905', when: '14 Jul 26', by: 'Shop 51 · K. Brandt', oqe: 'Tag-out verified ISO-2241 · re-energization sign-off pending', hash: 'sha256:91c2aa04…', st: 'open' },
          { item: 'Switchboard foundation', act: 'Modified', part: 'Foundation kit F-3110-450', dwg: '803-3110450 rev B', wo: 'WI-1888', when: '02 Jul 26', by: 'Shop 11', oqe: 'Weld VT/MT accept · dimensional check filed', hash: 'sha256:6ad3c8f0…', st: 'verified' },
        ],
        devs: [{ id: 'DFS 73-26-0088', kind: 'Departure from specification', what: 'Foundation bolt pattern shifted 12 mm to clear an existing cableway — permanent, drawing markup submitted', status: 'Approved · drawing update pending', by: 'Code 200 · 05 Jul 26', carries: true }],
        hist: [
          { when: 'PIA-26 · Jul 26', what: 'Switchboard replacement. Cold-work permit suspended once (coupled bus re-energized at 2-88-1-E).', tone: 'warn' },
          { when: 'DPIA-22 · Feb 22', what: 'Breaker overhaul; no configuration change.', tone: 'idle' },
        ] },
      { comp: '4-110-2-W', name: 'Reserve Feed Water Tank', deck: '4th', zone: 'Z2', sys: '110 Shell & Plating', frame: 'Fr 108–114',
        recs: [
          { item: 'Tank interior coating', act: 'Renewed', part: 'PRES-07 system, 3-coat', dwg: 'Spec 5290-114', wo: 'WI-3318', when: '09 Jul 26', by: 'Shop 71', oqe: 'DFT readings filed · holiday test accept', hash: 'sha256:2f77b1ad…', st: 'verified' },
          { item: 'Sounding & vent penetrations (2)', act: 'Modified', part: 'Penetration kit P-5290-22', dwg: '803-5290114 rev D', wo: 'WI-3402', when: '16 Jul 26', by: 'Shop 56', oqe: 'Hydro accept · boundary re-preserved', hash: 'sha256:c4a90e12…', st: 'verified' },
        ],
        devs: [],
        hist: [
          { when: 'PIA-26 · Jul 26', what: 'Full preservation. Coating clock reset — next renewal window FY-32.', tone: 'ok' },
          { when: 'DPIA-22 · Mar 22', what: 'Local touch-up only; deferred full preservation to PIA-26.', tone: 'warn' },
          { when: 'SRA-19 · Aug 19', what: 'Full preservation, PRES-05 system (superseded).', tone: 'idle' },
        ] },
      { comp: '4-141-0-C', name: 'Aft IC & Gyro Room', deck: '4th', zone: 'Z3', sys: '431 Interior Comms', frame: 'Fr 138–146',
        recs: [
          { item: 'Cableway CW-4310-3', act: 'Closed out', part: 'Preserved + closed, 38 of 44 ways used', dwg: '803-4310330 rev F', wo: 'WI-3905', when: '21 Jul 26', by: 'Shop 51', oqe: 'Cableway closure VT accept', hash: 'sha256:70bd41ce…', st: 'verified' },
        ],
        devs: [],
        hist: [
          { when: 'PIA-26 · Jul 26', what: 'Cableway closed with 6 spare ways. Constrains the FY28 combat-system pull (WI-8810) — flagged to DPIA-28.', tone: 'warn' },
          { when: 'DPIA-22 · Apr 22', what: 'Gyro replacement; cableway opened and left open for follow-on scope.', tone: 'idle' },
        ] },
      { comp: '4-149-2-Q', name: 'Forced Draft Blower Room No. 3', deck: '4th', zone: 'Z3', sys: '233 Propulsion Units', frame: 'Fr 146–154',
        recs: [
          { item: 'FD blower isolation valves (2)', act: 'Overhauled', part: 'Valve kit V-2210-8 · seats renewed', dwg: '803-2330512 rev E', wo: 'WI-2210', when: '—', by: 'Shop 38', oqe: 'ITP UT + hydro not yet dispositioned', hash: false, st: 'pending' },
        ],
        devs: [{ id: 'LAR 73-26-0507', kind: 'Liaison action request', what: 'Seat material substitution (obsolete OEM seat) — DMSMS-driven, class-wide interest', status: 'Under review', by: 'NAVSEA 05 · open 8 d', carries: true }],
        hist: [
          { when: 'PIA-26 · Jul 26', what: 'Valve overhaul with substituted seat material — obsolescence case open.', tone: 'warn' },
          { when: 'SRA-24 · Jun 24', what: 'Same valves overhauled; OEM seats still available then.', tone: 'idle' },
        ] },
      { comp: '3-185-0-L', name: 'CPO Living Space', deck: '3rd', zone: 'Z5', sys: '634 Deck Covering', frame: 'Fr 180–190',
        recs: [
          { item: 'Deck covering', act: 'Renewed', part: 'Terrazzo, Spec 6340-300', dwg: 'Spec 6340-300', wo: 'WI-6602', when: '—', by: 'Shop 11', oqe: 'Sequenced after overhead install — not started', hash: false, st: 'pending' },
          { item: 'Overhead joiner & lighting', act: 'Installed', part: 'Joiner panel set JP-6400', dwg: 'Spec 6400-110', wo: 'WI-6610', when: '—', by: 'Shop 11', oqe: 'Not started', hash: false, st: 'pending' },
        ],
        devs: [],
        hist: [{ when: 'PIA-26 · Jul 26', what: 'Habitability refresh scheduled; sequence inverted at plan lock, corrected W5.', tone: 'warn' },
          { when: 'DPIA-22 · Feb 22', what: 'Bunk reconfiguration, 24 → 20 racks.', tone: 'idle' }] },
    ];
    const cfgStMeta = { verified: { label: 'VERIFIED', c: '#4ade80', bg: 'rgba(34,197,94,0.13)' },
      open: { label: 'OQE OPEN', c: '#fbbf24', bg: 'rgba(245,158,11,0.13)' },
      pending: { label: 'NOT CAPTURED', c: '#94a3b8', bg: 'rgba(148,163,184,0.10)' } };
    const cfgAllRecs = cfgData.reduce((a, c) => a.concat(c.recs.map((r) => ({ r, c }))), []);
    const cfgVerN = cfgAllRecs.filter((x) => x.r.st === 'verified').length;
    const cfgDevAll = cfgData.reduce((a, c) => a.concat(c.devs.map((d) => ({ d, c }))), []);
    const cfgKpis = [
      { key: 'k1', label: 'Compartments touched', val: String(cfgData.length), sub: 'this availability', c: '#f2f3f6' },
      { key: 'k2', label: 'Configuration records', val: String(cfgAllRecs.length), sub: 'written on close-out', c: '#f2f3f6' },
      { key: 'k3', label: 'OQE-verified', val: Math.round(cfgVerN / cfgAllRecs.length * 100) + '%', sub: cfgVerN + ' of ' + cfgAllRecs.length + ' records', c: '#22c55e' },
      { key: 'k4', label: 'Open deviations', val: String(cfgDevAll.length), sub: 'carry to the next avail', c: '#f59e0b' },
      { key: 'k5', label: 'Records without a drawing rev', val: '0', sub: 'no configuration gaps', c: '#22c55e' },
    ];
    const cfgRows = cfgData.map((c) => {
      const ver = c.recs.filter((r) => r.st === 'verified').length;
      const sel = c.comp === cfgSel;
      return { key: c.comp, comp: c.comp, name: c.name, deck: c.deck + ' Deck · ' + c.zone, sys: c.sys,
        recN: String(c.recs.length), verLabel: ver + '/' + c.recs.length + ' verified',
        verColor: ver === c.recs.length ? '#4ade80' : '#fbbf24',
        devN: c.devs.length, hasDev: c.devs.length > 0,
        rowBg: sel ? '#20222b' : 'transparent', accent: sel ? '#3D6BFF' : 'transparent',
        nameColor: sel ? '#f2f3f6' : '#ccd1da',
        onClick: () => this.setState({ cfgSel: c.comp, cfgTab: 'baseline' }) };
    });
    const cfgC = cfgData.find((c) => c.comp === cfgSel) || cfgData[0];
    const cfgDetail = {
      comp: cfgC.comp, name: cfgC.name, meta: cfgC.deck + ' Deck · ' + cfgC.zone + ' · ' + cfgC.frame, sys: cfgC.sys,
      recs: cfgC.recs.map((r, i) => Object.assign({ key: 'r' + i, item: r.item, act: r.act, part: r.part, dwg: r.dwg,
        wo: r.wo, when: r.when === '—' ? 'not closed yet' : r.when, by: r.by, oqe: r.oqe, hash: r.hash || false,
        actColor: r.act === 'Removed' ? '#f87171' : (r.act === 'Installed' || r.act === 'Replaced' ? '#7dd3fc' : '#ccd1da') }, cfgStMeta[r.st])),
      devs: cfgC.devs.map((d, i) => ({ key: 'd' + i, id: d.id, kind: d.kind, what: d.what, status: d.status, by: d.by,
        tone: d.status.indexOf('Approved') === 0 ? '#22c55e' : '#f59e0b' })),
      hasDevs: cfgC.devs.length > 0, noDevs: cfgC.devs.length === 0,
      hist: cfgC.hist.map((h, i) => ({ key: 'h' + i, when: h.when, what: h.what,
        dot: h.tone === 'warn' ? '#f59e0b' : (h.tone === 'ok' ? '#22c55e' : '#4a5060'), current: i === 0 })),
    };
    // ---- deferred work / next-availability handoff ----
    const cfgDefer = [
      { id: 'WI-6602', title: 'CPO living space deck covering', comp: '3-185-0-L', why: 'Overhead install (WI-6610) slipped 3 weeks — covering cannot be laid under an open overhead without damage', mh: 640, next: 'DPIA-28 · or SRA-27 window if habitability is prioritized', owner: 'A. Serrano · Compartment Completion', risk: 'low' },
      { id: 'WI-2210', title: 'FD blower valve overhaul — seat substitution', comp: '4-149-2-Q', why: 'Obsolete OEM seat; substitution LAR 73-26-0507 still under review at NAVSEA 05', mh: 310, next: 'Decide before DPIA-28 material call · class-wide DMSMS case', owner: 'K. Doyle · Material', risk: 'high' },
      { id: 'WI-8810', title: 'Combat-system cable pull (FY28)', comp: '4-141-0-C', why: 'Cableway CW-4310-3 closed this availability with 6 spare ways — route must be re-opened or re-planned', mh: 1450, next: 'DPIA-28 — must be in the work package before plan lock', owner: 'L. Park · IPT', risk: 'high' },
      { id: 'WI-4489', title: 'Hangar bay non-skid, aft third', comp: '1-136-0-Q', why: 'Deck insert rework consumed the coating window; DFT witness point not takeable before undock', mh: 220, next: 'Underway-period touch-up, then full renewal at DPIA-28', owner: 'T. Okafor · Zone Mgr', risk: 'med' },
    ];
    const riskMeta = { high: { label: 'HIGH', c: '#f87171', bg: 'rgba(220,38,38,0.13)' }, med: { label: 'MEDIUM', c: '#fbbf24', bg: 'rgba(245,158,11,0.13)' }, low: { label: 'LOW', c: '#94a3b8', bg: 'rgba(148,163,184,0.10)' } };
    const cfgDeferRows = cfgDefer.map((d) => {
      const carried = !!cfgCarried[d.id];
      return Object.assign({ key: d.id, id: d.id, title: d.title, comp: d.comp, why: d.why, mh: d.mh.toLocaleString(),
        next: d.next, owner: d.owner, carried, notCarried: !carried,
        onCarry: () => {
          this.setState((s) => ({ cfgCarried: Object.assign({}, s.cfgCarried, { [d.id]: true }) }));
          this.cfgFlash(d.id + ' carried forward to DPIA-28 with its reason and evidence');
          this.logDecision({ kind: 'CARRY-FORWARD', title: d.id + ' deferred to DPIA-28 — ' + d.title, why: d.why + ' · ' + d.mh + ' MH moves to the next availability. Owner ' + d.owner + '.' });
        } }, riskMeta[d.risk]);
    });
    const cfgCarriedN = cfgDeferRows.filter((r) => r.carried).length;
    const cfgDeferMH = cfgDefer.reduce((a, d) => a + d.mh, 0).toLocaleString();
    // ---- deviation & engineering-change register (cross-compartment) ----
    const cfgKindMeta = { ECP: { c: '#7dd3fc', bg: 'rgba(14,116,144,0.18)' }, LAR: { c: '#fbbf24', bg: 'rgba(245,158,11,0.13)' },
      DFS: { c: '#f87171', bg: 'rgba(220,38,38,0.13)' }, Waiver: { c: '#c4b5fd', bg: 'rgba(124,58,237,0.15)' } };
    const cfgCarryMeta = { permanent: { label: 'PERMANENT — DRAWING UPDATE', c: '#f87171' },
      next: { label: 'CARRIES TO NEXT AVAIL', c: '#fbbf24' }, closed: { label: 'CLOSES WITH THIS AVAIL', c: '#94a3b8' },
      class: { label: 'CLASS-WIDE INTEREST', c: '#7dd3fc' } };
    const cfgDevReg = [
      { id: 'DFS 73-26-0088', kind: 'DFS', comp: '4-102-2-E', sys: '322 Power Distribution', what: 'Switchboard foundation bolt pattern shifted 12 mm to clear an existing cableway', status: 'Approved', age: '22 d', by: 'Code 200', carry: 'permanent', note: 'Drawing 803-3110450 markup submitted — the next planner must work to rev C, not rev B.' },
      { id: 'LAR 73-26-0507', kind: 'LAR', comp: '4-149-2-Q', sys: '233 Propulsion Units', what: 'FD blower valve seat material substitution — OEM seat obsolete', status: 'Under review', age: '8 d', by: 'NAVSEA 05', carry: 'class', note: 'Three hulls run the same valve. Approve once and it becomes the class answer; approve per-hull and you pay for it three times.' },
      { id: 'LAR 73-26-0412', kind: 'LAR', comp: '1-136-0-Q', sys: '130 Hull Decks', what: 'Insert plate 3/8 in vs 1/2 in specified — this hull only', status: 'Approved', age: '16 d', by: 'NAVSEA 05', carry: 'next', note: 're-evaluate at the next docking; the thinner insert changes the deck-load assumption for aircraft spotting.' },
      { id: 'ECP 73-26-0031', kind: 'ECP', comp: '4-141-0-C', sys: '431 Interior Comms', what: 'Cableway CW-4310-3 spare-way allocation reduced 12 → 6 to accept the new IC trunk', status: 'Approved', age: '41 d', by: 'NAVSEA 05', carry: 'permanent', note: 'Directly constrains the FY28 combat-system pull — the reason WI-8810 is on the handoff list.' },
      { id: 'WVR 73-26-0119', kind: 'Waiver', comp: '1-136-0-Q', sys: '130 Hull Decks', what: 'Photographic OQE suppressed in a secured space — requirement waived, waiver recorded', status: 'Recorded', age: '4 d', by: 'EHS / Fire Marshal', carry: 'closed', note: 'Waived is not missing. The waiver is its own record and travels in the sell-off package.' },
    ];
    const cfgDevRegRows = cfgDevReg.map((d) => Object.assign({ key: d.id, id: d.id, kind: d.kind, comp: d.comp, sys: d.sys,
      what: d.what, status: d.status, age: d.age, by: d.by, note: d.note,
      statusColor: d.status === 'Under review' ? '#fbbf24' : '#4ade80',
      carryLabel: cfgCarryMeta[d.carry].label, carryColor: cfgCarryMeta[d.carry].c }, cfgKindMeta[d.kind]));
    const cfgDevOpen = cfgDevReg.filter((d) => d.status === 'Under review').length;
    const cfgDevPerm = cfgDevReg.filter((d) => d.carry === 'permanent').length;

    // ---- class rollup + obsolescence (DMSMS) ----
    const cfgClassRows = [
      { sys: '233 Propulsion Units', item: 'FD blower isolation valves', hulls: [
        { hull: 'CVN-73', avail: 'PIA-26 · in work', state: 'Substituted seat (LAR open)', tone: 'warn' },
        { hull: 'CVN-71', avail: 'SRA-26 · in work', state: 'Same valves due W12 — no decision yet', tone: 'warn' },
        { hull: 'CVN-75', avail: 'DPIA-28 · planning', state: 'In scope, material not yet bought', tone: 'idle' } ],
        learn: 'Same obsolete seat, three hulls, three separate LARs in flight. One class disposition would cover all of them and set the buy quantity.' },
      { sys: '322 Power Distribution', item: 'Switchboard foundations', hulls: [
        { hull: 'CVN-73', avail: 'PIA-26 · in work', state: 'Rev C (DFS applied)', tone: 'ok' },
        { hull: 'CVN-71', avail: 'SRA-24 · complete', state: 'Rev B — behind the current drawing', tone: 'warn' },
        { hull: 'CVN-75', avail: 'DPIA-28 · planning', state: 'Plan still cites rev B', tone: 'warn' } ],
        learn: 'CVN-73\u2019s cableway-clearance fix is not reflected in the CVN-75 package. Catch it at plan lock, not at first fit-up.' },
      { sys: '130 Hull Decks', item: 'Hangar bay non-skid (CS-3)', hulls: [
        { hull: 'CVN-73', avail: 'PIA-26 · in work', state: 'Aft third deferred — 4 yr 4 mo on the clock', tone: 'warn' },
        { hull: 'CVN-71', avail: 'SRA-26 · in work', state: 'Full renewal complete W6', tone: 'ok' },
        { hull: 'CVN-75', avail: 'DPIA-28 · planning', state: 'Renewal at 6 yr per the standard interval', tone: 'idle' } ],
        learn: 'Deferring the aft third puts CVN-73 past the interval that CVN-71 just reset. Track it as condition, not as a missed line item.' },
    ].map((r, i) => ({ key: 'cl' + i, sys: r.sys, item: r.item, learn: r.learn,
      hulls: r.hulls.map((h, j) => ({ key: 'h' + j, hull: h.hull, avail: h.avail, state: h.state,
        tone: h.tone === 'warn' ? '#f59e0b' : (h.tone === 'ok' ? '#22c55e' : '#4a5060'),
        stateColor: h.tone === 'warn' ? '#fbbf24' : (h.tone === 'ok' ? '#86efac' : '#94a3b8') })) }));
    const cfgDmsms = [
      { part: 'Valve seat, FD blower isolation (P/N 2330-512-07)', why: 'OEM ceased production 2024; no qualified drop-in', hulls: 'CVN-73 · CVN-71 · CVN-75', need: 'CVN-71 needs it W12 — 9 weeks out', lead: 'Substitute qualification 14 wk', st: 'Decision required', tone: 'high', action: 'LAR 73-26-0507 → class disposition' },
      { part: 'IC trunk connector shell (P/N 4310-330-19)', why: 'Sole-source supplier, 2 remaining lots', hulls: 'CVN-73 · CVN-75', need: 'DPIA-28 cable pull, FY28', lead: 'Buy-ahead 6 wk', st: 'Buy-ahead recommended', tone: 'med', action: 'Add to the DPIA-28 long-lead list now' },
      { part: 'Non-skid CS-3 binder', why: 'Reformulated to meet a VOC rule; old spec no longer procurable', hulls: 'Class-wide', need: 'Next coating window per hull', lead: 'Spec update in review', st: 'Monitoring', tone: 'low', action: 'Track — no action this availability' },
    ].map((d, i) => Object.assign({ key: 'dm' + i, part: d.part, why: d.why, hulls: d.hulls, need: d.need, lead: d.lead, st: d.st, action: d.action },
      riskMeta[d.tone]));

    // ---- condition & trends (what the availability record teaches about the ship) ----
    const cfgCoat = [
      { comp: '4-110-2-W', name: 'Reserve Feed Water Tank', sys: 'PRES-07 tank interior', age: 0, interval: 8, note: 'Renewed this availability — clock reset 09 Jul 26' },
      { comp: '1-136-0-Q', name: 'Hangar Bay 2 (aft third)', sys: 'CS-3 non-skid', age: 4.4, interval: 6, note: 'Renewal deferred — will be 6.5 yr at the next docking' },
      { comp: '3-185-0-L', name: 'CPO Living Space', sys: 'Deck covering, terrazzo', age: 4.4, interval: 10, note: 'Wear-driven, not corrosion-driven — interval is generous' },
      { comp: '4-141-0-C', name: 'Aft IC & Gyro Room', sys: 'Interior preservation', age: 0.1, interval: 8, note: 'Preserved and cableway closed 21 Jul 26' },
      { comp: '4-149-2-Q', name: 'FD Blower Room No. 3', sys: 'Machinery-space preservation', age: 7.1, interval: 6, note: 'Past interval — deferred twice; corrosion noted at the bilge margin' },
      { comp: '4-102-2-E', name: 'Switchboard Room No. 1', sys: 'Interior preservation', age: 5.4, interval: 8, note: 'Within interval; re-check at DPIA-28' },
    ].map((c, i) => {
      const pct = Math.min(100, Math.round(c.age / c.interval * 100));
      const over = c.age > c.interval, due = !over && c.age / c.interval >= 0.85;
      return { key: 'co' + i, comp: c.comp, name: c.name, sys: c.sys, note: c.note,
        ageLabel: c.age === 0 ? 'new' : c.age.toFixed(1) + ' yr', intervalLabel: 'of ' + c.interval + ' yr',
        w: pct + '%', bar: over ? '#dc2626' : (due ? '#f59e0b' : '#22c55e'),
        tag: over ? 'PAST INTERVAL' : (due ? 'DUE SOON' : 'IN INTERVAL'),
        tagC: over ? '#f87171' : (due ? '#fbbf24' : '#4ade80'),
        tagBg: over ? 'rgba(220,38,38,0.13)' : (due ? 'rgba(245,158,11,0.13)' : 'rgba(34,197,94,0.13)') };
    });
    const cfgRework = [
      { who: 'Shop 26 · Welders', rate: 6.2, n: '11 rejects of 178 hold points', delta: '+1.8 pts vs SRA-24', dir: 'up', note: 'Concentrated in overhead groove welds on the hangar deck insert — same crew, same joint type.' },
      { who: 'Shop 11 · Shipfitters', rate: 2.1, n: '3 of 141', delta: '−0.6 pts vs SRA-24', dir: 'down', note: 'Dimensional rejects only; no weld-quality findings.' },
      { who: 'Shop 71 · Preservation', rate: 4.8, n: '6 of 125', delta: '+0.4 pts vs SRA-24', dir: 'up', note: 'DFT shortfalls in tight-radius areas — a surface-prep problem, not an applicator problem.' },
      { who: 'Shop 51 · Electricians', rate: 1.4, n: '2 of 143', delta: 'flat', dir: 'flat', note: 'Stable across the last three availabilities.' },
    ].map((r, i) => ({ key: 'rw' + i, who: r.who, rate: r.rate.toFixed(1) + '%', n: r.n, delta: r.delta, note: r.note,
      w: Math.round(r.rate / 8 * 100) + '%',
      bar: r.rate >= 5 ? '#dc2626' : (r.rate >= 3 ? '#f59e0b' : '#22c55e'),
      arrow: r.dir === 'up' ? '▲' : (r.dir === 'down' ? '▼' : '■'),
      arrowC: r.dir === 'up' ? '#f87171' : (r.dir === 'down' ? '#4ade80' : '#6e7480') }));
    const cfgNdt = [['Feb', 2.4], ['Mar', 3.0], ['Apr', 2.8], ['May', 4.1], ['Jun', 5.2], ['Jul', 6.2]]
      .map(([m, v], i) => ({ key: 'nd' + i, m, label: v.toFixed(1) + '%', h: Math.round(v / 7 * 100) + '%',
        c: v >= 5 ? '#dc2626' : (v >= 3.5 ? '#f59e0b' : '#3D6BFF') }));
    const cfgRecs = [
      { key: 'rc1', tone: '#dc2626', tag: 'INTERVAL', t: '4-149-2-Q is 1.1 yr past its preservation interval and has been deferred twice. Condition — not the calendar — should drive it into the DPIA-28 package.' },
      { key: 'rc2', tone: '#f59e0b', tag: 'QUALITY', t: 'The RT reject rate has climbed 2.4 → 6.2% over six months, concentrated in overhead groove welds. That is a procedure or a fatigue signal, not bad luck; sample the next 20 points before undock.' },
      { key: 'rc3', tone: '#22c55e', tag: 'INTERVAL', t: '4-110-2-W held its coating for 7 years on the old PRES-05 system. The 6-year default interval is conservative for this tank — recommend 8 with a mid-cycle inspection.' },
    ];

    // ---- inbound scope: the receiving end of a handoff ----
    const cfgSeedInbound = [
      { id: 'WI-3318', title: 'Reserve feed water tank preservation', from: 'DPIA-22 · deferred (touch-up only)', comp: '4-110-2-W', mh: 980, st: 'closed', note: 'Arrived with its condition history: touch-up in 22 bought four years, not eight. Full preservation done and closed 09 Jul 26.' },
      { id: 'WI-2255', title: 'Blower room lagging install', from: 'SRA-24 · deferred (access conflict)', comp: '4-149-2-Q', mh: 260, st: 'inwork', note: 'Same access conflict recurred — the handoff record is why it was sequenced around the valve overhaul this time.' },
    ].map((d, i) => ({ key: 'si' + i, id: d.id, title: d.title, from: d.from, comp: d.comp, mh: d.mh.toLocaleString(), note: d.note,
      stLabel: d.st === 'closed' ? 'RECEIVED · CLOSED THIS AVAIL' : 'RECEIVED · IN WORK',
      stC: d.st === 'closed' ? '#4ade80' : '#7dd3fc',
      stBg: d.st === 'closed' ? 'rgba(34,197,94,0.13)' : 'rgba(14,116,144,0.18)' }));
    const cfgAccepted = this.state.cfgAccepted || {};
    const cfgPending = cfgDefer.map((d) => {
      const carried = !!cfgCarried[d.id], accepted = !!cfgAccepted[d.id];
      return { key: 'pi' + d.id, id: d.id, title: d.title, comp: d.comp, why: d.why, mh: d.mh.toLocaleString(),
        owner: d.owner, next: d.next,
        waiting: !carried, ready: carried && !accepted, accepted,
        stLabel: accepted ? 'IN THE DPIA-28 WORK PACKAGE' : (carried ? 'READY TO ACCEPT — HANDED OFF' : 'AWAITING HANDOFF FROM CVN-73 PIA-26'),
        stC: accepted ? '#4ade80' : (carried ? '#fbbf24' : '#6e7480'),
        stBg: accepted ? 'rgba(34,197,94,0.13)' : (carried ? 'rgba(245,158,11,0.13)' : 'rgba(148,163,184,0.10)'),
        onAccept: () => {
          this.setState((s) => ({ cfgAccepted: Object.assign({}, s.cfgAccepted, { [d.id]: true }) }));
          this.cfgFlash(d.id + ' accepted into the DPIA-28 work package — ' + d.mh + ' MH added to planning');
          this.logDecision({ kind: 'SCOPE ACCEPTED', title: d.id + ' accepted into DPIA-28 — ' + d.title, why: 'Handed off from CVN-73 PIA-26 with its reason, evidence and ' + d.mh + ' MH. Planning owner ' + d.owner + '.' });
        } };
    });
    const cfgAcceptedMH = cfgDefer.filter((d) => cfgAccepted[d.id]).reduce((a, d) => a + d.mh, 0);
    const cfgOnCvn75 = contextId === 'cvn75';
    const cfgInboundHdr = cfgOnCvn75
      ? 'CVN-75 DPIA-28 · planning — what this availability inherits before its package is written'
      : 'CVN-73 PIA-26 · what this availability inherited, and what CVN-75 DPIA-28 is waiting on from it';
    const cfgGoCvn75 = () => this.setState({ contextId: 'cvn75', cfgTab: 'inbound' });

    const cfgTabs = [['baseline', 'As-maintained baseline'], ['history', 'Compartment history'], ['condition', 'Condition & trends'], ['deviations', 'Deviations & changes'], ['class', 'Class & obsolescence'], ['handoff', 'Availability handoff'], ['inbound', 'Inbound scope']].map(([id, label]) => ({
      key: id, label, active: cfgTab === id, color: cfgTab === id ? '#f2f3f6' : '#94a3b8',
      bb: cfgTab === id ? '#f59e0b' : 'transparent', onClick: () => this.setState({ cfgTab: id }) }));

    // readiness legend rows
    const readinessLegend = [
      { key: 'd', sw: '#22c55e', label: 'GO — ready to work now' },
      { key: 'a', sw: '#f59e0b', label: 'WAIT — needs a service first' },
      { key: 'r', sw: '#dc2626', label: 'STOP — off-limits or holding up a key date' },
      { key: 'i', sw: '#353842', label: 'No scheduled work this week' },
    ];
    const tradeLegend = zm.trades.map((t) => ({ key: t.id, sw: t.color, label: t.code + ' ' + t.name }));

    // ===== VERTICAL TRACE =====
    const deSingle = deView === 'single';
    const deVertical = deView === 'vertical';
    const stateStyle = {
      'gas-free': { fill: 'rgba(34,197,94,0.16)', border: 'rgba(34,197,94,0.5)', label: 'Gas-free' },
      'released': { fill: 'rgba(61,107,255,0.14)', border: 'rgba(61,107,255,0.5)', label: 'Released' },
      'tag-out': { fill: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.6)', label: 'Tag-out' },
      'curing': { fill: 'repeating-linear-gradient(45deg, rgba(34,197,94,0.34) 0 3px, rgba(34,197,94,0.07) 3px 7px)', border: '#22c55e', label: 'Preservation curing' },
      'hotwork': { fill: 'rgba(220,38,38,0.26)', border: '#dc2626', label: 'Hot work' },
    };
    const deSpacesByDeck = {
      '3rd': [
        { comp: '3-132-2-L', name: 'CPO Berthing (overhead preservation)', frame: 132, side: 'port', lvl: 1, state: 'curing', selId: 'SR-0151' },
        { comp: '3-160-0-L', name: 'Crew Berthing', frame: 160, side: 'cl', lvl: 0, state: 'gas-free' },
        { comp: '3-095-1-Q', name: 'Auxiliary Machinery Room', frame: 95, side: 'stbd', lvl: 1, state: 'tag-out' },
      ],
      '4th': [
        { comp: '4-132-0-Q', name: 'Machinery Space', frame: 132, side: 'cl', lvl: 0, state: 'hotwork', selId: 'SR-0151' },
        { comp: '4-110-2-W', name: 'Reserve Feed Water Tank', frame: 110, side: 'port', lvl: 1, state: 'tag-out' },
        { comp: '4-160-0-Q', name: 'Pump Room', frame: 160, side: 'cl', lvl: 0, state: 'gas-free' },
      ],
      'main': [
        { comp: '01-136-0-Q', name: 'Uptake Space No. 2', frame: 136, side: 'cl', lvl: 0, state: 'hotwork' },
        { comp: '01-120-0-W', name: 'Potable Water Tank', frame: 120, side: 'cl', lvl: 0, state: 'released' },
      ],
      '1stplat': [
        { comp: '1-150-0-F', name: 'JP-5 Pump Room', frame: 150, side: 'cl', lvl: 0, state: 'gas-free' },
      ],
    };
    const deVConnDefs = [
      { id: 'SR-0151', frame: 132, upperDeck: '3rd', upperComp: '3-132-2-L', upperSide: 'port', upperLvl: 1, lowerDeck: '4th', lowerComp: '4-132-0-Q', lowerSide: 'cl', lowerLvl: 0, label: 'Hot work below curing preservation — boundary conflict' },
    ];

    // ---- compartment identification + hover detail ----
    const useNames = { A: 'Stowage', C: 'Control / comms', E: 'Machinery (engineering)', F: 'Fuel / oil stowage', G: 'Gasoline', J: 'JP-5', K: 'Chemicals', L: 'Living space', M: 'Magazine', Q: 'Misc / machinery', T: 'Trunk / access', V: 'Void', W: 'Water / tank' };
    const decodeComp = (comp) => {
      const parts = String(comp).split('-');
      const pos = parts[2] != null ? parseInt(parts[2], 10) : 0;
      const u = (parts[3] || '').toUpperCase();
      return { frame: parts[1], sideText: pos === 0 ? 'Centerline' : (pos % 2 === 1 ? 'Starboard' : 'Port'), use: u, useText: useNames[u] || 'Compartment' };
    };
    const stateMeaning = {
      'gas-free': { title: 'Gas-free', tone: '#22c55e', what: 'Atmosphere tested safe \u2014 open for entry and cold work.' },
      'released': { title: 'Released', tone: '#3D6BFF', what: 'Turned over to production \u2014 work is authorized to start.' },
      'tag-out': { title: 'Tag-out', tone: '#f59e0b', what: 'System isolated and tagged out \u2014 do not operate; energy hazard is controlled.' },
      'curing': { title: 'Preservation curing', tone: '#22c55e', what: 'Fresh coating curing \u2014 no hot work or foot traffic inside the boundary until cured.' },
      'hotwork': { title: 'Hot work active', tone: '#dc2626', what: 'Open flame / welding underway \u2014 fire watch set; no combustibles or adjacent-space entry.' },
    };
    const hexA = (hex, a) => { const n = hex.replace('#', ''); const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16); return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'; };
    const mkHover = (o) => {
      const dec = decodeComp(o.comp);
      const sm = o.state ? stateMeaning[o.state] : null;
      const linkId = o.confId || o.selId || null;
      const lc = linkId ? deConflicts.find((c) => c.id === linkId && !c.ghost) : null;
      const wis = lc ? lc.wis.map((w) => { const on = deWeek >= w.s && deWeek <= w.e; return { key: w.id, id: w.id, name: w.name, on, dotColor: on ? w.color : '#424656', idColor: on ? '#ccd1da' : '#6e7480', range: 'W' + w.s + '\u2013W' + w.e }; }) : [];
      return {
        xFrac: frX(o.frame),
        comp: o.comp, name: o.name || dec.useText,
        deckText: (o.deckLabel || '') + ' deck', frameText: 'Fr ' + o.frame, sideText: dec.sideText, useText: dec.useText,
        hasState: !!sm, stateTitle: sm ? sm.title : '', stateTone: sm ? sm.tone : '#6e7480', stateBg: sm ? hexA(sm.tone, 0.14) : 'transparent', stateWhat: sm ? sm.what : '',
        hasWis: wis.length > 0, wis, weekLabel: 'W' + deWeek,
        hasConflict: !!lc, confId: lc ? lc.id : '', confCls: lc ? lc.cls : '', confColor: lc ? colorOf(lc) : '#dc2626', noConflict: !lc,
        accent: lc ? colorOf(lc) : (sm ? sm.tone : '#424656'),
      };
    };

    const fi = deDecksDef.findIndex((d) => d.id === deDeck);
    const laneOrder = [fi - 1, fi, fi + 1];
    let H_FOCUS, H_SIDE, GAP, TOP;
    if (deFull) {
      // fill the entire fixed-overlay viewport: minus slim controls bar + scrubber
      const avail = Math.max(360, deFullVH - 54 /*controls*/ - 92 /*scrubber*/);
      GAP = 34; TOP = 18;
      const usable = avail - TOP * 2 - GAP * 2;
      H_FOCUS = Math.round(usable * 0.40);
      H_SIDE = Math.round(usable * 0.30);
    } else {
      H_FOCUS = 162; H_SIDE = 112; GAP = 46; TOP = 14;
    }
    const laneHeights = [H_SIDE, H_FOCUS, H_SIDE];
    const laneTops = [TOP, TOP + H_SIDE + GAP, TOP + H_SIDE + GAP + H_FOCUS + GAP];
    const roleNames = ['above', 'focus', 'below'];
    const vLanes = laneOrder.map((di, k) => {
      const d = (di >= 0 && di < deDecksDef.length) ? deDecksDef[di] : null;
      const laneH = laneHeights[k], laneTop = laneTops[k], focus = k === 1;
      if (!d) return { empty: true, notEmpty: false, key: 'lane-e' + k, role: roleNames[k], laneH: laneH + 'px', laneTop: laneTop + 'px', focus, label: roleNames[k] === 'above' ? '— TOP OF STACK —' : '— BOTTOM OF STACK —', sub: roleNames[k], labelColor: '#6e7480' };
      const xOf = (fr) => Math.round(vPanX + frX(fr) * 7000 * vScale);
      const spaces = (deSpaceLayer ? (deSpacesByDeck[d.id] || []) : []).map((sp, i) => {
        const ss = stateStyle[sp.state];
        const hv = mkHover({ comp: sp.comp, name: sp.name, frame: sp.frame, state: sp.state, selId: sp.selId, deckLabel: d.label });
        return { key: 'sp' + k + '-' + i, x: xOf(sp.frame) + 'px', y: Math.round(laneTop + sideY(sp.side, sp.lvl) * laneH) + 'px',
          fill: ss.fill, border: ss.border, label: ss.label, comp: sp.comp,
          shortId: sp.comp, labelColor: focus ? '#ccd1da' : '#8198b0',
          ring: sp.selId ? '0 0 0 2px ' + ss.border : 'none',
          onClick: sp.selId ? () => this.setState({ deSel: sp.selId }) : (() => {}),
          onEnter: this._hoverEnter(hv) };
      });
      const pins = deConflicts.filter((c) => c.deck === d.id && passes(c) && !c.ghost).map((c, i) => {
        const color = colorOf(c);
        const aw = c.wis.filter((w) => deWeek >= w.s && deWeek <= w.e).length;
        const hv = mkHover({ comp: c.comp, name: c.name, frame: c.frame, confId: c.id, deckLabel: d.label });
        return { key: 'vp' + k + '-' + i, x: xOf(c.frame) + 'px', y: Math.round(laneTop + sideY(c.side, c.lvl) * laneH) + 'px',
          color, id: c.id, dotBg: aw >= 1 ? color : '#0b0c0e', labelText: focus ? c.id : '',
          anim: aw >= 2 ? ((color === '#dc2626' ? 'deflare' : 'deflareA') + ' 1.3s ease-in-out infinite') : 'none',
          onClick: () => this.setState({ deSel: c.id }), onEnter: this._hoverEnter(hv) };
      });
      return { empty: false, notEmpty: true, key: 'lane-' + d.id, role: roleNames[k], focus,
        label: d.label.toUpperCase() + ' DECK', sub: roleNames[k], img: d.img,
        laneH: laneH + 'px', laneTop: laneTop + 'px', imgOpacity: focus ? 0.55 : 0.3,
        laneBg: focus ? '#060e1e' : '#0a1016', laneBorder: focus ? '#424656' : '#1c1d23',
        labelColor: focus ? '#f2f3f6' : '#94a3b8', imgW: Math.round(7000 * vScale) + 'px', imgTx: 'translate(' + Math.round(vPanX) + 'px,-50%)',
        imgEl: React.createElement('img', { src: d.img, onLoad: this._onVImgLoad, draggable: false, alt: 'deck', style: { position: 'absolute', top: '50%', left: 0, width: Math.round(7000 * vScale) + 'px', height: 'auto', transform: 'translate(' + Math.round(vPanX) + 'px,-50%)', filter: 'invert(1) brightness(1.04) contrast(1.05)', opacity: focus ? 0.55 : 0.3, pointerEvents: 'none', userSelect: 'none' } }),
        spaces, pins };
    });
    const laneIdxById = {}; laneOrder.forEach((di, k) => { if (di >= 0 && di < deDecksDef.length) laneIdxById[deDecksDef[di].id] = k; });
    const vConnectors = deVConnDefs.filter((cn) => laneIdxById[cn.upperDeck] != null && laneIdxById[cn.lowerDeck] != null && Math.abs(laneIdxById[cn.upperDeck] - laneIdxById[cn.lowerDeck]) === 1).map((cn) => {
      const ui = laneIdxById[cn.upperDeck], li = laneIdxById[cn.lowerDeck];
      const x = Math.round(vPanX + frX(cn.frame) * 7000 * vScale);
      const uy = laneTops[ui] + sideY(cn.upperSide, cn.upperLvl) * laneHeights[ui];
      const ly = laneTops[li] + sideY(cn.lowerSide, cn.lowerLvl) * laneHeights[li];
      return { key: cn.id, x: x + 'px', top: Math.round(Math.min(uy, ly)) + 'px', height: Math.round(Math.abs(ly - uy)) + 'px', midY: Math.round((uy + ly) / 2) + 'px', label: cn.label, onClick: () => this.setState({ deSel: cn.id }) };
    });
    const vPlumbX = deHoverXFrac != null ? Math.round(vPanX + deHoverXFrac * 7000 * vScale) + 'px' : null;
    const vHasPlumb = deHoverXFrac != null;
    const vStackHeight = (laneTops[2] + laneHeights[2] + 16) + 'px';
    const vRuler = [0, 40, 80, 120, 160, 200, 240, 280].map((f) => ({ key: 'rk' + f, x: Math.round(vPanX + frX(f) * 7000 * vScale) + 'px', label: 'Fr ' + f }));
    const vRibbon = deDecksDef.map((d, i) => ({ key: d.id, label: d.label, inWindow: laneOrder.indexOf(i) >= 0,
      dotBg: i === fi ? '#f59e0b' : (laneOrder.indexOf(i) >= 0 ? '#3D6BFF' : '#2b2d36'),
      txtColor: laneOrder.indexOf(i) >= 0 ? '#f2f3f6' : '#6e7480',
      rowBg: laneOrder.indexOf(i) >= 0 ? '#20222b' : 'transparent',
      onClick: () => this.setState({ deDeck: d.id, deSel: null }) }));

    // hover popover geometry + legend
    let vHover = null;
    if (deHoverComp && deVertical) {
      const cw = deHoverComp.cw || 760, W = 280;
      let left = deHoverComp.cx != null ? deHoverComp.cx : cw / 2;
      left = Math.max(W / 2 + 10, Math.min(cw - W / 2 - 10, left));
      const cy = deHoverComp.cy != null ? deHoverComp.cy : 120;
      const below = cy < 170;
      const top = below ? cy + (deHoverComp.bh || 21) + 12 : cy - 12;
      vHover = Object.assign({}, deHoverComp, { popStyle: 'position:absolute;left:' + left + 'px;top:' + top + 'px;transform:translate(-50%,' + (below ? '0' : '-100%') + ');width:' + W + 'px;z-index:30;pointer-events:none;' });
    }
    const vLegend = [
      { key: 'gf', label: 'Gas-free', sw: 'rgba(34,197,94,0.5)' },
      { key: 'rl', label: 'Released', sw: 'rgba(61,107,255,0.6)' },
      { key: 'to', label: 'Tag-out', sw: 'rgba(245,158,11,0.7)' },
      { key: 'cu', label: 'Curing', sw: '#22c55e' },
      { key: 'hw', label: 'Hot work', sw: '#dc2626' },
    ];

    // selected conflict detail
    const selC = deSel ? deConflicts.find((c) => c.id === deSel && !c.ghost) : null;
    let deDetail = null;
    if (selC) {
      const wkPct = ((deWeek - 0.5) / 26 * 100).toFixed(2) + '%';
      const bars = selC.wis.map((w) => ({
        id: w.id, name: w.name, color: w.color,
        leftPct: ((w.s - 1) / 26 * 100).toFixed(2) + '%',
        widthPct: ((w.e - w.s + 1) / 26 * 100).toFixed(2) + '%',
        range: 'W' + w.s + '\u2013W' + w.e,
      }));
      let ov = null;
      if (selC.wis.length >= 2) {
        const a = selC.wis[0], b = selC.wis[1];
        const os = Math.max(a.s, b.s), oe = Math.min(a.e, b.e);
        if (os <= oe) ov = { leftPct: ((os - 1) / 26 * 100).toFixed(2) + '%', widthPct: ((oe - os + 1) / 26 * 100).toFixed(2) + '%', label: 'W' + os + (oe > os ? '\u2013W' + oe : '') };
      }
      const status = deReview[deSel] || 'Pending review';
      const statusColor = status === 'Pending review' ? '#94a3b8' : (status === 'Routed to IPT' ? '#3D6BFF' : (status === 'Mitigation proposed' ? '#22c55e' : '#f59e0b'));
      deDetail = {
        id: selC.id, cls: selC.cls, sev: selC.sev, color: colorOf(selC), onCP: selC.onCP, cp: selC.cp, cpColor: (selC.cp.charAt(0) === '+' || selC.cp === 'ON CP') ? '#dc2626' : '#94a3b8',
        comp: selC.comp, name: selC.name, frame: 'Fr ' + selC.frame, deckLabel: deDeckObj.label + ' Deck', trade: selC.trade, keyEvent: selC.keyEvent,
        risk: selC.risk, why: selC.why, mit: selC.mit, traces: selC.traces, cross: !!selC.cross,
        bars, hasOverlap: !!ov, overlap: ov, wkPct, weekLabel: 'W' + deWeek,
        status, statusColor,
        hasProp: !!selC.prop, propArrow: selC.prop ? (selC.prop.dir === 'up' ? '\u25B2 deck above' : '\u25BC deck below') : '', propTarget: selC.prop ? selC.prop.target : '',
        onProp: selC.prop ? () => this.setState({ deDeck: selC.prop.target }) : null,
        onFlag: () => this.setState((st) => ({ deReview: Object.assign({}, st.deReview, { [selC.id]: 'Flagged' }) })),
        onPropose: () => this.setState((st) => ({ deReview: Object.assign({}, st.deReview, { [selC.id]: 'Mitigation proposed' }) })),
        onRoute: () => { this.logDecision({ kind: 'COMPARTMENT', title: selC.id + ' routed to IPT', why: 'Compartment flagged from Deck Explorer review — blocked/at-risk state routed with readiness evidence attached. Plan of record unchanged pending IPT concurrence.', tone: '#3D6BFF' }); this.setState((st) => ({ deReview: Object.assign({}, st.deReview, { [selC.id]: 'Routed to IPT' }) })); },
      };
    }

    // filter controls
    const sevSeg = ['all', 'High', 'Med', 'Low'].map((v) => ({ val: v, label: v === 'all' ? 'All' : v, active: deFSev === v, color: deFSev === v ? '#f2f3f6' : '#94a3b8', bg: deFSev === v ? '#2b2d36' : 'transparent', onClick: () => this.setState({ deFSev: v }) }));
    const classOpts = ['all', 'Preservation-boundary rework', 'Hot-work deconfliction', 'Access / staging', 'Missing predecessor', 'Sequence inversion', 'Material timing', 'Cross-availability'].map((v) => ({ val: v, label: v === 'all' ? 'All classes' : v }));
    const tradeOpts = ['all', '71 Preservation', '26 Welding', '51 Electrical', '31 Inside Machinists', '11 Shipfitters'].map((v) => ({ val: v, label: v === 'all' ? 'All trades' : v }));
    const eventOpts = ['all', 'Undock', 'Fast Cruise', 'Sea Trials', 'Move-Aboard', 'Cross'].map((v) => ({ val: v, label: v === 'all' ? 'All key events' : v }));

    const deModeDrawing = deShowDrawing;
    const deModeSchematic = !deShowDrawing;

    // ===================== SEQUENCE BOARD =====================
    const WK = 26;
    const sbPct = (w) => ((w - 1) / WK * 100);
    const typeMeta = {
      preservation: { label: 'preservation', c: '#3D6BFF' }, ripout: { label: 'rip-out', c: '#94a3b8' },
      interference: { label: 'interference', c: '#8499ad' }, lagging: { label: 'lagging', c: '#0091c7' },
      hotwork: { label: 'hot work', c: '#dc2626' }, test: { label: 'test', c: '#22c55e' },
      buttonup: { label: 'button-up', c: '#f59e0b' }, mod: { label: 'mod', c: '#c79a3a' },
    };
    const authMeta = {
      released: { label: 'Released for Production', c: '#22c55e', bg: 'rgba(34,197,94,0.13)' },
      survey: { label: 'Survey Pending', c: '#f59e0b', bg: 'rgba(245,158,11,0.13)' },
      tagout: { label: 'Tag-Out · LOTO', c: '#dc2626', bg: 'rgba(220,38,38,0.13)' },
      notreleased: { label: 'Not Released', c: '#94a3b8', bg: 'rgba(148,163,184,0.10)' },
    };
    const gasMeta = {
      safehot: { label: 'Safe for Hot Work', c: '#22c55e', bg: 'rgba(34,197,94,0.13)' },
      safeworkers: { label: 'Safe for Workers', c: '#f59e0b', bg: 'rgba(245,158,11,0.13)' },
      notsafe: { label: 'Not Safe for Workers', c: '#dc2626', bg: 'rgba(220,38,38,0.13)' },
      gasfreeing: { label: 'Gas-Freeing in Progress', c: '#3D6BFF', bg: 'rgba(61,107,255,0.13)' },
    };
    const adjMeta = {
      clear: { c: '#191a1f', label: 'Clear' }, active: { c: 'rgba(61,107,255,0.55)', label: 'Active work' },
      hot: { c: 'rgba(220,38,38,0.6)', label: 'Hot-work restricted' }, curing: { c: 'rgba(34,197,94,0.55)', label: 'Preservation curing' },
      tagout: { c: 'rgba(245,158,11,0.55)', label: 'Tag-out' },
    };
    const zoneNames = { '4C': 'Zone 4-Charlie · Main Machinery Aft', '4B': 'Zone 4-Bravo · Forward Auxiliary', '3C': 'Zone 3-Charlie · Berthing & Living', 'MN': 'Zone Main · Hangar Bay 2' };
    const sbComps = [
      { no: '4-110-2-W', name: 'Reserve Feed Water Tank', zone: '4C', auth: 'tagout', gas: 'safeworkers', tested: '0530', trade: '71 Preservation', sys: '561 · Preservation', res: 'Dry Dock 4', crit: 'Undock',
        adj: { fwd: 'active', aft: 'curing', port: 'tagout', stbd: 'clear', above: 'active', below: 'clear' },
        bands: [{ kind: 'hot', s: 3, e: 9, label: 'Tank off-gassing — hot work restricted' }],
        bars: [{ id: 'WI-3318', trade: '71 Pres', type: 'preservation', s: 3, e: 7, crit: 'cp' }, { id: 'WI-3402', trade: '56 Pipe', type: 'mod', s: 5, e: 9, crit: 'cp', oos: 'WI-3402 sounding/vent mod breaches WI-3318 final coat' }] },
      { no: '4-120-4-Q', name: 'Fan Room', zone: '4C', auth: 'released', gas: 'safeworkers', tested: '0610', trade: '54 HVAC', sys: '512 · Ventilation', res: 'Shop 54', crit: 'Sea Trials',
        adj: { fwd: 'clear', aft: 'active', port: 'clear', stbd: 'clear', above: 'clear', below: 'clear' }, bands: [],
        bars: [{ id: 'WI-5560', trade: '54 HVAC', type: 'mod', s: 12, e: 16, crit: 'normal' }, { id: 'WI-5571', trade: '71 Pres', type: 'lagging', s: 15, e: 18, crit: 'normal', oos: 'WI-5571 insulation material not on dock' }] },
      { no: '4-136-0-Q', name: 'Uptake Space No. 2', zone: '4C', auth: 'survey', gas: 'safeworkers', tested: '0500', trade: '26 Welding', sys: '234 · Uptakes', res: 'Shop 26', crit: 'Undock',
        adj: { fwd: 'clear', aft: 'clear', port: 'clear', stbd: 'clear', above: 'hot', below: 'clear' },
        bands: [{ kind: 'hot', s: 4, e: 7, label: 'Hangar hot work above — boundary restricted' }],
        bars: [{ id: 'WI-4480', trade: '71 Pres', type: 'lagging', s: 5, e: 7, crit: 'cp', boundary: 'SR-0129' }] },
      { no: '4-149-2-Q', name: 'Forced Draft Blower Room No. 3', zone: '4C', auth: 'released', gas: 'safehot', tested: '0545', trade: '31 Inside Machinists', sys: '234 · Combustion Air', res: 'Shop 31', crit: 'Undock',
        adj: { fwd: 'active', aft: 'clear', port: 'clear', stbd: 'active', above: 'clear', below: 'clear' }, bands: [],
        bars: [{ id: 'WI-2210', trade: '31 IM', type: 'ripout', s: 8, e: 12, crit: 'normal' }, { id: 'WI-2255', trade: '71 Pres', type: 'lagging', s: 11, e: 14, crit: 'normal', oos: 'access route shared with WI-2210 staging' }] },
      { no: '4-102-2-E', name: 'Switchboard Room No. 1', zone: '4B', auth: 'survey', gas: 'safeworkers', tested: '0520', trade: '51 Electrical', sys: '324 · Switchgear', res: 'Shop 51', crit: 'Fast Cruise',
        adj: { fwd: 'clear', aft: 'active', port: 'clear', stbd: 'clear', above: 'clear', below: 'clear' }, bands: [],
        bars: [{ id: 'WI-1888', trade: '11 SF', type: 'interference', s: 1, e: 3, crit: 'normal' }, { id: 'WI-1905', trade: '51 Elec', type: 'ripout', s: 2, e: 4, crit: 'near', oos: 'predecessor WI-1888 foundation mod not complete' }] },
      { no: '4-132-0-Q', name: 'Machinery Space', zone: '4B', auth: 'tagout', gas: 'safeworkers', tested: '0600', trade: '26 Welding', sys: '241 · Propulsion', res: 'Shop 26', crit: 'Undock',
        adj: { fwd: 'clear', aft: 'clear', port: 'clear', stbd: 'clear', above: 'curing', below: 'clear' },
        bands: [{ kind: 'hot', s: 5, e: 8, label: 'Hot work below curing coat (3-132 above)' }],
        bars: [{ id: 'WI-7740', trade: '26 Weld', type: 'hotwork', s: 5, e: 8, crit: 'cp', boundary: 'SR-0151' }] },
      { no: '4-141-0-C', name: 'Aft IC & Gyro Room', zone: '4B', auth: 'tagout', gas: 'safeworkers', tested: '0540', trade: '51 Electrical', sys: '437 · Interior Comms', res: 'Shop 51', crit: 'Cross',
        adj: { fwd: 'active', aft: 'clear', port: 'tagout', stbd: 'clear', above: 'clear', below: 'clear' }, bands: [],
        bars: [{ id: 'WI-3905', trade: '51 Elec', type: 'preservation', s: 7, e: 10, crit: 'near' }] },
      { no: '3-185-0-L', name: 'CPO Living Space', zone: '3C', auth: 'released', gas: 'safeworkers', tested: '0615', trade: '11 Shipfitters', sys: '640 · Living', res: 'Shop 11', crit: 'Fast Cruise',
        adj: { fwd: 'clear', aft: 'clear', port: 'active', stbd: 'clear', above: 'clear', below: 'clear' }, bands: [],
        bars: [{ id: 'WI-6610', trade: '11 SF', type: 'lagging', s: 5, e: 8, crit: 'normal' }, { id: 'WI-6602', trade: '63 Deck', type: 'buttonup', s: 6, e: 9, crit: 'near', oos: 'overhead WI-6610 must precede deck covering' }] },
      { no: '3-132-2-L', name: 'Overhead Coating Space', zone: '3C', auth: 'tagout', gas: 'safeworkers', tested: '0555', trade: '71 Preservation', sys: '561 · Preservation', res: 'Shop 71', crit: 'Undock',
        adj: { fwd: 'clear', aft: 'clear', port: 'clear', stbd: 'clear', above: 'clear', below: 'hot' },
        bands: [{ kind: 'cure', s: 4, e: 7, label: 'Preservation curing — boundary watch' }],
        bars: [{ id: 'WI-7720', trade: '71 Pres', type: 'preservation', s: 4, e: 7, crit: 'cp', boundary: 'SR-0151' }] },
      { no: 'MN-136-HB2', name: 'Hangar Bay 2 (over 4-136)', zone: 'MN', auth: 'released', gas: 'safehot', tested: '0530', trade: '26 Welding', sys: '111 · Hull', res: 'Shop 26', crit: 'Undock',
        adj: { fwd: 'active', aft: 'active', port: 'clear', stbd: 'clear', above: 'clear', below: 'hot' }, bands: [],
        bars: [{ id: 'WI-4471', trade: '26 Weld', type: 'hotwork', s: 4, e: 6, crit: 'cp', boundary: 'SR-0129' }] },
    ];
    const sbGroupKey = (c) => sbGroup === 'zone' ? c.zone : sbGroup === 'trade' ? c.trade : sbGroup === 'system' ? c.sys : sbGroup === 'resource' ? c.res : c.crit;
    const sbGroupLabel = (k) => sbGroup === 'zone' ? (zoneNames[k] || k) : k;
    const sbFiltered = sbComps.filter((c) => !sbReleasedOnly || c.auth === 'released');
    const grpOrder = [], grpMap = {};
    sbFiltered.forEach((c) => { const k = sbGroupKey(c); if (!grpMap[k]) { grpMap[k] = []; grpOrder.push(k); } grpMap[k].push(c); });

    // ---- conflicts · focus · preview (Fix & Verify) ----
    const barConf = { 'WI-3402': 'SR-0142', 'WI-3318': 'SR-0142', 'WI-1905': 'SR-0118', 'WI-1888': 'SR-0118', 'WI-2255': 'SR-0137', 'WI-5571': 'SR-0101', 'WI-6602': 'SR-0096', 'WI-4471': 'SR-0129', 'WI-4480': 'SR-0129', 'WI-7740': 'SR-0151', 'WI-7720': 'SR-0151' };
    const sbConflicts = [
      { id: 'SR-0142', comp: '4-110-2-W', sev: 'High', onCP: true, title: 'Preservation-boundary rework',
        plain: 'WI-3402 sounding/vent piping mod cuts the tank boundary after WI-3318 lays the final coat — the coat would be breached and a full re-coat required.',
        impact: '+6 CP-days at risk · tank off-gassing · coating-boundary breach', bars: ['WI-3318', 'WI-3402'], comps: ['4-110-2-W'],
        traces: [{ from: 'WI-3318 Tank preservation', to: 'WI-3402 Sounding/vent piping mod', rule: 'PRES-07 · No boundary breach after final coat' }],
        fixes: [
          { id: 'reseq', type: 'Re-sequence', label: 'Re-sequence WI-3402 ahead of WI-3318 final coat', cpDelta: -6, shifts: 3, newConf: 0, effort: 'Low', move: { bar: 'WI-3402', toS: 1 }, clearBand: '4-110-2-W', changed: ['WI-3402 pulled ahead of WI-3318 final coat; 3 downstream items shifted +2 days', 'hot work now after full cure — boundary watch cleared'], head: 'SR-0142 resolved, 6 critical-path days recovered, no new conflicts' },
          { id: 'split', type: 'Stage / split', label: 'Split WI-3402 — rough-in before coat, tie-in after cure', cpDelta: -3, shifts: 2, newConf: 0, effort: 'Med', move: { bar: 'WI-3402', toS: 2 }, clearBand: '4-110-2-W', changed: ['WI-3402 split — rough-in before coat, final tie-in after cure'], head: 'SR-0142 resolved, 3 CP-days recovered, no new conflicts' },
          { id: 'defer', type: 'Defer to next availability', label: 'Defer WI-3402 to the next availability', cpDelta: 0, shifts: 1, newConf: 1, effort: 'Low', move: { bar: 'WI-3402', toS: 21 }, changed: ['WI-3402 deferred — scope carries to next availability'], head: 'SR-0142 deferred — review scope carry-over' },
        ] },
      { id: 'SR-0129', comp: '4-136-0-Q', sev: 'High', onCP: true, title: 'Hot-work deconfliction · boundary',
        plain: 'Hangar Bay 2 hot work (WI-4471) runs directly above WI-4480 uptake preservation curing — fire / FOD vertical-boundary violation.',
        impact: '+4 CP-days · hot work above curing coat', bars: ['WI-4471', 'WI-4480'], comps: ['MN-136-HB2', '4-136-0-Q'],
        traces: [{ from: 'WI-4471 Hangar hot work', to: 'WI-4480 Uptake lagging', rule: 'HW-03 · No combustible work within hot-work vertical boundary' }],
        fixes: [
          { id: 'window', type: 'Deconflict window', label: 'Shift hangar hot work after uptake cure', cpDelta: -4, shifts: 2, newConf: 0, effort: 'Med', move: { bar: 'WI-4471', toS: 8 }, changed: ['WI-4471 hot work moved after the uptake cure window'], head: 'SR-0129 resolved, 4 CP-days recovered, no new conflicts' },
          { id: 'firewatch', type: 'Coordinate scope', label: 'Proceed under boundary / fire watch + FOD control', cpDelta: 0, shifts: 0, newConf: 0, effort: 'Low', move: null, changed: ['boundary / fire watch set — work proceeds under control'], head: 'SR-0129 mitigated under fire watch — no schedule change' },
        ] },
      { id: 'SR-0151', comp: '4-132-0-Q', sev: 'High', onCP: true, title: 'Hot work below curing coat',
        plain: 'WI-7740 hot work in 4-132 is scheduled while 3-132 overhead coating is still curing directly above — boundary-watch violation.',
        impact: '+3 CP-days · hot work below curing coat', bars: ['WI-7720', 'WI-7740'], comps: ['3-132-2-L', '4-132-0-Q'],
        traces: [{ from: 'WI-7720 Overhead preservation · curing', to: 'WI-7740 Hot work', rule: 'PRES-09 · No hot work within a curing-coat boundary' }],
        fixes: [
          { id: 'after', type: 'Deconflict window', label: 'Re-sequence hot work after full cure', cpDelta: -3, shifts: 1, newConf: 0, effort: 'Low', move: { bar: 'WI-7740', toS: 9 }, clearBand: '4-132-0-Q', changed: ['WI-7740 hot work moved after cure — boundary cleared'], head: 'SR-0151 resolved, 3 CP-days recovered, no new conflicts' },
        ] },
      { id: 'SR-0118', comp: '4-102-2-E', sev: 'Med', onCP: false, title: 'Missing predecessor',
        plain: 'WI-1905 removal is scheduled before its predecessor WI-1888 foundation mod completes.',
        impact: 'sequence break · space survey pending', bars: ['WI-1888', 'WI-1905'], comps: ['4-102-2-E'],
        traces: [{ from: 'WI-1888 Foundation mod', to: 'WI-1905 Removal', rule: 'SEQ-01 · Predecessor completion required' }],
        fixes: [
          { id: 'insert', type: 'Insert predecessor', label: 'Sequence WI-1905 after WI-1888 completes', cpDelta: 0, shifts: 1, newConf: 0, effort: 'Low', move: { bar: 'WI-1905', toS: 4 }, changed: ['WI-1905 moved after WI-1888 foundation mod'], head: 'SR-0118 resolved — predecessor restored, no CP impact' },
        ] },
    ];
    const selConflict = sbConflictSel ? sbConflicts.find((x) => x.id === sbConflictSel) : null;
    const selFix = (selConflict && sbFixSel) ? selConflict.fixes.find((f) => f.id === sbFixSel) : null;
    const appliedFix = (sbApplied && selConflict) ? selConflict.fixes.find((f) => f.id === sbApplied) : null;
    const activeFix = appliedFix || selFix;
    const previewMove = activeFix ? activeFix.move : null;
    const clearBandComp = activeFix && activeFix.clearBand ? activeFix.clearBand : null;
    const focusMode = !!selConflict;
    const focusBarSet = {}, focusCompSet = {};
    if (selConflict) { selConflict.bars.forEach((b) => focusBarSet[b] = 1); selConflict.comps.forEach((c) => focusCompSet[c] = 1); }
    const selConflictBar = (id) => this.setState({ sbConflictSel: id, sbFixSel: null, sbApplied: null, sbSel: null, sbSandbox: false });
    const sbSafeMap = { 'SR-0142': { comp: '4-110-2-W', s: 1, e: 3, label: 'Safe window — before final coat' }, 'SR-0129': { comp: '4-136-0-Q', s: 8, e: 12, label: 'Safe window — after hangar hot work' }, 'SR-0151': { comp: '4-132-0-Q', s: 9, e: 13, label: 'Safe window — after full cure' }, 'SR-0118': { comp: '4-102-2-E', s: 4, e: 7, label: 'Safe window — after predecessor' } };
    const selSafe = selConflict ? sbSafeMap[selConflict.id] : null;
    const sbBarTransition = sbDragging ? 'none' : 'left 200ms ease,width 200ms ease,opacity 160ms';

    const RULER_H = 44, ZONE_H = 42, ROW_H = 84;
    let sy = RULER_H;
    const sbGroupsR = [], laneY = {};
    grpOrder.forEach((k) => {
      const comps = grpMap[k];
      const released = comps.filter((c) => c.auth === 'released').length;
      const gasr = comps.filter((c) => c.gas === 'notsafe' || c.bands.some((b) => b.kind === 'hot' || b.kind === 'cure')).length;
      const tag = comps.filter((c) => c.auth === 'tagout').length;
      const conf = comps.reduce((n, c) => n + c.bars.filter((b) => b.oos || b.boundary).length, 0);
      const collapsed = !!sbCollapsed[k];
      const header = { key: 'z-' + k, label: sbGroupLabel(k), yTop: sy + 'px', released, gasr, tag, conf, hasConf: conf > 0,
        relPct: Math.round(released / comps.length * 100) + '%', gasPct: Math.round(gasr / comps.length * 100) + '%', tagPct: Math.round(tag / comps.length * 100) + '%',
        collapsed, chev: collapsed ? '▸' : '▾', onToggle: () => this.setState((s) => ({ sbCollapsed: Object.assign({}, s.sbCollapsed, { [k]: !s.sbCollapsed[k] }) })) };
      sy += ZONE_H;
      const lanes = [];
      if (!collapsed) {
        comps.forEach((c, ci) => {
          const am = authMeta[c.auth], gm = gasMeta[c.gas];
          const adjCells = [['F', 'fwd'], ['A', 'aft'], ['P', 'port'], ['S', 'stbd'], ['▲', 'above'], ['▼', 'below']].map(([lab, dir]) => { const st = adjMeta[c.adj[dir]] || adjMeta.clear; return { lab, bg: st.c, title: dir.toUpperCase() + ' · ' + st.label }; });
          const anyOverlap = c.bars.some((b, i) => c.bars.some((o, j) => j < i && b.s <= o.e && o.s <= b.e));
          const bars = c.bars.map((b, bi) => {
            const mv = previewMove && previewMove.bar === b.id ? previewMove : null;
            const shift = (sbSandbox && sbShift[b.id]) ? sbShift[b.id] : 0;
            const dur = b.e - b.s;
            const s2 = mv ? mv.toS : b.s + shift, e2 = mv ? mv.toS + dur : b.e + shift, tm = typeMeta[b.type];
            const confId = barConf[b.id] || null, isConf = !!(b.oos || b.boundary || confId);
            let opacity = 1;
            if (focusMode) opacity = focusBarSet[b.id] ? 1 : 0.26;
            else if (sbConflictsOnly) opacity = isConf ? 1 : 0.22;
            const prog = Math.max(0, Math.min(1, (deWeek + 0.5 - s2) / (e2 - s2 + 1)));
            return { key: b.id, id: b.id, left: sbPct(s2) + '%', width: ((e2 - s2 + 1) / WK * 100) + '%', accent: tm.c, typeLabel: tm.label, trade: b.trade,
              progW: Math.round(prog * 100) + '%', progC: prog >= 1 ? 'rgba(34,197,94,0.75)' : 'rgba(61,107,255,0.85)',
              topPct: anyOverlap ? (bi % 2 ? '73%' : '28%') : '50%', barH: anyOverlap ? '30px' : '38px',
              hoverTitle: (b.oos ? b.oos + ' · ' : '') + b.id + ' · W' + s2 + '→W' + e2 + ' · ' + Math.round(prog * 100) + '% through window',
              critBorder: b.crit === 'cp' ? '1.5px dashed #dc2626' : (b.crit === 'near' ? '1px solid #f59e0b' : '1px solid #2b2d36'),
              critBg: b.crit === 'cp' ? 'rgba(220,38,38,0.16)' : (b.crit === 'near' ? 'rgba(245,158,11,0.10)' : '#20222b'),
              hasOos: !!b.oos, oosReason: b.oos || '', shifted: shift !== 0, opacity,
              ring: focusBarSet[b.id] ? '0 0 0 2px #3D6BFF, 0 0 13px rgba(61,107,255,0.65)' : 'none', barTransition: sbBarTransition,
              ghost: !!mv, ghostLeft: sbPct(b.s) + '%', ghostWidth: ((dur + 1) / WK * 100) + '%',
              confId, isConf, clickable: !!confId,
              onClick: confId ? () => selConflictBar(confId) : (() => {}), onDown: (e) => this._sbBarDown(b.id, e) };
          });
          const bands = c.bands.map((bd, i) => { const clr = clearBandComp === c.no; return { key: 'bd' + i, left: sbPct(bd.s) + '%', width: ((bd.e - bd.s + 1) / WK * 100) + '%', isCure: bd.kind === 'cure', title: clr ? 'Cleared — boundary respected' : bd.title || bd.label,
            bg: clr ? 'repeating-linear-gradient(45deg, rgba(34,197,94,0.16) 0 6px, rgba(34,197,94,0.03) 6px 12px)' : (bd.kind === 'cure' ? 'repeating-linear-gradient(45deg, rgba(34,197,94,0.14) 0 6px, rgba(34,197,94,0.03) 6px 12px)' : 'repeating-linear-gradient(45deg, rgba(220,38,38,0.14) 0 6px, rgba(220,38,38,0.03) 6px 12px)'),
            bdr: clr ? 'rgba(34,197,94,0.4)' : (bd.kind === 'cure' ? 'rgba(34,197,94,0.3)' : 'rgba(220,38,38,0.3)') }; });
          laneY[c.no] = sy + ROW_H / 2;
          const sel = sbSel === c.no;
          const safeBand = (focusMode && selSafe && selSafe.comp === c.no) ? { left: sbPct(selSafe.s) + '%', width: ((selSafe.e - selSafe.s + 1) / WK * 100) + '%', label: selSafe.label } : null;
          let laneOp = 1;
          if (focusMode) laneOp = focusCompSet[c.no] ? 1 : 0.4;
          else if (sbConflictsOnly) laneOp = c.bars.some((b) => b.oos || b.boundary) ? 1 : 0.45;
          lanes.push({ key: 'l-' + c.no, no: c.no, name: c.name, yTop: sy + 'px', laneOp, safeBand, hasSafe: !!safeBand, rowBg: ci % 2 ? 'rgba(255,255,255,0.014)' : 'transparent',
            authLabel: am.label, authColor: am.c, authBg: am.bg, gasLabel: gm.label, gasColor: gm.c, gasBg: gm.bg, tested: c.tested,
            adjCells, bars, bands, headBg: sel ? '#20222b' : '#121316', headBorder: sel ? '#424656' : '#2b2d36',
            gasShade: sbGasLayer && (c.gas === 'notsafe' || c.bands.some((bd) => bd.kind === 'hot' || bd.kind === 'cure')),
            onSelect: () => this.setState({ sbSel: c.no }) });
          sy += ROW_H;
        });
      }
      sbGroupsR.push({ key: 'g-' + k, header, lanes });
    });
    const sbContentH = sy + 'px';

    const sbGates = [{ label: 'Undock · 18 d', week: 8, hard: true, c: '#dc2626' }, { label: 'Fast Cruise', week: 11, hard: false, c: '#f59e0b' }, { label: 'Sea Trials', week: 15, hard: false, c: '#22c55e' }].map((g) => ({ key: g.label, label: g.label, leftPct: sbPct(g.week) + '%', c: g.c, hard: g.hard }));
    const sbWeeks = []; for (let w = 1; w <= 26; w++) sbWeeks.push({ key: 'w' + w, leftPct: sbPct(w) + '%', label: 'W' + w, major: w === 1 || w % 5 === 0, gridC: (w === 1 || w % 5 === 0) ? '#24262e' : '#191a1f' });
    const sbNowPct = sbPct(deWeek) + '%', sbNowLabel = 'W' + deWeek;

    const connDefs = [
      { id: 'SR-0129', a: 'MN-136-HB2', b: '4-136-0-Q', week: 5, label: 'SR-0129 · Hangar hot work above uptake preservation' },
      { id: 'SR-0151', a: '3-132-2-L', b: '4-132-0-Q', week: 6, label: 'SR-0151 · Hot work below curing coat' },
    ];
    const sbConnectors = connDefs.filter((cn) => laneY[cn.a] != null && laneY[cn.b] != null).map((cn) => {
      const y1 = Math.min(laneY[cn.a], laneY[cn.b]), y2 = Math.max(laneY[cn.a], laneY[cn.b]);
      return { key: cn.id, leftPct: sbPct(cn.week) + '%', top: y1 + 'px', height: (y2 - y1) + 'px', midY: ((y1 + y2) / 2) + 'px', label: cn.label, onClick: () => selConflictBar(cn.id) };
    });

    const sbFocusLink = (function () {
      if (!selConflict) return null;
      const wiIndex = {}; sbComps.forEach((c) => c.bars.forEach((b) => { wiIndex[b.id] = { comp: c.no, s: b.s, e: b.e }; }));
      const a = wiIndex[selConflict.bars[0]], b = wiIndex[selConflict.bars[1]];
      if (!a || !b || laneY[a.comp] == null || laneY[b.comp] == null) return null;
      const cw = Math.max(a.s, b.s);
      const y1 = Math.min(laneY[a.comp], laneY[b.comp]), y2 = Math.max(laneY[a.comp], laneY[b.comp]);
      return { leftPct: sbPct(cw) + '%', top: y1 + 'px', height: (y2 - y1) + 'px', midY: ((y1 + y2) / 2) + 'px', sameLane: a.comp === b.comp, label: selConflict.bars[0] + '  ✕  ' + selConflict.bars[1] };
    })();

    // sandbox
    let cpDeltaDays = 0; const sbViolations = [];
    Object.keys(sbShift).forEach((id) => {
      const sh = sbShift[id]; if (!sh || !sbSandbox) return;
      const comp = sbComps.find((c) => c.bars.some((b) => b.id === id)); if (!comp) return;
      const bar = comp.bars.find((b) => b.id === id); const ns = bar.s + sh, ne = bar.e + sh;
      if (bar.crit === 'cp') cpDeltaDays += sh * 2;
      if (ns < 1) sbViolations.push({ key: id + 'a', id, msg: id + ' — scheduled before availability start (W1)' });
      if (bar.type === 'hotwork') { const hit = comp.bands.find((bd) => (bd.kind === 'hot' || bd.kind === 'cure') && ns <= bd.e && ne >= bd.s); if (hit) sbViolations.push({ key: id + 'h', id, msg: comp.no + ' — Not Safe for Hot Work · ' + hit.label }); }
      if (comp.auth !== 'released') sbViolations.push({ key: id + 'r', id, msg: comp.no + ' — space not released (' + authMeta[comp.auth].label + ')' });
    });
    const sbShiftCount = Object.keys(sbShift).filter((id) => sbShift[id]).length;
    const cpDeltaLabel = cpDeltaDays === 0 ? 'no CP change' : (cpDeltaDays < 0 ? Math.abs(cpDeltaDays) + ' d recovered' : '+' + cpDeltaDays + ' d added');
    const cpDeltaColor = cpDeltaDays < 0 ? '#22c55e' : (cpDeltaDays > 0 ? '#dc2626' : '#94a3b8');
    const sbSelComp = sbSel ? sbComps.find((c) => c.no === sbSel) : null;
    let sbDetail = null;
    if (sbSelComp) {
      sbDetail = { no: sbSelComp.no, name: sbSelComp.name, zone: zoneNames[sbSelComp.zone] || sbSelComp.zone,
        authLabel: authMeta[sbSelComp.auth].label, authColor: authMeta[sbSelComp.auth].c, authBg: authMeta[sbSelComp.auth].bg,
        gasLabel: gasMeta[sbSelComp.gas].label, gasColor: gasMeta[sbSelComp.gas].c, gasBg: gasMeta[sbSelComp.gas].bg, tested: sbSelComp.tested,
        trade: sbSelComp.trade, sys: sbSelComp.sys, res: sbSelComp.res,
        bars: sbSelComp.bars.map((b) => ({ key: b.id, id: b.id, trade: b.trade, type: typeMeta[b.type].label, range: 'W' + b.s + '–W' + b.e, cp: b.crit === 'cp', oos: b.oos || '' })),
        bands: sbSelComp.bands.map((bd, i) => ({ key: 'sd' + i, label: bd.label })) };
    }
    const sbGroupSel = [['zone', 'Compartment / Zone'], ['trade', 'Trade / Shop'], ['system', 'System (ESWBS)'], ['resource', 'Resource'], ['crit', 'Key-Event']].map(([v, l]) => ({ val: v, label: l, active: sbGroup === v, color: sbGroup === v ? '#f2f3f6' : '#94a3b8', bg: sbGroup === v ? '#2b2d36' : 'transparent', onClick: () => this.setState({ sbGroup: v }) }));

    // summary strip (live)
    const recoveredNow = appliedFix ? Math.abs(appliedFix.cpDelta) : 0;
    const sbSummary = { open: sbConflicts.length, onCP: sbConflicts.filter((c) => c.onCP).length, cpAtRisk: 13 - recoveredNow, recoverable: 13, blocked: sbComps.filter((c) => c.auth !== 'released' || c.bands.length).length, recoveredNow, hasRecovered: recoveredNow > 0 };
    const sbConfList = sbConflicts.map((c) => ({ key: c.id, id: c.id, sev: c.sev, sevColor: c.sev === 'High' ? '#dc2626' : '#f59e0b', title: c.title, comp: c.comp, sel: sbConflictSel === c.id, onClick: () => selConflictBar(c.id) }));

    // resolve panel
    let sbResolve = null;
    if (selConflict) {
      sbResolve = { id: selConflict.id, title: selConflict.title, comp: selConflict.comp, sev: selConflict.sev, onCP: selConflict.onCP,
        sevColor: selConflict.sev === 'High' ? '#dc2626' : '#f59e0b', plain: selConflict.plain, impact: selConflict.impact, traces: selConflict.traces,
        fixes: selConflict.fixes.map((f) => ({ key: f.id, id: f.id, type: f.type, label: f.label,
          cpLabel: f.cpDelta < 0 ? Math.abs(f.cpDelta) + ' d recovered' : (f.cpDelta > 0 ? '+' + f.cpDelta + ' d' : 'no CP change'),
          cpColor: f.cpDelta < 0 ? '#22c55e' : (f.cpDelta > 0 ? '#dc2626' : '#94a3b8'),
          newConfLabel: f.newConf === 0 ? 'no new conflicts' : f.newConf + ' new conflict', newConfColor: f.newConf === 0 ? '#22c55e' : '#f59e0b',
          shiftsLabel: f.shifts + ' items shift', effort: f.effort,
          rowBg: sbFixSel === f.id ? '#20222b' : '#0b0c0e', rowBorder: (sbFixSel === f.id || sbApplied === f.id) ? '#3D6BFF' : '#2b2d36',
          applied: sbApplied === f.id, isSel: sbFixSel === f.id,
          onClick: () => this.setState({ sbFixSel: f.id, sbApplied: null }), onApply: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.setState({ sbApplied: f.id }); } })),
        hasPreview: !!selFix && !appliedFix, hasApplied: !!appliedFix,
        appliedHead: appliedFix ? appliedFix.head : '', appliedChanged: appliedFix ? appliedFix.changed.map((t, i) => ({ key: 'c' + i, t })) : [],
        appliedCpLabel: appliedFix ? (appliedFix.cpDelta < 0 ? Math.abs(appliedFix.cpDelta) + ' days recovered' : (appliedFix.cpDelta > 0 ? '+' + appliedFix.cpDelta + ' days' : 'no CP change')) : '',
        appliedCpColor: appliedFix && appliedFix.cpDelta < 0 ? '#22c55e' : '#94a3b8',
        appliedNewConf: appliedFix ? (appliedFix.newConf === 0 ? 'none' : appliedFix.newConf + ' — review') : '',
        onExit: () => this.setState({ sbConflictSel: null, sbFixSel: null, sbApplied: null }),
        onPropose: () => this.setState({ sbToast: 'Proposed re-sequence routed to IPT — schedule of record unchanged.' }) };
    }

    // ===================== CONFLICTS & RISK =====================
    const crSevMeta = { High: { c: '#dc2626', bg: 'rgba(220,38,38,0.14)', rank: 3 }, Med: { c: '#f59e0b', bg: 'rgba(245,158,11,0.14)', rank: 2 }, Low: { c: '#94a3b8', bg: 'rgba(148,163,184,0.13)', rank: 1 } };
    const crStatusMeta = { open: { label: 'Open', c: '#94a3b8', bg: 'rgba(148,163,184,0.12)' }, validated: { label: 'Validated', c: '#3D6BFF', bg: 'rgba(61,107,255,0.13)' }, mitigated: { label: 'Mitigated', c: '#f59e0b', bg: 'rgba(245,158,11,0.13)' }, accepted: { label: 'Accepted', c: '#22c55e', bg: 'rgba(34,197,94,0.13)' }, closed: { label: 'Closed', c: '#22c55e', bg: 'rgba(34,197,94,0.13)' } };
    const crStatusNext = { open: 'validated', validated: 'mitigated', mitigated: 'accepted', accepted: 'closed', closed: 'open' };
    const crData = [
      { id: 'SR-0142', cls: 'Preservation-boundary rework', sev: 'High', onCP: true, comp: '4-110-2-W', name: 'Reserve Feed Water Tank', frame: 'Fr 110', deck: '4th', wiA: 'WI-3318', wiB: 'WI-3402', cpDays: 6, status: 'validated', owner: 'J. Reyes · Planner', trade: '71 Preservation', avail: 'CVN-73 PIA-26', event: 'Undock',
        why: 'WI-3402 sounding/vent piping mod opens the tank boundary after WI-3318 lays the final coat — boundary integrity lost, re-coat required.', traces: [{ from: 'WI-3318 Tank preservation', to: 'WI-3402 Sounding/vent piping mod', rule: 'PRES-07 · No boundary breach after final coat' }], mits: ['Re-sequence WI-3402 ahead of WI-3318 final coat (−6 CP-d)', 'Stage / split WI-3402 — rough-in before coat, tie-in after cure'] },
      { id: 'SR-0129', cls: 'Hot-work deconfliction', sev: 'High', onCP: true, comp: '4-136-0-Q', name: 'Uptake Space No. 2', frame: 'Fr 136', deck: 'Main', wiA: 'WI-4471', wiB: 'WI-4480', cpDays: 4, status: 'open', owner: '—', trade: '26 Welding', avail: 'CVN-73 PIA-26', event: 'Undock',
        why: 'Hangar Bay 2 hot work (WI-4471) overlaps uptake lagging (WI-4480) directly below — hot-work boundary unsafe with lagging crews present.', traces: [{ from: 'WI-4471 Hangar hot work', to: 'WI-4480 Uptake lagging', rule: 'HW-03 · No combustible work within hot-work vertical boundary' }], mits: ['Deconflict the hot-work window — shift WI-4471 after uptake cure', 'Proceed under boundary / fire watch + FOD control'] },
      { id: 'SR-0151', cls: 'Hot-work deconfliction', sev: 'High', onCP: true, comp: '4-132-0-Q', name: 'Machinery Space', frame: 'Fr 132', deck: '4th', wiA: 'WI-7720', wiB: 'WI-7740', cpDays: 3, status: 'open', owner: '—', trade: '26 Welding', avail: 'CVN-73 PIA-26', event: 'Undock',
        why: '4-132 hot work (WI-7740) is scheduled while 3-132 overhead coating (WI-7720) is still curing directly above — boundary-watch violation.', traces: [{ from: 'WI-7720 Overhead preservation · curing', to: 'WI-7740 Hot work', rule: 'PRES-09 · No hot work within a curing-coat boundary' }], mits: ['Re-sequence hot work after full cure (−3 CP-d)', 'Set a boundary / fire watch if it must proceed'] },
      { id: 'XR-0007', cls: 'Cross-availability', sev: 'High', onCP: false, comp: '4-141-0-C', name: 'Aft IC & Gyro Room', frame: 'Fr 141', deck: '4th', wiA: 'WI-3905', wiB: 'WI-8810', cpDays: 0, cpText: 'FY28', status: 'open', owner: 'Program Office', trade: '51 Electrical', avail: 'CVN-73 PIA-26', event: 'Cross',
        why: 'WI-3905 IC preservation / cableway closure (PIA-26) blocks a future WI-8810 combat-system cable pull (CVN-75 / CVN-73 DPIA-28).', traces: [{ from: 'WI-3905 IC preservation / cableway closure', to: 'WI-8810 Combat-system cable pull', rule: 'XAV-01 · Cross-availability cable-route coordination' }], mits: ['Coordinate the FY28 cable route into PIA-26 scope now', 'Defer cableway closure pending DPIA-28 route confirmation'] },
      { id: 'SR-0180', cls: 'Equipment-removal route (soft patch)', sev: 'High', onCP: true, comp: '4-148-0-E', name: 'No. 3 AC&R Machinery Room', frame: 'Fr 142–152', deck: '4th', wiA: 'WI-5160', wiB: 'WI-4471 / WI-3318 / WI-2210 +5', cpDays: 12, status: 'validated', owner: 'L. Park · IPT', trade: '11 Shipfitters', avail: 'CVN-73 PIA-26', event: 'Undock',
        why: 'The 375-ton AC&R plant (M-19) is too large for any hatch or trunk. A temporary soft-patch must be cut through the flight deck and every deck down to 4th level to lower it in — opening a vertical cut trunk Fr 142–152 that takes the compartments along the path OUT OF SERVICE for the cut-to-button-up window. No hot work, staging, preservation, or systems work can occur in any compartment in the cut path while the patch is open.',
        offline: ['1-148-2-Q Gallery / Catapult Mach.', '2-148-0-L Berthing', '3-146-2-Q Pump Room', '4-148-0-E AC&R Machinery No. 3', '4-150-2-Q FD Blower Rm No. 3', '01-148 Sponson (rigging)'],
        cutDecks: ['Flight', 'Gallery', 'Main', '2nd', '3rd', '4th'],
        traces: [{ from: 'WI-5160 AC&R plant landing (soft patch)', to: 'WI-4471 hull HW · WI-3318 tank pres · WI-2210 valve OH', rule: 'STR-12 · No work in compartments within an open soft-patch cut boundary' }],
        mits: ['Open the patch in a single window and front-load it before dependent compartment work', 'Re-sequence the 6 affected compartments around the cut-open → button-up dates (−12 CP-d if aligned)', 'Pre-stage all cut-path equipment so the patch is open the minimum duration', 'Restore structural temp shoring + fire boundaries before re-occupying'] },
      { id: 'SR-0186', cls: 'Equipment-removal route (soft patch)', sev: 'High', onCP: true, comp: '4-094-0-E', name: 'No. 2 Switchboard / SSTG Room', frame: 'Fr 90–98', deck: '4th', wiA: 'WI-2510', wiB: 'WI-1905 / WI-1888 +3', cpDays: 9, status: 'open', owner: '—', trade: '11 Shipfitters', avail: 'CVN-73 PIA-26', event: 'Undock',
        why: 'Main reduction-gear & SSTG modules (M-12 / M-14) exceed hatch envelopes. A soft-patch cut Fr 90–98 through Hangar deck down to 4th opens a vertical removal route, taking the switchboard, IC, and berthing compartments in the path offline. Electrical rip-out and foundation work in those spaces cannot proceed until the patch is buttoned up and structure is re-certified.',
        offline: ['1-094-0-Q Hangar Bay 1', '2-094-2-E IC Room', '3-094-0-L Berthing', '4-094-0-E No. 2 Switchboard Rm', '4-096-2-E SSTG Room'],
        cutDecks: ['Hangar', 'Main', '2nd', '3rd', '4th'],
        traces: [{ from: 'WI-2510 Reduction-gear landing (soft patch)', to: 'WI-1905 SWBD removal · WI-1888 foundation mod', rule: 'STR-12 · No work in compartments within an open soft-patch cut boundary' }],
        mits: ['Sequence switchboard rip-out (WI-1905) after patch button-up', 'Combine reduction-gear & SSTG landings into one patch-open window', 'Add temporary shoring so adjacent (non-path) compartments stay in work'] },
      { id: 'SR-0096', cls: 'Sequence inversion', sev: 'Med', onCP: true, comp: '3-185-0-L', name: 'CPO Living Space', frame: 'Fr 185', deck: '3rd', wiA: 'WI-6602', wiB: 'WI-6610', cpDays: 0, status: 'mitigated', owner: 'L. Park · IPT', trade: '11 Shipfitters', avail: 'CVN-73 PIA-26', event: 'Fast Cruise',
        why: 'WI-6602 deck covering precedes WI-6610 overhead install — overhead work will damage the new covering.', traces: [{ from: 'WI-6610 Overhead install', to: 'WI-6602 Deck covering', rule: 'SEQ-04 · Overhead before finish flooring' }], mits: ['Invert order — overhead install ahead of deck covering'] },
      { id: 'SR-0137', cls: 'Access / staging', sev: 'Med', onCP: false, comp: '4-149-2-Q', name: 'Forced Draft Blower Room No. 3', frame: 'Fr 149', deck: '4th', wiA: 'WI-2210', wiB: 'WI-2255', cpDays: 0, status: 'open', owner: '—', trade: '31 Inside Machinists', avail: 'CVN-73 PIA-26', event: 'Undock',
        why: 'Valve-overhaul staging (WI-2210) blocks the only access route the lagging crew (WI-2255) needs in overlapping weeks.', traces: [{ from: 'WI-2210 Valve overhaul', to: 'WI-2255 Lagging install', rule: 'ACC-02 · Shared access-route capacity' }], mits: ['Stagger access windows', 'Add a second access route / resource'] },
      { id: 'SR-0118', cls: 'Missing predecessor', sev: 'Med', onCP: false, comp: '4-102-2-E', name: 'Switchboard Room No. 1', frame: 'Fr 102', deck: '4th', wiA: 'WI-1888', wiB: 'WI-1905', cpDays: 0, status: 'validated', owner: 'M. Cole · Planner', trade: '51 Electrical', avail: 'CVN-73 PIA-26', event: 'Fast Cruise',
        why: 'WI-1905 removal has no completed predecessor; WI-1888 foundation mod must precede it.', traces: [{ from: 'WI-1888 Foundation mod', to: 'WI-1905 Removal', rule: 'SEQ-01 · Predecessor completion required' }], mits: ['Insert predecessor — sequence WI-1905 after WI-1888'] },
      { id: 'SR-0101', cls: 'Material timing', sev: 'Low', onCP: false, comp: '4-120-4-Q', name: 'Fan Room', frame: 'Fr 120', deck: '4th', wiA: 'WI-5560', wiB: 'WI-5571', cpDays: 0, status: 'accepted', owner: 'K. Doyle · Material', trade: '71 Preservation', avail: 'CVN-73 PIA-26', event: 'Sea Trials',
        why: 'WI-5571 insulation is not on dock until after WI-5560 vent mod completes — install slips.', traces: [{ from: 'WI-5560 Vent mod', to: 'WI-5571 Insulation', rule: 'MAT-05 · Material on dock before install' }], mits: ['Align insulation delivery to vent-mod completion'] },
      { id: 'SR-0221', cls: 'Hot-work deconfliction', sev: 'High', onCP: true, comp: '2-130-0-L', name: 'Berthing (hot-work boundary)', frame: 'Fr 130', deck: '2nd', wiA: 'WI-7110', wiB: 'WI-7180', cpDays: 0, cpText: 'ON CP', status: 'validated', owner: 'T. Okafor · Zone Mgr', trade: '26 Welding', avail: 'CVN-71 SRA-26', event: 'Move-Aboard',
        why: 'Hot work runs against an occupied berthing boundary in the crew move-aboard window.', traces: [{ from: 'WI-7110 Hot work', to: 'WI-7180 Berthing prep', rule: 'HW-03 · Hot-work boundary' }], mits: ['Deconflict the hot-work window before move-aboard'] },
      { id: 'SR-0210', cls: 'Access / staging', sev: 'Med', onCP: false, comp: '3-160-2-Q', name: 'Pump Room', frame: 'Fr 160', deck: '3rd', wiA: 'WI-7240', wiB: 'WI-7255', cpDays: 0, status: 'open', owner: '—', trade: '31 Inside Machinists', avail: 'CVN-71 SRA-26', event: 'Move-Aboard',
        why: 'Pump overhaul and valve work share a single access route in overlapping weeks.', traces: [{ from: 'WI-7240 Pump overhaul', to: 'WI-7255 Valve work', rule: 'ACC-02 · Shared access route' }], mits: ['Stagger access windows'] },
      { id: 'SR-0215', cls: 'Material timing', sev: 'Low', onCP: false, comp: '4-140-4-Q', name: 'Vent Space', frame: 'Fr 140', deck: '4th', wiA: 'WI-7310', wiB: 'WI-7325', cpDays: 0, status: 'accepted', owner: 'K. Doyle · Material', trade: '71 Preservation', avail: 'CVN-71 SRA-26', event: 'Sea Trials',
        why: 'Install material is not on dock until after the predecessor completes.', traces: [{ from: 'WI-7310 Vent mod', to: 'WI-7325 Insulation', rule: 'MAT-05 · Material on dock before install' }], mits: ['Align material delivery'] },
    ];
    const crStatusOf = (c) => crStatus[c.id] || c.status;
    const crOwnerOf = (c) => crOwner[c.id] || c.owner;
    const crMkOpts = (arr, allLabel) => [{ val: 'all', label: allLabel }].concat(arr.map((v) => ({ val: v, label: v })));
    const crClassOpts = crMkOpts(['Preservation-boundary rework', 'Hot-work deconfliction', 'Sequence inversion', 'Access / staging', 'Missing predecessor', 'Material timing', 'Cross-availability', 'Equipment-removal route (soft patch)'], 'All classes');
    const crDeckOpts = crMkOpts(['Main', '2nd', '3rd', '4th'], 'All decks');
    const crTradeOpts = crMkOpts(['71 Preservation', '26 Welding', '51 Electrical', '31 Inside Machinists', '11 Shipfitters'], 'All trades');
    const crAvailOpts = crMkOpts(['CVN-73 PIA-26', 'CVN-71 SRA-26'], 'All availabilities');
    const crEventOpts = crMkOpts(['Undock', 'Fast Cruise', 'Sea Trials', 'Move-Aboard', 'Cross'], 'All key events');
    const crSevOpts = crMkOpts(['High', 'Med', 'Low'], 'All severities');
    const crCpOpts = [{ val: 'all', label: 'CP — all' }, { val: 'cp', label: 'On critical path' }, { val: 'notcp', label: 'Not on CP' }];

    const crMatrixRows = [['High'], ['Med'], ['Low']].map(([sev]) => {
      const cpCell = crData.filter((c) => c.sev === sev && c.onCP), ncCell = crData.filter((c) => c.sev === sev && !c.onCP);
      const focal = sev === 'High';
      const mk = (cell, cp) => ({ ids: cell.map((c) => c.id).join('  '), count: cell.length, has: cell.length > 0, focal: focal && cp, sel: crMatrix && crMatrix.sev === sev && crMatrix.cp === cp, onClick: () => this.setState((s) => ({ crMatrix: (s.crMatrix && s.crMatrix.sev === sev && s.crMatrix.cp === cp) ? null : { sev, cp } })) });
      return { key: sev, sev, sevColor: crSevMeta[sev].c, cp: mk(cpCell, true), nc: mk(ncCell, false) };
    });

    const crQ = (crSearch || '').toLowerCase();
    let crRows = crData.filter((c) => {
      if (crClass !== 'all' && c.cls !== crClass) return false;
      if (crSev !== 'all' && c.sev !== crSev) return false;
      if (crCP === 'cp' && !c.onCP) return false;
      if (crCP === 'notcp' && c.onCP) return false;
      if (crDeck !== 'all' && c.deck !== crDeck) return false;
      if (crTrade !== 'all' && c.trade !== crTrade) return false;
      if (crAvail !== 'all' && c.avail !== crAvail) return false;
      if (crEvent !== 'all' && c.event !== crEvent) return false;
      if (crMatrix && (c.sev !== crMatrix.sev || c.onCP !== crMatrix.cp)) return false;
      if (crQ && !(c.id + ' ' + c.cls + ' ' + c.comp + ' ' + c.name + ' ' + c.wiA + ' ' + c.wiB + ' ' + crOwnerOf(c)).toLowerCase().includes(crQ)) return false;
      return true;
    });
    crRows = crRows.slice().sort((a, b) => {
      if (crSort === 'sev') return (crSevMeta[b.sev].rank - crSevMeta[a.sev].rank) || ((b.onCP ? 1 : 0) - (a.onCP ? 1 : 0)) || (b.cpDays - a.cpDays);
      if (crSort === 'cp') return ((b.onCP ? 1 : 0) - (a.onCP ? 1 : 0)) || (b.cpDays - a.cpDays);
      if (crSort === 'cpdays') return b.cpDays - a.cpDays;
      return a.id.localeCompare(b.id);
    });
    const crCheckedIds = Object.keys(crChecked).filter((k) => crChecked[k]);
    const crRowsR = crRows.map((c) => {
      const st = crStatusOf(c), sm = crStatusMeta[st], sev = crSevMeta[c.sev];
      return { key: c.id, id: c.id, cls: c.cls, sev: c.sev, sevColor: sev.c, sevBg: sev.bg, onCP: c.onCP,
        comp: c.comp, name: c.name, frameDeck: c.frame + ' · ' + c.deck, wiPair: c.wiA + ' → ' + c.wiB,
        cpText: c.cpText || (c.cpDays > 0 ? '+' + c.cpDays + ' CP-d' : '—'), cpColor: (c.onCP ? '#dc2626' : '#94a3b8'),
        statusLabel: sm.label, statusColor: sm.c, statusBg: sm.bg, owner: crOwnerOf(c), ownerDim: crOwnerOf(c) === '—',
        checked: !!crChecked[c.id], checkBg: crChecked[c.id] ? '#3D6BFF' : 'transparent', checkBorder: crChecked[c.id] ? '#3D6BFF' : '#424656', sel: crSel === c.id, rowBg: crSel === c.id ? '#20222b' : 'transparent',
        onRow: () => this.setState({ crSel: c.id }),
        onCheck: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.setState((s) => ({ crChecked: Object.assign({}, s.crChecked, { [c.id]: !s.crChecked[c.id] }) })); },
        onStatus: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.setState((s) => ({ crStatus: Object.assign({}, s.crStatus, { [c.id]: crStatusNext[crStatusOf(c)] }) })); } };
    });

    const crSortOpt = (v, l) => ({ val: v, label: l, active: crSort === v, color: crSort === v ? '#f2f3f6' : '#94a3b8', bg: crSort === v ? '#2b2d36' : 'transparent', onClick: () => this.setState({ crSort: v }) });
    const crSorts = [crSortOpt('sev', 'Severity'), crSortOpt('cp', 'Critical path'), crSortOpt('cpdays', 'CP-days'), crSortOpt('id', 'Risk ID')];

    const crViewDefs = {
      'Planner': [{ l: 'On-CP — fix first', f: { crCP: 'cp', crSort: 'cp' } }, { l: 'Hot-work class', f: { crClass: 'Hot-work deconfliction' } }],
      'Zone Manager': [{ l: '4th Deck', f: { crDeck: '4th' } }, { l: 'High severity', f: { crSev: 'High' } }],
      'Production Super': [{ l: 'Threatens Undock', f: { crEvent: 'Undock' } }, { l: 'On-CP', f: { crCP: 'cp' } }],
      'Project Super': [{ l: 'CVN-73 PIA-26', f: { crAvail: 'CVN-73 PIA-26' } }, { l: 'High severity', f: { crSev: 'High' } }],
      'IPT': [{ l: 'Hot-work class', f: { crClass: 'Hot-work deconfliction' } }, { l: 'On-CP', f: { crCP: 'cp' } }],
      'Program Office': [{ l: 'High severity', f: { crSev: 'High' } }, { l: 'On-CP risk', f: { crCP: 'cp', crSort: 'cp' } }],
      'Material Manager': [{ l: 'Material timing', f: { crClass: 'Material timing' } }, { l: 'CVN-71 SRA-26', f: { crAvail: 'CVN-71 SRA-26' } }],
      'Executive': [{ l: 'High × On-CP', f: { crSev: 'High', crCP: 'cp' } }, { l: 'Cross-availability', f: { crClass: 'Cross-availability' } }],
    };
    const crResetFilters = { crClass: 'all', crSev: 'all', crCP: 'all', crDeck: 'all', crTrade: 'all', crAvail: 'all', crEvent: 'all', crSearch: '', crMatrix: null };
    const crViews = (crViewDefs[persona] || crViewDefs['Planner']).map((v, i) => ({ key: 'v' + i, label: v.l, onClick: () => this.setState(Object.assign({}, crResetFilters, v.f)) }));

    const crSelC = crSel ? crData.find((c) => c.id === crSel) : null;
    let crDetail = null;
    if (crSelC) {
      const st = crStatusOf(crSelC), sm = crStatusMeta[st], sev = crSevMeta[crSelC.sev];
      crDetail = { id: crSelC.id, cls: crSelC.cls, sev: crSelC.sev, sevColor: sev.c, sevBg: sev.bg, onCP: crSelC.onCP,
        comp: crSelC.comp, name: crSelC.name, frameDeck: crSelC.frame + ' · ' + crSelC.deck + ' Deck', avail: crSelC.avail, event: crSelC.event, trade: crSelC.trade,
        cpText: crSelC.cpText || (crSelC.cpDays > 0 ? '+' + crSelC.cpDays + ' CP-days' : '—'), statusLabel: sm.label, statusColor: sm.c, statusBg: sm.bg, owner: crOwnerOf(crSelC),
        why: crSelC.why, traces: crSelC.traces, mits: crSelC.mits.map((m, i) => ({ key: 'm' + i, t: m })), wiPair: crSelC.wiA + ' → ' + crSelC.wiB,
        hasOffline: !!(crSelC.offline && crSelC.offline.length),
        offline: (crSelC.offline || []).map((o, i) => ({ key: 'off' + i, t: o })),
        cutDecks: (crSelC.cutDecks || []).map((d, i) => ({ key: 'cd' + i, t: d })), offlineCount: (crSelC.offline || []).length,
        onClose: () => this.setState({ crSel: null }),
        onStudio: () => this.setState({ activeModule: 'mitigationStudio', crToast: crSelC.id + ' opened in Mitigation Studio' }) };
    }
    const crHasChecked = crCheckedIds.length > 0;

    // ===================== WORK ORDERS =====================
    const woData = this.woSeed();
    const woStatusList = ['Planned', 'Released', 'In-Work', 'Complete', 'On-Hold'];
    const woStatusMeta = {
      Planned: { c: '#94a3b8', bg: 'rgba(148,163,184,0.13)' },
      Released: { c: '#3D6BFF', bg: 'rgba(61,107,255,0.14)' },
      'In-Work': { c: '#f59e0b', bg: 'rgba(245,158,11,0.14)' },
      Complete: { c: '#22c55e', bg: 'rgba(34,197,94,0.14)' },
      'On-Hold': { c: '#dc2626', bg: 'rgba(220,38,38,0.14)' },
    };
    const woCritMeta = { High: { c: '#dc2626', bg: 'rgba(220,38,38,0.14)', rank: 3 }, Med: { c: '#f59e0b', bg: 'rgba(245,158,11,0.14)', rank: 2 }, Low: { c: '#94a3b8', bg: 'rgba(148,163,184,0.13)', rank: 1 } };
    const woTypeList = ['preservation', 'mechanical', 'electrical', 'structural', 'installation', 'rip-out', 'interference removal', 'lagging', 'hot work', 'test', 'button-up'];
    const woTradeList = ['Shop 71 Preservation', 'Shop 26 Welding', 'Shop 51 Electrical', 'Shop 31 Inside Machinists', 'Shop 11 Shipfitters'];
    const woDeckList = ['Main', 'O-2', '2nd', '3rd', '4th'];
    const woSystemList = Array.from(new Set(woData.map((w) => w.system))).sort();
    const woEventList = ['Undock', 'Fast Cruise', 'Sea Trials', 'Move-Aboard', 'Cross'];

    // column model
    const woColDefs = [
      { k: 'id', label: 'WO / AWR', w: 156, def: true },
      { k: 'title', label: 'Title', w: 236, def: true },
      { k: 'type', label: 'Work type', w: 132, def: true },
      { k: 'trade', label: 'Trade / Shop', w: 150, def: true },
      { k: 'comp', label: 'Compartment', w: 166, def: true },
      { k: 'system', label: 'System · ESWBS', w: 156, def: false },
      { k: 'frame', label: 'Frame · Zone', w: 116, def: false },
      { k: 'planned', label: 'Planned', w: 134, def: true },
      { k: 'depends', label: 'Pred / Succ', w: 124, def: false },
      { k: 'status', label: 'Status', w: 126, def: true },
      { k: 'mh', label: 'Est / Act MH', w: 110, def: false },
      { k: 'crit', label: 'Crit · CP', w: 96, def: false },
      { k: 'event', label: 'Key event', w: 126, def: false },
      { k: 'space', label: 'Space control', w: 150, def: false },
      { k: 'material', label: 'Material', w: 132, def: false },
      { k: 'conflicts', label: 'Conflicts', w: 116, def: true },
      { k: 'prov', label: 'Provenance', w: 150, def: false },
    ];
    const woColOn = (k) => { const v = woCols[k]; return v === undefined ? woColDefs.find((d) => d.k === k).def : v; };
    const woShow = {}; woColDefs.forEach((d) => { woShow[d.k] = woColOn(d.k); });
    const woShownDefs = woColDefs.filter((d) => woShow[d.k]);
    const woGridCols = '34px ' + woShownDefs.map((d) => d.w + 'px').join(' ') + ' 92px';
    const woMinWidth = (34 + 92 + woShownDefs.reduce((s, d) => s + d.w, 0)) + 'px';
    const woColChooser = woColDefs.map((d) => ({ key: d.k, label: d.label, on: woShow[d.k], star: d.def,
      dotBg: woShow[d.k] ? '#3D6BFF' : 'transparent', dotBorder: woShow[d.k] ? '#3D6BFF' : '#424656',
      txtColor: woShow[d.k] ? '#f2f3f6' : '#94a3b8',
      onClick: () => this.setState((s) => ({ woCols: Object.assign({}, s.woCols, { [d.k]: !(s.woCols[d.k] === undefined ? d.def : s.woCols[d.k]) }) })) }));

    const woMk = (arr, allLabel) => [{ val: 'all', label: allLabel }].concat(arr.map((v) => ({ val: v, label: v })));
    const woTypeOpts = woMk(woTypeList, 'All work types');
    const woTradeOpts = woMk(woTradeList, 'All trades / shops');
    const woDeckOpts = woMk(woDeckList, 'All decks');
    const woStatusOpts = woMk(woStatusList, 'All statuses');
    const woSystemOpts = woMk(woSystemList, 'All systems');
    const woEventOpts = woMk(woEventList, 'All key events');
    const woGrowthOpts = [{ val: 'all', label: 'Growth — all' }, { val: 'growth', label: 'Growth / new work' }, { val: 'base', label: 'Base scope' }];
    const woConflictOpts = [{ val: 'all', label: 'Conflicts — all' }, { val: 'has', label: 'Has conflict' }, { val: 'none', label: 'No conflict' }];
    const woMaterialOpts = [{ val: 'all', label: 'Material — all' }, { val: 'Ready', label: 'Ready' }, { val: 'Awaiting', label: 'Awaiting' }];
    const woSpaceOpts = [{ val: 'all', label: 'Space ctrl — all' }, { val: 'gasFree', label: 'Gas-free req' }, { val: 'hotWork', label: 'Hot-work chit' }, { val: 'tagOut', label: 'Tag-out (LOTO)' }, { val: 'confined', label: 'Confined space' }, { val: 'auth', label: 'Released for prod' }];

    const woQ = (woSearch || '').toLowerCase();
    let woRows = woData.filter((w) => {
      if (woType !== 'all' && w.type !== woType) return false;
      if (woTrade !== 'all' && w.trade !== woTrade) return false;
      if (woDeck !== 'all' && w.deck !== woDeck) return false;
      if (woStatus !== 'all' && w.status !== woStatus) return false;
      if (woSystem !== 'all' && w.system !== woSystem) return false;
      if (woEvent !== 'all' && w.event !== woEvent) return false;
      if (woGrowth === 'growth' && !w.growth) return false;
      if (woGrowth === 'base' && w.growth) return false;
      if (woConflict === 'has' && w.conflicts.length === 0) return false;
      if (woConflict === 'none' && w.conflicts.length > 0) return false;
      if (woMaterial !== 'all' && w.material !== woMaterial) return false;
      if (woSpace !== 'all' && !w.space[woSpace]) return false;
      if (woQ && !(w.id + ' ' + w.awr + ' ' + w.title + ' ' + w.type + ' ' + w.trade + ' ' + w.comps.join(' ') + ' ' + w.compName + ' ' + w.system + ' ' + w.conflicts.join(' ') + ' ' + w.originator).toLowerCase().includes(woQ)) return false;
      return true;
    });
    const woWeekNum = (s) => { const m = /W(\d+)/.exec(s || ''); return m ? parseInt(m[1], 10) : 999; };
    woRows = woRows.slice().sort((a, b) => {
      if (woSort === 'title') return a.title.localeCompare(b.title);
      if (woSort === 'status') return woStatusList.indexOf(a.status) - woStatusList.indexOf(b.status) || a.id.localeCompare(b.id);
      if (woSort === 'planned') return woWeekNum(a.start) - woWeekNum(b.start) || a.id.localeCompare(b.id);
      if (woSort === 'mh') return b.estMH - a.estMH;
      if (woSort === 'variance') return (evVarById[a.id] || 0) - (evVarById[b.id] || 0);
      if (woSort === 'crit') return (woCritMeta[b.crit].rank - woCritMeta[a.crit].rank) || ((b.onCP ? 1 : 0) - (a.onCP ? 1 : 0));
      return a.id.localeCompare(b.id);
    });
    const woCheckedIds = Object.keys(woChecked).filter((k) => woChecked[k]);

    // summary (over full register, current availability scope)
    const woTotal = woData.length;
    const woByStatus = woStatusList.map((s) => ({ key: s, label: s, count: woData.filter((w) => w.status === s).length, c: woStatusMeta[s].c }));
    const woVerified = woData.filter((w) => w.verified).length;
    const woPctVerified = Math.round((woVerified / woTotal) * 100);
    const woOpenConf = woData.filter((w) => w.conflicts.length > 0).length;
    const woTotalMH = woData.reduce((s, w) => s + w.estMH, 0);
    const woGrowthCount = woData.filter((w) => w.growth).length;
    const woAwaitCount = woData.filter((w) => w.material === 'Awaiting').length;
    const woNeedsVerify = woData.filter((w) => !w.verified || w.conf < 0.85).length;
    const woSummary = {
      total: woTotal, pctVerified: woPctVerified + '%', verifiedDetail: woVerified + ' / ' + woTotal + ' verified',
      openConf: woOpenConf, totalMH: woTotalMH.toLocaleString(), growth: woGrowthCount, awaiting: woAwaitCount, needsVerify: woNeedsVerify,
      byStatus: woByStatus,
      behindN: evBehind.length, behindMH: evShortfall,
    };

    const spaceShort = (w) => {
      const out = [];
      if (w.space.gasFree) out.push({ k: 'GF', label: 'Gas-free', c: '#22c55e' });
      if (w.space.hotWork) out.push({ k: 'HW', label: 'Hot-work chit', c: '#dc2626' });
      if (w.space.tagOut) out.push({ k: 'TO', label: 'Tag-out', c: '#f59e0b' });
      if (w.space.confined) out.push({ k: 'CS', label: 'Confined', c: '#3D6BFF' });
      return out;
    };
    const woFmtRow = (w) => {
      const sm = woStatusMeta[w.status], cm = woCritMeta[w.crit];
      return {
        key: w.id, id: w.id, awr: w.awr, title: w.title, type: w.type,
        trade: w.trade, tradeShort: w.trade.replace('Shop ', ''),
        comp: w.comps.join(', '), compName: w.compName, deck: w.deck, zone: w.zone,
        system: w.system, frame: w.frame, planned: w.start + ' → ' + w.finish, dur: w.dur,
        preds: w.preds.length ? w.preds.join(', ') : '—', succs: w.succs.length ? w.succs.join(', ') : '—',
        status: w.status, statusColor: sm.c, statusBg: sm.bg, pct: w.pct, pctText: w.pct + '%', pctW: w.pct + '%',
        estMH: w.estMH, actMH: w.actMH, mhText: w.estMH + ' / ' + (w.actMH || 0),
        crit: w.crit, critColor: cm.c, critBg: cm.bg, onCP: w.onCP,
        event: w.event, growth: w.growth,
        spaceChips: spaceShort(w).map((s, i) => ({ key: w.id + 's' + i, label: s.k, title: s.label, c: s.c })),
        material: w.material, materialAwait: w.material === 'Awaiting', materialNeed: w.materialNeed,
        materialColor: w.material === 'Awaiting' ? '#f59e0b' : '#22c55e',
        conflicts: w.conflicts.join(', '), hasConflict: w.conflicts.length > 0,
        conf: w.conf, confPct: Math.round(w.conf * 100) + '%', confColor: w.conf >= 0.9 ? '#22c55e' : w.conf >= 0.85 ? '#f59e0b' : '#dc2626',
        needsVerify: !w.verified || w.conf < 0.85, verified: w.verified || '—', ingested: w.ingested, originator: w.originator,
        checked: !!woChecked[w.id], checkBg: woChecked[w.id] ? '#3D6BFF' : 'transparent', checkBorder: woChecked[w.id] ? '#3D6BFF' : '#424656',
        sel: woSel === w.id, rowBg: woSel === w.id ? '#20222b' : 'transparent',
        onRow: () => this.setState({ woSel: w.id, woDetailTab: 'overview' }),
        onCheck: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.setState((s) => ({ woChecked: Object.assign({}, s.woChecked, { [w.id]: !s.woChecked[w.id] }) })); },
        onSource: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.setState({ woSourceId: w.id }); },
      };
    };

    // grouping
    const woGrouped = woGroup !== 'none';
    const woGroupKeyer = { comp: (w) => w.comps[0], trade: (w) => w.trade, system: (w) => w.system, status: (w) => w.status };
    let woGroups;
    if (woGrouped) {
      const keyer = woGroupKeyer[woGroup];
      const map = {};
      woRows.forEach((w) => { const k = keyer(w); (map[k] = map[k] || []).push(w); });
      woGroups = Object.keys(map).sort().map((k) => ({ key: 'g-' + k, label: k, count: map[k].length, rows: map[k].map(woFmtRow) }));
    } else {
      woGroups = [{ key: 'all', label: '', count: woRows.length, rows: woRows.map(woFmtRow) }];
    }

    const woSortOpt = (v, l) => ({ val: v, label: l, active: woSort === v, color: woSort === v ? '#f2f3f6' : '#94a3b8', bg: woSort === v ? '#2b2d36' : 'transparent', onClick: () => this.setState({ woSort: v }) });
    const woSorts = [woSortOpt('id', 'WO ID'), woSortOpt('planned', 'Planned'), woSortOpt('status', 'Status'), woSortOpt('crit', 'Criticality'), woSortOpt('mh', 'Man-hours'), woSortOpt('variance', 'EV variance')];
    const woGroupOpt = (v, l) => ({ val: v, label: l, active: woGroup === v, color: woGroup === v ? '#f2f3f6' : '#94a3b8', bg: woGroup === v ? '#2b2d36' : 'transparent', onClick: () => this.setState({ woGroup: v }) });
    const woGroupSel = [woGroupOpt('none', 'None'), woGroupOpt('comp', 'Compartment'), woGroupOpt('trade', 'Trade'), woGroupOpt('system', 'System'), woGroupOpt('status', 'Status')];

    const woViewDefs = {
      'Planner': [{ l: 'On-CP work', f: { woConflict: 'has', woSort: 'crit' } }, { l: 'Hot work', f: { woType: 'hot work' } }],
      'Zone Manager': [{ l: '4th Deck', f: { woDeck: '4th' } }, { l: 'In-work now', f: { woStatus: 'In-Work' } }],
      'Production Super': [{ l: 'Released only', f: { woStatus: 'Released' } }, { l: 'Threatens Undock', f: { woEvent: 'Undock' } }],
      'Material Manager': [{ l: 'Awaiting material', f: { woMaterial: 'Awaiting' } }, { l: 'Growth work', f: { woGrowth: 'growth' } }],
      'IPT': [{ l: 'Has conflict', f: { woConflict: 'has' } }, { l: 'Hot work', f: { woType: 'hot work' } }],
      'Program Office': [{ l: 'Needs verification', f: { woConflict: 'all', woSort: 'id' } }, { l: 'Growth work', f: { woGrowth: 'growth' } }],
      'Project Super': [{ l: 'In-work now', f: { woStatus: 'In-Work' } }, { l: 'On-hold', f: { woStatus: 'On-Hold' } }],
      'Executive': [{ l: 'Growth work', f: { woGrowth: 'growth' } }, { l: 'Awaiting material', f: { woMaterial: 'Awaiting' } }],
    };
    const woResetFilters = { woType: 'all', woTrade: 'all', woDeck: 'all', woStatus: 'all', woSystem: 'all', woEvent: 'all', woGrowth: 'all', woConflict: 'all', woMaterial: 'all', woSpace: 'all', woSearch: '' };
    const woViews = (woViewDefs[persona] || woViewDefs['Planner']).map((v, i) => ({ key: 'wv' + i, label: v.l, onClick: () => this.setState(Object.assign({}, woResetFilters, v.f)) }));

    const woRowMinH = woDensity === 'compact' ? '38px' : '54px';
    const woRowPadY = woDensity === 'compact' ? '0' : '7px';
    const woDensityComfy = woDensity === 'comfortable';

    // detail
    const woSelW = woSel ? woData.find((w) => w.id === woSel) : null;
    let woDetail = null;
    if (woSelW) {
      const w = woSelW, sm = woStatusMeta[w.status], cm = woCritMeta[w.crit];
      const tabDef = [['overview', 'Overview'], ['deps', 'Dependencies'], ['space', 'Space & Access'], ['material', 'Material'], ['conflicts', 'Conflicts'], ['source', 'Source Doc']];
      woDetail = {
        id: w.id, awr: w.awr, title: w.title, type: w.type, trade: w.trade, comp: w.comps.join(', '), compName: w.compName,
        deck: w.deck, zone: w.zone, frame: w.frame, system: w.system, planned: w.start + ' → ' + w.finish, dur: w.dur,
        status: w.status, statusColor: sm.c, statusBg: sm.bg, pct: w.pct, pctText: w.pct + '%', pctW: w.pct + '%',
        estMH: w.estMH, actMH: w.actMH, crit: w.crit, critColor: cm.c, critBg: cm.bg, onCP: w.onCP, event: w.event, growth: w.growth,
        preds: (w.preds.length ? w.preds : ['—']).map((p, i) => ({ key: 'p' + i, t: p })), succs: (w.succs.length ? w.succs : ['—']).map((s, i) => ({ key: 's' + i, t: s })),
        spaceReqs: [
          { key: 'gf', label: 'Gas-free certificate', on: w.space.gasFree }, { key: 'hw', label: 'Hot-work permit (chit)', on: w.space.hotWork },
          { key: 'to', label: 'Tag-out (LOTO)', on: w.space.tagOut }, { key: 'cs', label: 'Confined-space entry', on: w.space.confined },
          { key: 'au', label: 'Released for production', on: w.space.auth },
        ].map((r) => ({ ...r, c: r.on ? '#22c55e' : '#6e7480', mark: r.on ? '✓' : '—', txt: r.on ? '#f2f3f6' : '#6e7480' })),
        material: w.material, materialAwait: w.material === 'Awaiting', materialNeed: w.materialNeed, materialColor: w.material === 'Awaiting' ? '#f59e0b' : '#22c55e',
        matList: w.matList.map((m, i) => ({ key: 'ml' + i, t: m })),
        conflicts: w.conflicts.map((c, i) => ({ key: 'c' + i, id: c, onClick: () => this.setState({ activeModule: 'conflictsRisk', crSel: c, woSel: null }) })),
        hasConflict: w.conflicts.length > 0,
        conf: w.conf, confPct: Math.round(w.conf * 100) + '%', confColor: w.conf >= 0.9 ? '#22c55e' : w.conf >= 0.85 ? '#f59e0b' : '#dc2626',
        needsVerify: !w.verified || w.conf < 0.85, verified: w.verified || 'Not verified', ingested: w.ingested, originator: w.originator, desc: w.desc,
        refs: w.refs.map((r, i) => ({ key: 'r' + i, t: r })), qa: w.qa.map((q, i) => ({ key: 'q' + i, t: q })),
        tabs: tabDef.map(([id, label]) => ({ key: id, id, label, active: woDetailTab === id, color: woDetailTab === id ? '#f2f3f6' : '#94a3b8', bb: woDetailTab === id ? '#3D6BFF' : 'transparent', onClick: () => this.setState({ woDetailTab: id }) })),
        tabOverview: woDetailTab === 'overview', tabDeps: woDetailTab === 'deps', tabSpace: woDetailTab === 'space', tabMaterial: woDetailTab === 'material', tabConflicts: woDetailTab === 'conflicts', tabSource: woDetailTab === 'source',
        onClose: () => this.setState({ woSel: null }),
        onSource: () => this.setState({ woSourceId: w.id }),
        onSeq: () => this.setState({ activeModule: 'sequenceBoard', woToast: w.id + ' located on Sequence Board' }),
        onDeck: () => this.setState({ activeModule: 'deckExplorer', deDeck: w.deck === 'Main' ? '4th' : w.deck.replace(/[^0-9]/g, '') ? w.deck : '4th', woToast: w.id + ' located on Deck Explorer' }),
      };
    }

    // source document overlay
    const woSrcW = woSourceId ? woData.find((w) => w.id === woSourceId) : null;
    let woSource = null;
    if (woSrcW) {
      const w = woSrcW;
      const fields = [
        { key: 'f1', label: 'AWR / JCN', extracted: w.awr, source: w.awr },
        { key: 'f2', label: 'Title', extracted: w.title, source: w.srcTitle },
        { key: 'f3', label: 'Compartment', extracted: w.comps.join(', ') + ' · ' + w.compName, source: w.srcComp },
        { key: 'f4', label: 'System (ESWBS)', extracted: w.system, source: w.system.split(' ')[0] },
        { key: 'f5', label: 'Trade / Shop', extracted: w.trade, source: w.trade.replace('Shop ', '') },
        { key: 'f6', label: 'Est. man-hours', extracted: w.estMH + ' MH', source: w.estMH + ' MHRS' },
        { key: 'f7', label: 'Key-event tie', extracted: w.event, source: w.event === '—' ? '(none)' : w.event.toUpperCase() },
      ];
      woSource = {
        id: w.id, awr: w.awr, title: w.title, hull: 'CVN-73 · PIA-26', comp: w.comps.join(', '), compName: w.compName, system: w.system, trade: w.trade, estMH: w.estMH,
        desc: w.desc, refs: w.refs.map((r, i) => ({ key: 'sr' + i, t: r })), qa: w.qa.map((q, i) => ({ key: 'sq' + i, t: q })), matList: w.matList.map((m, i) => ({ key: 'sm' + i, t: m })),
        event: w.event, originator: w.originator, ingested: w.ingested, conf: w.conf, confPct: Math.round(w.conf * 100) + '%', confColor: w.conf >= 0.9 ? '#22c55e' : w.conf >= 0.85 ? '#f59e0b' : '#dc2626',
        gasFree: w.space.gasFree ? 'Required' : 'Not required', hotWork: w.space.hotWork ? 'Required (chit)' : 'Not required', tagOut: w.space.tagOut ? 'Required (LOTO)' : 'Not required',
        fields,
        onClose: () => this.setState({ woSourceId: null }),
        onPrint: () => { if (typeof window !== 'undefined' && window.print) window.print(); },
      };
    }

    const woCount = woGroups.reduce((s, g) => s + g.rows.length, 0);
    const woHasChecked = woCheckedIds.length > 0;

    // ===================== YARD & RESOURCES =====================
    const WKS = 24; // timeline weeks
    const wkX = (w) => ((Math.max(1, Math.min(WKS, w)) - 1) / (WKS - 1)) * 100;
    const yrSelType = yrSel ? yrSel.split(':')[0] : null;
    const yrSelId = yrSel ? yrSel.split(':')[1] : null;
    const yrPick = (t, id) => () => this.setState((s) => ({ yrSel: (s.yrSel === t + ':' + id ? null : t + ':' + id) }));

    // docks / berths — full constraint specs (drives both the NNSY map and the inspector)
    const dockDefs = this.berthData();
    const yrConstraintRows = dockDefs.map((d) => {
      const fit = this.berthFit(d);
      return { key: d.id, id: d.id, name: d.name, kind: d.kind === 'drydock' ? 'Graving dry dock' : 'Pier / quaywall', hull: d.hull,
        depth: d.depth, draft: d.draft, length: d.pierLength, shore: d.shore.voltage + ' · ' + (d.shore.capacityKW / 1000).toFixed(1) + ' MW',
        crane: d.crane, coldIron: d.shore.coldIron ? 'Yes' : 'No', nesting: d.nesting,
        fit: fit.verdict, fitColor: fit.color, sel: yrSel === 'dock:' + d.id, rowBg: yrSel === 'dock:' + d.id ? '#20222b' : 'transparent',
        onClick: yrPick('dock', d.id) };
    });

    // resource lanes (bookable timeline)
    const hullColor = { 'CVN-73': '#3D6BFF', 'CVN-71': '#22c55e', 'CVN-75': '#a78bfa' };
    const laneDefs = [
      { id: 'DD4', label: 'Dry Dock 4 window', kind: 'dock', bookings: [ { hull: 'CVN-73', wi: 'Docked availability', s: 1, e: 22 } ], markers: [ { w: 21, label: 'Flood-up' }, { w: 22, label: 'Undock' } ] },
      { id: 'PC12', label: 'Portal Crane 12', kind: 'crane', bookings: [ { hull: 'CVN-73', wi: 'WI-3318 module lift', s: 3, e: 6 }, { hull: 'CVN-75', wi: 'WI-8800 prep lift', s: 12, e: 16 } ] },
      { id: 'PC14', label: 'Portal Crane 14', kind: 'crane', bookings: [ { hull: 'CVN-73', wi: 'WI-4471 uptake module', s: 6, e: 9 }, { hull: 'CVN-71', wi: 'WI-7110 mast section', s: 8, e: 11 } ] },
      { id: 'LA', label: 'Lay-down Apron A', kind: 'laydown', bookings: [ { hull: 'CVN-73', wi: 'Staging & rip-out', s: 2, e: 12 } ] },
      { id: 'LB', label: 'Lay-down Apron B', kind: 'laydown', bookings: [ { hull: 'CVN-71', wi: 'Mast / topside', s: 7, e: 14 }, { hull: 'CVN-75', wi: 'Pre-stage', s: 15, e: 20 } ] },
      { id: 'S71', label: 'Shop 71 Preservation', kind: 'shop', bookings: [ { hull: 'CVN-73', wi: 'Tank & deck coat', s: 2, e: 13 }, { hull: 'CVN-71', wi: 'Topside coat', s: 9, e: 16 } ] },
      { id: 'S26', label: 'Shop 26 Welding', kind: 'shop', bookings: [ { hull: 'CVN-73', wi: 'Hull / hot work', s: 6, e: 12 }, { hull: 'CVN-71', wi: 'Structural', s: 8, e: 13 } ] },
    ];
    // contention: overlapping bookings from different hulls on the same lane
    const contentions = [];
    laneDefs.forEach((ln) => {
      for (let i = 0; i < ln.bookings.length; i++) for (let j = i + 1; j < ln.bookings.length; j++) {
        const a = ln.bookings[i], b = ln.bookings[j];
        const os = Math.max(a.s, b.s), oe = Math.min(a.e, b.e);
        if (oe >= os && a.hull !== b.hull) {
          a._c = true; b._c = true;
          contentions.push({ lane: ln.id, laneLabel: ln.label, kind: ln.kind, a: a.hull, b: b.hull, s: os, e: oe, weeks: oe - os + 1, wiA: a.wi, wiB: b.wi });
        }
      }
    });
    const yrLanes = laneDefs.map((ln) => ({
      key: ln.id, id: ln.id, label: ln.label, kind: ln.kind,
      sel: yrSel === 'res:' + ln.id, onClick: yrPick('res', ln.id),
      rowBg: yrSel === 'res:' + ln.id ? 'rgba(61,107,255,0.08)' : 'transparent',
      bookings: ln.bookings.map((b, i) => ({ key: ln.id + i, hull: b.hull, wi: b.wi, left: wkX(b.s) + '%', width: (wkX(b.e) - wkX(b.s)) + '%',
        bg: b._c ? 'repeating-linear-gradient(45deg,' + hullColor[b.hull] + ' 0 7px,rgba(220,38,38,0.55) 7px 14px)' : hullColor[b.hull],
        color: hullColor[b.hull], contention: !!b._c, label: b.hull })),
      markers: (ln.markers || []).map((m, i) => ({ key: ln.id + 'm' + i, left: wkX(m.w) + '%', label: m.label, critical: m.label === 'Undock' })),
    }));
    const yrWeekTicks = [1, 5, 9, 13, 17, 21, 24].map((w) => ({ key: 'wk' + w, left: wkX(w) + '%', label: 'W' + w }));
    const yrContentionList = contentions.map((c, i) => ({ key: 'ct' + i, laneLabel: c.laneLabel, a: c.a, b: c.b, window: 'W' + c.s + '–W' + c.e, weeks: c.weeks + ' wk',
      detail: c.a + ' (' + c.wiA + ') vs ' + c.b + ' (' + c.wiB + ')', onClick: yrPick('res', c.lane) }));

    // supply chain / critical material
    const supStatusMeta = { on_track: { label: 'On track', c: '#22c55e', bg: 'rgba(34,197,94,0.14)' }, at_risk: { label: 'At risk', c: '#f59e0b', bg: 'rgba(245,158,11,0.14)' }, delayed: { label: 'Delayed', c: '#dc2626', bg: 'rgba(220,38,38,0.14)' }, not_contracted: { label: 'Not on contract', c: '#94a3b8', bg: 'rgba(148,163,184,0.14)' } };
    const matDefs = this.supplyData().filter((m) => yrHull === 'all' || m.hull === yrHull);
    const supCounts = { on_track: 0, at_risk: 0, delayed: 0, not_contracted: 0 };
    matDefs.forEach((m) => { supCounts[m.status]++; });
    const supPills = ['on_track', 'at_risk', 'delayed', 'not_contracted'].map((k) => ({ key: k, val: k, label: supStatusMeta[k].label, count: supCounts[k], c: supStatusMeta[k].c,
      active: yrSupplyStatus === k, bg: yrSupplyStatus === k ? supStatusMeta[k].bg : 'transparent', border: yrSupplyStatus === k ? supStatusMeta[k].c : '#2b2d36',
      onClick: () => this.setState((s) => ({ yrSupplyStatus: s.yrSupplyStatus === k ? 'all' : k })) }));
    const matRows = matDefs.filter((m) => yrSupplyStatus === 'all' || m.status === yrSupplyStatus).map((m) => {
      const sm = supStatusMeta[m.status];
      const slip = (m.status === 'at_risk' || m.status === 'delayed') ? (m.onDock - m.need) : 0;
      return { key: m.id, id: m.id, name: m.name, wi: m.wi, supplier: m.supplier + ' · ' + m.city, lead: m.lead ? m.lead + ' wk' : '—',
        onDock: m.onDock ? 'W' + m.onDock : 'TBD', need: m.need ? 'W' + m.need : '—', statusLabel: sm.label, statusColor: sm.c, statusBg: sm.bg,
        slipText: slip > 0 ? '+' + slip + ' wk late' : (m.status === 'not_contracted' ? 'unscheduled' : 'on/ahead'), slipColor: slip > 0 ? '#dc2626' : (m.status === 'not_contracted' ? '#94a3b8' : '#22c55e'),
        res: m.res, note: m.note, sel: yrSel === 'mat:' + m.id, rowBg: yrSel === 'mat:' + m.id ? '#20222b' : 'transparent', onClick: yrPick('mat', m.id) };
    });
    const supLate = matDefs.filter((m) => m.status === 'delayed' || m.status === 'at_risk').length;
    const supExposure = { late: supLate, notContracted: supCounts.not_contracted, cpDays: 7, onCP: matDefs.filter((m) => m.wi === 'WI-3402' || m.wi === 'WI-1905').length };

    // tabs
    const yrTabDefs = [['map', 'Yard Map'], ['lanes', 'Resource Lanes'], ['supply', 'Supply Chain']];
    const yrTabs = yrTabDefs.map(([id, label]) => ({ key: id, id, label, active: yrTab === id, color: yrTab === id ? '#f2f3f6' : '#94a3b8', bb: yrTab === id ? '#3D6BFF' : 'transparent', onClick: () => this.setState({ yrTab: id }) }));

    // contextual inspector detail
    let yrDetail = null;
    if (yrSelType === 'dock') {
      const d = dockDefs.find((x) => x.id === yrSelId);
      if (d) { const dfit = this.berthFit(d); yrDetail = { kind: 'dock', isDock: true, isRes: false, isMat: false, title: d.name, sub: d.hull + ' · ' + d.ship, status: d.status, statusColor: d.statusColor,
        fitVerdict: dfit.verdict, fitColor: dfit.color, fitLimit: dfit.limit,
        rows: [ { k: 'Availability', v: d.avail }, { k: 'Dry-dock window', v: d.dryWindow }, { k: 'Depth', v: d.depth }, { k: 'Draft', v: d.draft }, { k: 'Sill', v: d.sill }, { k: 'Berth length', v: d.pierLength }, { k: 'Nesting', v: d.nesting }, { k: 'Crane service', v: d.crane }, { k: 'Shore power', v: d.shore.voltage + ' · ' + (d.shore.capacityKW / 1000).toFixed(1) + ' MW' }, { k: 'Cold-iron', v: d.shore.coldIron ? 'Capable' : 'No' }, { k: 'Deck load rating', v: d.loadRating }, { k: 'Lay-down', v: d.laydown }, { k: 'Dewater / flood', v: d.pumpDown } ].map((r, i) => ({ key: 'dr' + i, ...r })),
        utils: Object.keys(d.utils).map((k, i) => ({ key: 'u' + i, k, v: d.utils[k] })),
        gate: d.gate, gateWhen: d.gateWhen, tie: d.tie, ties: d.ties.map((t, i) => ({ key: 't' + i, t })),
        onClose: () => this.setState({ yrSel: null }),
        onSeq: () => this.setState({ activeModule: 'sequenceBoard', woToast: d.hull + ' dock-dry gate opened on Sequence Board' }) }; }
    } else if (yrSelType === 'res') {
      const ln = laneDefs.find((x) => x.id === yrSelId);
      const _geo = this.yardGeo();
      const cr = _geo.cranes.find((x) => x.id === yrSelId);
      const lyd = _geo.laydowns.find((x) => x.id === yrSelId);
      const label = ln ? ln.label : (cr ? cr.label : (lyd ? lyd.label : yrSelId));
      const bookings = ln ? ln.bookings.map((b, i) => ({ key: 'b' + i, hull: b.hull, wi: b.wi, window: 'W' + b.s + '–W' + b.e, color: hullColor[b.hull], contention: !!b._c })) : [];
      const cts = contentions.filter((c) => c.lane === yrSelId).map((c, i) => ({ key: 'c' + i, a: c.a, b: c.b, window: 'W' + c.s + '–W' + c.e, weeks: c.weeks + ' wk', wiA: c.wiA, wiB: c.wiB }));
      yrDetail = { kind: 'res', isDock: false, isRes: true, isMat: false, title: label, sub: 'Bookable resource', bookings, hasBookings: bookings.length > 0, cts, hasCts: cts.length > 0,
        onClose: () => this.setState({ yrSel: null }),
        onSeq: () => this.setState({ activeModule: 'sequenceBoard', woToast: label + ' contention opened on Sequence Board' }) };
    } else if (yrSelType === 'mat') {
      const m = matDefs.find((x) => x.id === yrSelId);
      if (m) { const sm = supStatusMeta[m.status]; yrDetail = { kind: 'mat', isDock: false, isRes: false, isMat: true, title: m.name, sub: m.id + ' · ' + m.wi, status: sm.label, statusColor: sm.c,
        rows: [ { k: 'Supplier', v: m.supplier }, { k: 'Origin', v: m.city }, { k: 'Lead time', v: m.lead ? m.lead + ' wk' : '—' }, { k: 'On dock', v: m.onDock ? 'W' + m.onDock : 'TBD' }, { k: 'Need date', v: m.need ? 'W' + m.need : '—' }, { k: 'Resource', v: m.res } ].map((r, i) => ({ key: 'mr' + i, ...r })),
        note: m.note, wi: m.wi,
        onClose: () => this.setState({ yrSel: null }),
        onWO: () => this.setState({ activeModule: 'workOrders', woSearch: m.wi, woSel: null }) }; }
    }

    return {
      // yard & resources
      yrActive, yrTab, yrTabs, yrTabMap: yrTab === 'map', yrTabLanes: yrTab === 'lanes', yrTabSupply: yrTab === 'supply',
      yrConstraintRows, mapRef: this._mapRef,
      yrCrane, yrLaydown, yrShore,
      toggleYrCrane: () => this.setState((s) => ({ yrCrane: !s.yrCrane })), toggleYrLaydown: () => this.setState((s) => ({ yrLaydown: !s.yrLaydown })), toggleYrShore: () => this.setState((s) => ({ yrShore: !s.yrShore })),
      yrCraneColor: yrCrane ? '#3D6BFF' : '#94a3b8', yrCraneBg: yrCrane ? '#20222b' : 'transparent',
      yrEdit, yrEditColor: yrEdit ? '#0b0c0e' : '#94a3b8', yrEditBg: yrEdit ? '#3D6BFF' : 'transparent',
      yrSupplyLines, toggleYrSupplyLines: () => this.setState((s) => ({ yrSupplyLines: !s.yrSupplyLines })),
      yrSupplyLinesColor: yrSupplyLines ? '#3D6BFF' : '#94a3b8', yrSupplyLinesBg: yrSupplyLines ? '#20222b' : 'transparent',
      yrMapFull, toggleYrMapFull: () => this.setState((s) => ({ yrMapFull: !s.yrMapFull })),
      yrMapFullLabel: yrMapFull ? '\u2715 Collapse' : '\u2922 Expand',
      yrMapWrapStyle: yrMapFull
        ? 'position:fixed;inset:0;z-index:500;border:none;border-radius:0;height:100vh;background:#06121f;'
        : 'position:relative;border:1px solid #2b2d36;border-radius:8px;box-shadow:0 1px 0 rgba(255,255,255,0.04) inset,0 2px 14px rgba(0,0,0,0.4);overflow:hidden;height:480px;',
      yrFitNetwork: () => { if (this._map) this._fitNetwork(); },
      yrFitYard: () => { if (this._map) { const g = this.yardGeo(); this._map.setView(g.center, g.zoom); } },
      yrCritOnly, toggleYrCritOnly: () => this.setState((s) => ({ yrCritOnly: !s.yrCritOnly })),
      yrCritOnlyColor: yrCritOnly ? '#0b0c0e' : '#94a3b8', yrCritOnlyBg: yrCritOnly ? '#f59e0b' : 'transparent',
      yrHull, setYrHull: (h) => this.setState({ yrHull: h }),
      yrHullSeg: [['all', 'All hulls'], ['CVN-73', 'CVN-73'], ['CVN-71', 'CVN-71'], ['CVN-75', 'CVN-75']].map(([v, l]) => ({ key: v, val: v, label: l, active: yrHull === v, color: yrHull === v ? '#f2f3f6' : '#94a3b8', bg: yrHull === v ? '#2b2d36' : 'transparent', onClick: () => this.setState({ yrHull: v }) })),
      toggleYrEdit: () => this.setState((s) => ({ yrEdit: !s.yrEdit })),
      yrResetLayout: () => { this._resetPlace(); },
      yrLaydownColor: yrLaydown ? '#3D6BFF' : '#94a3b8', yrLaydownBg: yrLaydown ? '#20222b' : 'transparent',
      yrShoreColor: yrShore ? '#3D6BFF' : '#94a3b8', yrShoreBg: yrShore ? '#20222b' : 'transparent',
      yrLanes, yrWeekTicks, yrContentionList, yrContentionCount: contentions.length, yrHasContention: contentions.length > 0,
      supPills, matRows, supExposure, yrSupplyStatus,
      yrSupplyAll: () => this.setState({ yrSupplyStatus: 'all' }),
      yrDetail, yrHasDetail: !!yrDetail,
      // work orders
      woActive, woGroups, woGrouped, woSummary, woColChooser, woColsOpen, woShow, woGridCols, woMinWidth,
      woTypeOpts, woTradeOpts, woDeckOpts, woStatusOpts, woSystemOpts, woEventOpts, woGrowthOpts, woConflictOpts, woMaterialOpts, woSpaceOpts,
      woType, woTrade, woDeck, woStatus, woSystem, woEvent, woGrowth, woConflict, woMaterial, woSpace, woSearch,
      setWoType: (e) => this.setState({ woType: e.target.value }), setWoTrade: (e) => this.setState({ woTrade: e.target.value }),
      setWoDeck: (e) => this.setState({ woDeck: e.target.value }), setWoStatus: (e) => this.setState({ woStatus: e.target.value }),
      setWoSystem: (e) => this.setState({ woSystem: e.target.value }), setWoEvent: (e) => this.setState({ woEvent: e.target.value }),
      setWoGrowth: (e) => this.setState({ woGrowth: e.target.value }), setWoConflict: (e) => this.setState({ woConflict: e.target.value }),
      setWoMaterial: (e) => this.setState({ woMaterial: e.target.value }), setWoSpace: (e) => this.setState({ woSpace: e.target.value }),
      setWoSearch: (e) => this.setState({ woSearch: e.target.value }),
      woResetAll: () => this.setState(woResetFilters),
      woSorts, woGroupSel, woViews, woCount, woTotal,
      woDensityComfy, woRowMinH, woRowPadY,
      toggleWoDensity: () => this.setState((s) => ({ woDensity: s.woDensity === 'comfortable' ? 'compact' : 'comfortable' })),
      toggleWoCols: () => this.setState((s) => ({ woColsOpen: !s.woColsOpen })),
      woCheckedCount: woCheckedIds.length, woHasChecked,
      woExport: () => this.setState({ woToast: (woCheckedIds.length || woCount) + ' work orders exported (CSV) & routed to planning' }),
      woRoute: () => this.setState({ woToast: woCheckedIds.length + ' work orders routed to Sequence Board' }),
      woClearChecked: () => this.setState({ woChecked: {} }),
      woDetail, woHasDetail: !!woDetail,
      woSource, woHasSource: !!woSource,
      woToast, woHasToast: !!woToast, woClearToast: () => this.setState({ woToast: null }),
      // distributed packages
      dpActive, dp,
      // conflicts & risk
      crActive, crMatrixRows, crRowsR, crSorts, crViews,
      crClassOpts, crDeckOpts, crTradeOpts, crAvailOpts, crEventOpts, crSevOpts, crCpOpts,
      crClass, crSev, crCP, crDeck, crTrade, crAvail, crEvent, crSearch,
      setCrClass: (e) => this.setState({ crClass: e.target.value }), setCrSev: (e) => this.setState({ crSev: e.target.value }),
      setCrCP: (e) => this.setState({ crCP: e.target.value }), setCrDeck: (e) => this.setState({ crDeck: e.target.value }),
      setCrTrade: (e) => this.setState({ crTrade: e.target.value }), setCrAvail: (e) => this.setState({ crAvail: e.target.value }),
      setCrEvent: (e) => this.setState({ crEvent: e.target.value }), setCrSearch: (e) => this.setState({ crSearch: e.target.value }),
      crResetAll: () => this.setState(crResetFilters),
      crCount: crRowsR.length, crTotal: crData.length,
      crCheckedCount: crCheckedIds.length, crHasChecked,
      crAssign: () => this.setState((s) => { const o = Object.assign({}, s.crOwner); crCheckedIds.forEach((id) => o[id] = 'You · ' + persona); return { crOwner: o, crToast: crCheckedIds.length + ' conflict(s) assigned to you', crChecked: {} }; }),
      crRoute: () => this.setState((s) => { const st = Object.assign({}, s.crStatus); crCheckedIds.forEach((id) => st[id] = 'validated'); return { crStatus: st, crToast: crCheckedIds.length + ' conflict(s) routed to IPT', crChecked: {} }; }),
      crClearChecked: () => this.setState({ crChecked: {} }),
      crDetail, crHasDetail: !!crDetail,
      crToast: this.state.crToast, crHasToast: !!this.state.crToast, crClearToast: () => this.setState({ crToast: null }),

      sbActive, sbGroupSel, sbGroupsR, sbContentH, sbGates, sbWeeks, sbConnectors, sbNowPct, sbNowLabel,
      // week plan (B2) + saturation (L4)
      sbAvailView, sbWeekView, sbSatView, sbViewSeg, sbWeekOrSat: sbWeekView || sbSatView,
      satRows, satWork, satDetail, satHasDetail: !!satDetail,
      // mitigation studio — recovery horizons
      msActive, msCols, msBehindN: evBehind.length, msBehindMH: evShortfall, msHasBehind: evBehind.length > 0, msDonorTxt,
      msToast: this.state.msToast, msHasToast: !!this.state.msToast, msClearToast: () => this.setState({ msToast: null }),
      msGoWO: () => this.setState({ activeModule: 'workOrders', woSort: 'variance', woStatus: 'In-Work' }),
      wpZones, wpDayHdr, wpConfRows, wpHasConf: wpConfRows.length > 0, wpNoConf: wpConfRows.length === 0,
      wpParkRows, wpHasPark: wpParkRows.length > 0, wpParkN: wpParkRows.length,
      wpCrews, wpMhLabel: wpMh.toLocaleString(), wpShiftN, wpHasShift: wpShiftN > 0, wpViolN, wpHasViol: wpViolN > 0,
      wpZoneSeg, wpTrackRef: this._onWpTrackRef, wpCommitted,
      wpCommit: () => { this.logDecision({ kind: 'WEEK PLAN', title: 'W' + deWeek + ' zone plan committed (' + wpCrews + ' crews, ' + wpMh.toLocaleString() + ' MH)', why: wpShiftN + ' work item(s) re-slotted to resolve space/trade conflicts before muster. Committed plan now drives the Daily Ops muster board; P6 schedule of record unchanged.', tone: '#22c55e' }); this.setState({ wpCommitted: true, sbToast: 'Week plan committed for W' + deWeek + ' — it now drives the Daily Ops muster board.' }); },
      wpReset: () => this.setState({ wpShift: {}, wpCommitted: false }),
      sbReleasedOnly, toggleReleased: () => this.setState((s) => ({ sbReleasedOnly: !s.sbReleasedOnly })),
      relBtnColor: sbReleasedOnly ? '#f2f3f6' : '#94a3b8', relBtnBg: sbReleasedOnly ? '#2b2d36' : 'transparent',
      sbGasLayer, toggleGas: () => this.setState((s) => ({ sbGasLayer: !s.sbGasLayer })),
      gasBtnColor: sbGasLayer ? '#f2f3f6' : '#94a3b8', gasBtnBg: sbGasLayer ? '#2b2d36' : 'transparent',
      sbSandbox, toggleSandbox: () => this.setState((s) => ({ sbSandbox: !s.sbSandbox, sbShift: {}, sbProposed: false })),
      sandBtnColor: sbSandbox ? '#0b0c0e' : '#94a3b8', sandBtnBg: sbSandbox ? '#f59e0b' : 'transparent', sandBtnBorder: sbSandbox ? '#f59e0b' : '#2b2d36',
      sbShiftCount, sbHasShift: sbShiftCount > 0, cpDeltaLabel, cpDeltaColor,
      sbViolations, sbHasViolations: sbViolations.length > 0, sbProposed,
      sbReset: () => this.sbReset(), sbPropose: () => this.sbPropose(), sbTrackRef: this._onSbTrackRef,
      sbDetail, sbHasDetail: !!sbDetail, sbShowDetail: !!sbDetail && !sbSandbox && !selConflict, sbClearDetail: () => this.setState({ sbSel: null }),
      sbSummary, sbConfList,
      sbConflictsOnly, toggleConflictsOnly: () => this.setState((s) => ({ sbConflictsOnly: !s.sbConflictsOnly })),
      coBtnColor: sbConflictsOnly ? '#0b0c0e' : '#94a3b8', coBtnBg: sbConflictsOnly ? '#dc2626' : 'transparent', coBtnBorder: sbConflictsOnly ? '#dc2626' : '#2b2d36',
      sbLegendOpen, toggleLegend: () => this.setState((s) => ({ sbLegendOpen: !s.sbLegendOpen })), legendChev: sbLegendOpen ? '▾' : '▸',
      sbResolve, sbHasResolve: !!sbResolve, sbFocusMode: focusMode,
      sbToast, hasToast: !!sbToast, clearToast: () => this.setState({ sbToast: null }),
      // deck explorer
      deActive, decks, deDeckLabel: deDeckObj.label, deDeckSub: deDeckObj.sub, deHasImg, deImg,
      // altitude / lens / readiness
      altSeg, lensSeg, altShip, altZone, altComp, effAlt, isTradeLens, isSpaceLens: !isTradeLens,
      deReadiness, toggleReadiness: () => this.setState((s) => ({ deReadiness: !s.deReadiness })),
      deWeekDec: () => this.setState((s) => ({ deWeek: Math.max(1, s.deWeek - 1) })),
      deWeekInc: () => this.setState((s) => ({ deWeek: Math.min(26, s.deWeek + 1) })),
      readBtnColor: deReadiness ? '#f2f3f6' : '#94a3b8', readBtnBg: deReadiness ? '#2b2d36' : 'transparent',
      shipDoable, shipBlockedCount: shipBlocked.length, shipBlockedCP, shipActiveCount: shipActive.length, shipIncur,
      dirSeg, shipZoneCards, shipTradeCards,
      zoneRail, zMatrix, zFramesHdr: zFrames.map((f) => ({ key: f, label: 'Fr ' + f })),
      zIncursions, zInspect, hasZInspect: !!zInspect, noZInspect: !zInspect, zSummary,
      svcQueue, svcActionRail, zGoList, zHoldList, zMuster,
      zTitle: zObj.name, zSupt: zObj.supt, zDirRole: zDir ? zDir.role : '', zFrameRange: 'Fr ' + zObj.fr[0] + '–' + zObj.fr[1],
      zBandLabel: zObj.band[0].toUpperCase() + ' → ' + zObj.band[1].toUpperCase(),
      zSeamLo: 'Fr ' + zObj.fr[0], zSeamHi: 'Fr ' + zObj.fr[1],
      readinessLegend, tradeLegend, deTradeSel,
      deImgEl: deImg ? React.createElement('img', { src: deImg, onLoad: this._onImgLoad, draggable: false, alt: 'deck plan', style: { display: 'block', width: '100%', height: '100%', filter: 'invert(1) brightness(1.04) contrast(1.06)', opacity: 0.5, pointerEvents: 'none', userSelect: 'none' } }) : null,
      deShowDrawing, deModeSchematic, deDrawDisabled: !deHasImg,
      deModeBtnDrawingColor: deShowDrawing ? '#f2f3f6' : '#94a3b8', deModeBtnDrawingBg: deShowDrawing ? '#2b2d36' : 'transparent',
      deModeBtnSchemColor: !deShowDrawing ? '#f2f3f6' : '#94a3b8', deModeBtnSchemBg: !deShowDrawing ? '#2b2d36' : 'transparent',
      setModeDrawing: () => { if (deHasImg) this.setState({ deMode: 'drawing' }); },
      setModeSchematic: () => this.setState({ deMode: 'schematic' }),
      deOverlays, deAmbient,
      sbFocusLink, sbHasFocusLink: !!sbFocusLink,
      deView, deSingle, deVertical,
      deFull, deNotFull: !deFull,
      deRootStyle: deFull
        ? 'display:flex;min-width:0;position:fixed;inset:0;z-index:400;background:#0b0c0e;'
        : 'display:flex;height:100%;min-width:0;',
      toggleFull: () => this.setState((s) => ({ deFull: !s.deFull, deView: 'vertical', vReady: false, deFullVH: window.innerHeight })),
      deFullBtnLabel: deFull ? 'Exit full screen' : 'Full screen',
      deFullBtnColor: deFull ? '#0b0c0e' : '#ccd1da',
      deFullBtnBg: deFull ? '#3D6BFF' : 'linear-gradient(180deg,#17181d 0%,#121316 100%)',
      setSingle: () => this.setState({ deView: 'single' }),
      setVertical: () => this.setState({ deView: 'vertical', vReady: false, deSel: null }),
      vSingleColor: deSingle ? '#f2f3f6' : '#94a3b8', vSingleBg: deSingle ? '#2b2d36' : 'transparent',
      vTraceColor: deVertical ? '#f2f3f6' : '#94a3b8', vTraceBg: deVertical ? '#2b2d36' : 'transparent',
      deSpaceLayer, toggleSpaceLayer: () => this.setState((s) => ({ deSpaceLayer: !s.deSpaceLayer })),
      spaceBtnColor: deSpaceLayer ? '#f2f3f6' : '#94a3b8', spaceBtnBg: deSpaceLayer ? '#2b2d36' : 'transparent',
      vLanes, vConnectors, vPlumbX, vHasPlumb, vStackHeight, vRuler, vRibbon, vReady,
      vHover, vHasHover: !!vHover, vLegend,
      vUp: () => { if (fi > 0) this.setState({ deDeck: deDecksDef[fi - 1].id, deSel: null }); },
      vDown: () => { if (fi < deDecksDef.length - 1) this.setState({ deDeck: deDecksDef[fi + 1].id, deSel: null }); },
      clearHover: () => this.setState({ deHoverXFrac: null, deHoverComp: null }),
      vCanvasRef: this._onVCanvasRef, onVImgLoad: this._onVImgLoad, onVPanStart: this._vPanStart,
      vZoomPct: Math.round(vScale * 100) + '%',
      vZoomIn: () => this.vZoomBtn(1.25), vZoomOut: () => this.vZoomBtn(0.8), vFitWidth: () => this.vFit(),
      deCanvasRef: this._onCanvasRef, onImgLoad: this._onImgLoad, onPanStart: this._onPanStart,
      deReady, deDragging, deLoading: deShowDrawing && !deReady,
      deStageTransform: 'translate(' + Math.round(dePanX) + 'px,' + Math.round(dePanY) + 'px) scale(' + deScale + ')',
      deStageW: deNatW + 'px', deStageH: deNatH + 'px',
      deZoomPct: Math.round(deScale * 100) + '%',
      deCanvasCursor: deDragging ? 'grabbing' : 'grab',
      zoomIn: () => this.deZoomBtn(1.25), zoomOut: () => this.deZoomBtn(0.8),
      fitWidth: () => this.deFit('width'), fitDeck: () => this.deFit('deck'), oneHundred: () => this.deFit('100'),
      deWeek, deWeekLabel: 'W' + deWeek, deWeekPct: ((deWeek - 0.5) / 26 * 100).toFixed(2) + '%',
      deActiveWICount, deFlareCount, deHasFlare: deFlareCount > 0,
      setWeek: (e) => this.setState({ deWeek: parseInt(e.target.value, 10) }),
      sevSeg, classOpts, tradeOpts, eventOpts,
      deFClass, deFTrade, deFEvent,
      setFClass: (e) => this.setState({ deFClass: e.target.value }),
      setFTrade: (e) => this.setState({ deFTrade: e.target.value }),
      setFEvent: (e) => this.setState({ deFEvent: e.target.value }),
      deVisibleCount: deOverlays.filter((o) => !o.ghost).length,
      deSel, deDetail, hasDetail: !!deDetail, deShowLegend: !deDetail,
      clearDetail: () => this.setState({ deSel: null }),

      // availability workspace
      avwActive, av, subTabs, subOverview, subScoped, scopedLabel, openScoped,

      // daily ops
      doActive, doZoneBoards, doAlertRows, doHasAlerts: doAlertRows.length > 0, doSvc, doZoneSeg, doKpi, doShift,
      doViewSeg, doShiftView, doPaintView, pbCoats, pbFlam, hwReqs, pbStats, wadlFeedRows, wadlFeedEmpty,

      // decision log
      dlOpen: this.state.dlOpen, dlToggle: () => this.setState((s) => ({ dlOpen: !s.dlOpen })),
      dlRows: this.state.decisions.map((d) => ({ key: d.id, id: d.id, kind: d.kind, title: d.title, why: d.why, when: d.when, tone: d.tone,
        copyLabel: this.state.dlCopied === d.id ? 'Copied \u2713' : 'Copy brief',
        copyColor: this.state.dlCopied === d.id ? '#22c55e' : '#3D6BFF',
        onCopy: () => { try { navigator.clipboard.writeText('[' + d.kind + '] ' + d.title + '\nWHY: ' + d.why); } catch (e) {} this.setState({ dlCopied: d.id }); setTimeout(() => this.setState({ dlCopied: null }), 1600); } })),
      dlN: this.state.decisions.length, dlHasRows: this.state.decisions.length > 0, dlNoRows: this.state.decisions.length === 0,
      // wall display mode (A5) — POD-board scale for 10-ft viewing
      wallMode: this.state.wallMode,
      wallToggle: () => this.setState((s) => ({ wallMode: !s.wallMode, collapsed: !s.wallMode ? true : s.collapsed, dlOpen: false })),
      wallLabel: this.state.wallMode ? 'Exit wall display' : 'Wall display',
      wallBorder: this.state.wallMode ? '#3D6BFF' : '#2b2d36',
      wallColor: this.state.wallMode ? '#3D6BFF' : '#aab0bd',
      mainZoom: this.state.wallMode ? '1.55' : '1',
      dlBadgeBg: this.state.decisions.length ? '#3D6BFF' : '#2b2d36',
      // command center
      ccActive, showEmpty, csActive, cascade,
      lensNote: lens.note,
      lensAlabel: lens.a[0], lensAval: lens.a[1], lensAcolor: lens.a[2],
      lensBlabel: lens.b[0], lensBval: lens.b[1], lensBcolor: lens.b[2],
      empAvail: emp('avail'), empOpen: emp('open'), empCP: emp('cp'), empEvents: emp('events'), empCPdays: emp('cpdays'), empConf: emp('conf'),
      threatsRing, heatCols, heatRows, availTable, threats,
      kpiOpenConflicts: () => goConflicts(contextId),

      // configuration & history (PLCM)
      cfgActive, cfgTabs, cfgKpis, cfgRows, cfgDetail,
      cfgBaseline: cfgTab === 'baseline', cfgHistory: cfgTab === 'history', cfgHandoff: cfgTab === 'handoff',
      cfgDeviations: cfgTab === 'deviations', cfgClass: cfgTab === 'class',
      cfgCondition: cfgTab === 'condition', cfgInbound: cfgTab === 'inbound',
      cfgCoat, cfgRework, cfgNdt, cfgRecs,
      cfgSeedInbound, cfgPending, cfgInboundHdr, cfgOnCvn75, cfgNotCvn75: !cfgOnCvn75, cfgGoCvn75,
      cfgAcceptedMH: cfgAcceptedMH.toLocaleString(),
      cfgAcceptedN: String(cfgDefer.filter((d) => cfgAccepted[d.id]).length),
      cfgCompScoped: cfgTab === 'baseline' || cfgTab === 'history',
      cfgDevRegRows, cfgDevOpen: String(cfgDevOpen), cfgDevPerm: String(cfgDevPerm), cfgDevTotal: String(cfgDevReg.length),
      cfgClassRows, cfgDmsmsRows: cfgDmsms,
      cfgDeferRows, cfgDeferMH, cfgDeferN: String(cfgDefer.length), cfgCarriedN: String(cfgCarriedN),
      cfgToast: this.state.cfgToast, cfgHasToast: !!this.state.cfgToast, cfgClearToast: () => this.setState({ cfgToast: null }),
      cfgGoWadl: () => { window.location.href = 'WADL Console.dc.html'; },

      // rail
      modules,
      railWidth: collapsed ? '66px' : '236px',
      showLabels: !collapsed,
      toggleCollapse: () => this.setState((s) => ({ collapsed: !s.collapsed })),

      // context
      contexts, ctx,
      ctxUnscoped: !!this.state.ctxUnscoped,
      ctxUnscopedLine: this.state.ctxUnscoped
        ? this.state.ctxUnscoped + ' is the current operating context, and this portfolio holds no availability for it. What follows is ' + ctx.hull + ' — not that hull.'
        : '',
      ctxUnscopedId: this.state.ctxUnscoped || '',
      ctxBorder: openMenu === 'context' ? '#3D6BFF' : '#2b2d36',
      contextOpen: openMenu === 'context',
      openContext: () => this.setState((s) => ({ openMenu: s.openMenu === 'context' ? null : 'context' })),

      // persona
      persona,
      personaInitials: this.initialsOf(persona),
      personaFocus: personaMeta[persona].focus,
      personas,
      personaOpen: openMenu === 'persona',
      openPersona: () => this.setState((s) => ({ openMenu: s.openMenu === 'persona' ? null : 'persona' })),

      // alerts
      alertsCount: ctx.alerts,
      hasAlerts: ctx.alerts > 0,
      openAlerts: () => this.setState((s) => ({ openMenu: s.openMenu === 'alerts' ? null : 'alerts' })),

      // breadcrumb
      hasActive, activeLabel,
      goPortfolio: () => this.setState({ activeModule: null }),

      // content
      markColor: hasActive ? '#f59e0b' : '#3D6BFF',
      contentKicker: hasActive ? 'Workspace' : 'No module selected',
      contentTitle: hasActive ? activeLabel : 'Select a module.',
      contentSub: hasActive
        ? 'This workspace is provisioned and will render here as the build progresses. Object selection stays in sync across every surface.'
        : 'Choose a workspace from the module rail to begin. The platform flags risk and proposes mitigations — the planner and IPT decide.',

      // menus
      menuOpen: openMenu !== null,
      closeMenus: () => this.setState({ openMenu: null }),
    };
  }
}
