// Runs inside the plugin sandbox (an iframe with an opaque origin and no
// network). Loads the plugin object from window.__plugin, answers the host's
// messages and gives the plugin its `ctx` (see spec.ts).
(() => {
  'use strict';
  const root = document.getElementById('root');
  const pending = new Map();
  let seq = 0;
  let state = {};
  let current = null;

  const post = (m, transfer) => parent.postMessage(m, '*', transfer || []);
  const call = (method, args) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      post({ type: 'call', id, method, args });
    });

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const format = {
    time(ms, withSeconds) {
      if (!Number.isFinite(ms)) return '—';
      const d = new Date(ms);
      const s = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      return withSeconds ? `${s}:${pad(d.getUTCSeconds())}` : s;
    },
    number(v, digits = 4) {
      if (v === null || v === undefined || !Number.isFinite(v)) return '—';
      const a = Math.abs(v);
      if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(2);
      return Number(v.toPrecision(digits)).toLocaleString('en-US', { maximumFractionDigits: 6 });
    },
  };

  const data = {
    columns: () => call('columns', {}),
    stats: (columns, opts) => call('stats', { columns: [].concat(columns), ...opts }),
    series: (column, opts) => call('series', { column, ...opts }),
    raw: (column, opts) => call('raw', { column, ...opts }),
    aligned: (columns, opts) => call('aligned', { columns, ...opts }),
    regression: (x, y, opts) => call('regression', { x, y, ...opts }),
    histogram: (column, opts) => call('histogram', { column, ...opts }),
    histogram2d: (x, y, opts) => call('histogram2d', { x, y, ...opts }),
    buckets: (column, opts) => call('buckets', { column, ...opts }),
  };

  let tip = null;
  const tooltip = {
    show(x, y, html) {
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'chronos-tooltip';
        document.body.appendChild(tip);
      }
      tip.innerHTML = html;
      tip.style.display = 'block';
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      tip.style.left = `${Math.min(window.innerWidth - w - 4, x + 12)}px`;
      tip.style.top = `${Math.max(4, Math.min(window.innerHeight - h - 4, y + 12))}px`;
    },
    hide() {
      if (tip) tip.style.display = 'none';
    },
  };

  // ---- zoom / pan (plugins opt in with ctx.enableZoom) ----
  let zoomCfg = null;
  let currentZoom = null;
  const local = (e) => {
    if (!zoomCfg) return null;
    const r = root.getBoundingClientRect();
    const a = zoomCfg.area;
    const x = e.clientX - r.left - a.left;
    const y = e.clientY - r.top - a.top;
    return x >= 0 && y >= 0 && x <= a.width && y <= a.height ? { x, y } : null;
  };
  const sorted = (a, b) => (a <= b ? [a, b] : [b, a]);
  root.addEventListener('pointerdown', (e) => {
    const cfg = zoomCfg;
    const p0 = e.button === 0 ? local(e) : null;
    if (!cfg || !p0) return;
    e.preventDefault();
    root.setPointerCapture(e.pointerId);
    const box = e.ctrlKey || e.metaKey;
    const a = cfg.area;
    let p1 = p0;
    let mark = null;
    if (box) {
      mark = document.createElement('div');
      mark.className = 'chronos-zoom-box';
      root.appendChild(mark);
    } else root.style.cursor = 'grabbing';
    const move = (ev) => {
      const r = root.getBoundingClientRect();
      p1 = { x: Math.max(0, Math.min(a.width, ev.clientX - r.left - a.left)), y: Math.max(0, Math.min(a.height, ev.clientY - r.top - a.top)) };
      if (box) {
        const [x0, x1] = cfg.x ? sorted(p0.x, p1.x) : [0, a.width];
        const [y0, y1] = cfg.y ? sorted(p0.y, p1.y) : [0, a.height];
        Object.assign(mark.style, { left: `${a.left + x0}px`, top: `${a.top + y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
      } else {
        const dx = cfg.x ? ev.clientX - e.clientX : 0;
        const dy = cfg.y ? ev.clientY - e.clientY : 0;
        for (const c of root.children) if (c !== tip) c.style.transform = `translate(${dx}px,${dy}px)`;
      }
    };
    const up = (ev) => {
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', up);
      root.removeEventListener('pointercancel', up);
      root.style.cursor = '';
      if (mark) mark.remove();
      const keep = currentZoom || {};
      if (box) {
        const wx = Math.abs(p1.x - p0.x);
        const wy = Math.abs(p1.y - p0.y);
        const zx = cfg.x && wx > 4 ? sorted(cfg.x.invert(p0.x), cfg.x.invert(p1.x)) : keep.x || null;
        const zy = cfg.y && wy > 4 ? sorted(cfg.y.invert(p0.y), cfg.y.invert(p1.y)) : keep.y || null;
        if ((cfg.x && wx > 4) || (cfg.y && wy > 4)) post({ type: 'zoom', zoom: { x: zx, y: zy } });
        return;
      }
      const dx = cfg.x ? ev.clientX - e.clientX : 0;
      const dy = cfg.y ? ev.clientY - e.clientY : 0;
      if (Math.abs(dx) + Math.abs(dy) < 3) {
        for (const c of root.children) c.style.transform = '';
        return;
      }
      // the visible window moves opposite to the drag
      const zx = cfg.x ? sorted(cfg.x.invert(-dx), cfg.x.invert(a.width - dx)) : keep.x || null;
      const zy = cfg.y ? sorted(cfg.y.invert(a.height - dy), cfg.y.invert(-dy)) : keep.y || null;
      post({ type: 'zoom', zoom: { x: zx, y: zy } });
    };
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
  });
  root.addEventListener('dblclick', (e) => {
    if (zoomCfg && currentZoom && local(e)) post({ type: 'zoom', zoom: null });
  });

  const showError = (e) => {
    const msg = (e && (e.stack || e.message)) || String(e);
    root.innerHTML = '';
    const box = document.createElement('pre');
    box.className = 'chronos-error';
    box.textContent = `플러그인 오류\n${msg}`;
    root.appendChild(box);
    post({ type: 'error', message: String((e && e.message) || e) });
  };

  const plugin = () => {
    const p = window.__plugin;
    if (!p && window.__loadErrors && window.__loadErrors.length) throw new Error(`플러그인 코드를 읽지 못했습니다: ${window.__loadErrors.join('; ')}`);
    if (!p || typeof p !== 'object') throw new Error('플러그인 코드가 `export default { ... }` 객체를 내보내지 않았습니다.');
    if (typeof p.render !== 'function') throw new Error('플러그인에 render(ctx) 함수가 없습니다.');
    return p;
  };

  const manifest = (p) => JSON.parse(JSON.stringify({ id: p.id, name: p.name, version: p.version, description: p.description, author: p.author, params: p.params || {} }));

  async function render(m) {
    current?.abort();
    const ac = new AbortController();
    current = ac;
    const theme = m.theme;
    for (const [k, v] of Object.entries(theme.vars || {})) document.documentElement.style.setProperty(k, v);
    document.documentElement.dataset.theme = theme.dark ? 'dark' : 'light';
    tooltip.hide();
    root.innerHTML = '';
    zoomCfg = null;
    currentZoom = m.zoom || null;
    const ctx = {
      el: root,
      width: m.width,
      height: m.height,
      params: m.params,
      range: m.range,
      theme,
      data,
      format,
      tooltip,
      d3: window.d3,
      state,
      signal: ac.signal,
      setRange: (start, end) => post({ type: 'setRange', start, end }),
      zoom: currentZoom,
      enableZoom(cfg) {
        if (!cfg || !cfg.area || (!cfg.x && !cfg.y)) return;
        zoomCfg = { x: cfg.x && cfg.x.invert ? cfg.x : null, y: cfg.y && cfg.y.invert ? cfg.y : null, area: cfg.area };
        root.style.cursor = 'grab';
      },
    };
    try {
      await plugin().render(ctx);
      if (!ac.signal.aborted) post({ type: 'rendered' });
    } catch (e) {
      if (!ac.signal.aborted) showError(e);
    }
  }

  async function snapshot() {
    const w = root.clientWidth;
    const h = root.clientHeight;
    const scale = window.devicePixelRatio || 1;
    const c = document.createElement('canvas');
    c.width = w * scale;
    c.height = h * scale;
    const g = c.getContext('2d');
    g.scale(scale, scale);
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--background') || '#fff';
    g.fillRect(0, 0, w, h);
    const base = root.getBoundingClientRect();
    for (const el of root.querySelectorAll('svg, canvas')) {
      if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
      const r = el.getBoundingClientRect();
      if (el.tagName.toLowerCase() === 'canvas') {
        g.drawImage(el, r.left - base.left, r.top - base.top, r.width, r.height);
        continue;
      }
      const clone = el.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', r.width);
      clone.setAttribute('height', r.height);
      // inline the theme colours the SVG refers to
      const css = [...document.documentElement.style].map((k) => `${k}:${document.documentElement.style.getPropertyValue(k)}`).join(';');
      clone.setAttribute('style', `${clone.getAttribute('style') || ''};${css};font-family:sans-serif`);
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
      await new Promise((res) => {
        const img = new Image();
        img.onload = () => {
          g.drawImage(img, r.left - base.left, r.top - base.top, r.width, r.height);
          res();
        };
        img.onerror = res;
        img.src = url;
      });
    }
    return c.toDataURL('image/png');
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== parent) return;
    const m = e.data || {};
    if (m.type === 'result') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error));
    } else if (m.type === 'inspect') {
      try {
        post({ type: 'manifest', manifest: manifest(plugin()) });
      } catch (err) {
        post({ type: 'manifest', error: String(err.message || err) });
      }
    } else if (m.type === 'render') {
      void render(m);
    } else if (m.type === 'snapshot') {
      try {
        post({ type: 'snapshot', id: m.id, url: await snapshot() });
      } catch (err) {
        post({ type: 'snapshot', id: m.id, error: String(err) });
      }
    }
  });
  window.addEventListener('error', (e) => showError(e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => showError(e.reason));
  post({ type: 'ready' });
})();
