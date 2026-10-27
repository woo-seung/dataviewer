// Chronos Vault plugin: X–Y scatter of two columns paired by timestamp,
// with the least-squares line and R² computed over all data in the range.
// Optionally on x and y min-max scaled to 0–1 (R² stays the same; slope,
// intercept and the 1:1-line R² change). Drag = pan, Ctrl+drag = zoom.
export default {
  id: 'scatter-regression',
  name: '산점도 + 회귀 (R²)',
  version: '1.2.0',
  description: '두 열을 같은 시각끼리 짝지은 산점도와 회귀선, R²·기울기·절편 (0–1 정규화 선택)',
  params: {
    x: { type: 'column', label: 'X 열' },
    y: { type: 'column', label: 'Y 열' },
    fit: { type: 'boolean', label: '회귀선 표시', default: true },
    normalize: { type: 'boolean', label: 'X·Y 0–1 정규화', description: '최소–최대로 0–1 변환 후 회귀 (R²는 그대로, 기울기·절편과 1:1 R²가 바뀜)', default: false },
    maxPoints: { type: 'number', label: '최대 점 수', default: 8000, min: 100, max: 100000, step: 100 },
    pointSize: { type: 'number', label: '점 크기', default: 2, min: 0.5, max: 8, step: 0.5 },
  },
  async render(ctx) {
    const { d3, el, width, height, params: p, theme, format } = ctx;
    if (!p.x || !p.y) {
      el.innerHTML = `<div style="padding:16px;color:${theme.muted}">X 열과 Y 열을 지정하세요.</div>`;
      return;
    }
    const [rows, fit] = await Promise.all([
      ctx.data.aligned([p.x, p.y], { maxRows: p.maxPoints }),
      ctx.data.regression(p.x, p.y, { normalize: p.normalize }),
    ]);
    if (ctx.signal.aborted) return;
    // normalized view: every value scaled by the min / max the engine found
    const scale = (lo, hi) => (v) => (hi > lo ? (v - lo) / (hi - lo) : 0);
    const nx = p.normalize ? scale(fit.xMin, fit.xMax) : (v) => v;
    const ny = p.normalize ? scale(fit.yMin, fit.yMax) : (v) => v;
    const xs = Float64Array.from(rows.columns[0], nx);
    const ys = Float64Array.from(rows.columns[1], ny);

    const m = { top: 28, right: 16, bottom: 36, left: 64 };
    const w = Math.max(10, width - m.left - m.right);
    const h = Math.max(10, height - m.top - m.bottom);
    const ext = (a) => {
      const [lo, hi] = d3.extent(a.filter(Number.isFinite));
      return lo === undefined ? [0, 1] : lo === hi ? [lo - 1, hi + 1] : [lo, hi];
    };
    const zx = ctx.zoom && ctx.zoom.x;
    const zy = ctx.zoom && ctx.zoom.y;
    const x = zx ? d3.scaleLinear().domain(zx).range([0, w]) : d3.scaleLinear().domain(p.normalize ? [0, 1] : ext(xs)).nice().range([0, w]);
    const y = zy ? d3.scaleLinear().domain(zy).range([h, 0]) : d3.scaleLinear().domain(p.normalize ? [0, 1] : ext(ys)).nice().range([h, 0]);

    // points on a canvas (fast for many points), axes and lines in SVG on top
    const dpr = window.devicePixelRatio || 1;
    const canvas = d3.select(el).append('canvas').attr('width', w * dpr).attr('height', h * dpr)
      .style('position', 'absolute').style('left', `${m.left}px`).style('top', `${m.top}px`).style('width', `${w}px`).style('height', `${h}px`);
    const g2 = canvas.node().getContext('2d');
    g2.scale(dpr, dpr);
    g2.fillStyle = theme.palette[0];
    g2.globalAlpha = xs.length > 3000 ? 0.45 : 0.75;
    const r = p.pointSize;
    for (let i = 0; i < xs.length; i++) {
      if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
      g2.beginPath();
      g2.arc(x(xs[i]), y(ys[i]), r, 0, Math.PI * 2);
      g2.fill();
    }

    const svg = d3.select(el).append('svg').attr('width', width).attr('height', height).style('position', 'absolute').style('left', 0).style('top', 0);
    const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
    const axis = (sel) => sel.call((s) => s.selectAll('text').attr('fill', theme.muted)).call((s) => s.selectAll('line,path').attr('stroke', theme.grid));
    g.append('g').attr('transform', `translate(0,${h})`).call(d3.axisBottom(x).ticks(Math.max(2, w / 80))).call(axis);
    g.append('g').call(d3.axisLeft(y).ticks(Math.max(2, h / 40))).call(axis);
    const suffix = p.normalize ? ' (0–1)' : '';
    g.append('text').attr('x', w).attr('y', h + 30).attr('text-anchor', 'end').attr('fill', theme.muted).text(p.x.label + suffix);
    g.append('text').attr('transform', `translate(${-m.left + 12},${h / 2}) rotate(-90)`).attr('text-anchor', 'middle').attr('fill', theme.muted).text(p.y.label + suffix);

    g.append('clipPath').attr('id', 'plot').append('rect').attr('width', w).attr('height', h);
    const line = (a, b, color, dash) => {
      const [x0, x1] = x.domain();
      g.append('line').attr('clip-path', 'url(#plot)')
        .attr('x1', x(x0)).attr('y1', y(a * x0 + b)).attr('x2', x(x1)).attr('y2', y(a * x1 + b))
        .attr('stroke', color).attr('stroke-width', dash ? 1.2 : 2).attr('stroke-dasharray', dash ? '5 4' : null);
    };
    if (p.normalize) line(1, 0, theme.faint, true); // the 1:1 line
    if (p.fit && fit.slope !== null && fit.intercept !== null) line(fit.slope, fit.intercept, theme.palette[1], false);

    const sign = fit.intercept !== null && fit.intercept < 0 ? '−' : '+';
    const parts = fit.slope === null
      ? [`n = ${fit.n.toLocaleString()}`]
      : [
          `${p.normalize ? '정규화 ' : ''}y = ${format.number(fit.slope)}·x ${sign} ${format.number(Math.abs(fit.intercept))}`,
          `R² = ${fit.r2 === null ? '—' : fit.r2.toFixed(4)}`,
          ...(p.normalize && fit.r2Identity !== null ? [`1:1 R² = ${fit.r2Identity.toFixed(4)}`] : []),
          `n = ${fit.n.toLocaleString()}${rows.total > xs.length ? ` (표시 ${xs.length.toLocaleString()})` : ''}`,
        ];
    svg.append('text').attr('x', width - m.right).attr('y', 16).attr('text-anchor', 'end').attr('fill', theme.text).style('font-weight', 600).text(parts.join('   '));
    if (ctx.zoom) svg.append('text').attr('x', m.left).attr('y', 16).attr('fill', theme.faint).text('확대됨 · 더블클릭: 전체');

    // drag = pan, Ctrl+drag = box zoom, double-click = fit
    const area = { left: m.left, top: m.top, width: w, height: h };
    ctx.enableZoom({ x, y, area });
    // hovering near a point: its time and both values (as measured, also when normalized)
    const [rx, ry] = rows.columns;
    ctx.hoverPoints({
      x: xs, y: ys, xScale: x, yScale: y, area,
      label: (i) => `${format.time(rows.t[i], true)}<br>${p.x.label}: <b>${format.number(rx[i])}</b><br>${p.y.label}: <b>${format.number(ry[i])}</b>`,
    });
  },
};
