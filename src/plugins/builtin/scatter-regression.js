// Chronos Vault plugin: X–Y scatter of two columns paired by timestamp,
// with the least-squares line and R² computed over all data in the range.
export default {
  id: 'scatter-regression',
  name: '산점도 + 회귀 (R²)',
  version: '1.0.0',
  description: '두 열을 같은 시각끼리 짝지은 산점도와 회귀선, R²·기울기·절편',
  params: {
    x: { type: 'column', label: 'X 열' },
    y: { type: 'column', label: 'Y 열' },
    fit: { type: 'boolean', label: '회귀선 표시', default: true },
    maxPoints: { type: 'number', label: '최대 점 수', default: 8000, min: 100, max: 100000, step: 100 },
    pointSize: { type: 'number', label: '점 크기', default: 2, min: 0.5, max: 8, step: 0.5 },
  },
  async render(ctx) {
    const { d3, el, width, height, params: p, theme, format } = ctx;
    if (!p.x || !p.y) {
      el.innerHTML = `<div style="padding:16px;color:${theme.muted}">X 열과 Y 열을 지정하세요.</div>`;
      return;
    }
    const [rows, fit] = await Promise.all([ctx.data.aligned([p.x, p.y], { maxRows: p.maxPoints }), ctx.data.regression(p.x, p.y)]);
    if (ctx.signal.aborted) return;
    const xs = rows.columns[0];
    const ys = rows.columns[1];
    const m = { top: 28, right: 16, bottom: 36, left: 64 };
    const w = Math.max(10, width - m.left - m.right);
    const h = Math.max(10, height - m.top - m.bottom);
    const ext = (a) => {
      const [lo, hi] = d3.extent(a.filter(Number.isFinite));
      return lo === undefined ? [0, 1] : lo === hi ? [lo - 1, hi + 1] : [lo, hi];
    };
    const x = d3.scaleLinear().domain(ext(xs)).nice().range([0, w]);
    const y = d3.scaleLinear().domain(ext(ys)).nice().range([h, 0]);

    // points on a canvas (fast for many points), axes and line in SVG on top
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
    g.append('text').attr('x', w).attr('y', h + 30).attr('text-anchor', 'end').attr('fill', theme.muted).text(p.x.label);
    g.append('text').attr('transform', `translate(${-m.left + 12},${h / 2}) rotate(-90)`).attr('text-anchor', 'middle').attr('fill', theme.muted).text(p.y.label);

    if (p.fit && fit.slope !== null && fit.intercept !== null) {
      const [x0, x1] = x.domain();
      g.append('clipPath').attr('id', 'plot').append('rect').attr('width', w).attr('height', h);
      g.append('line')
        .attr('clip-path', 'url(#plot)')
        .attr('x1', x(x0)).attr('y1', y(fit.slope * x0 + fit.intercept))
        .attr('x2', x(x1)).attr('y2', y(fit.slope * x1 + fit.intercept))
        .attr('stroke', theme.palette[1]).attr('stroke-width', 2);
    }
    const sign = fit.intercept !== null && fit.intercept < 0 ? '−' : '+';
    const text = fit.slope === null
      ? `n = ${fit.n.toLocaleString()}`
      : `y = ${format.number(fit.slope)}·x ${sign} ${format.number(Math.abs(fit.intercept))}   R² = ${fit.r2 === null ? '—' : fit.r2.toFixed(4)}   n = ${fit.n.toLocaleString()}${rows.total > xs.length ? ` (표시 ${xs.length.toLocaleString()})` : ''}`;
    svg.append('text').attr('x', width - m.right).attr('y', 16).attr('text-anchor', 'end').attr('fill', theme.text).style('font-weight', 600).text(text);
  },
};
