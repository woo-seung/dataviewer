// Chronos Vault plugin: value distribution of one or more columns on shared bins.
// Drag = pan, Ctrl+drag = zoom on the value axis (re-binned inside it).
export default {
  id: 'histogram',
  name: '히스토그램',
  version: '1.1.0',
  description: '한 개 이상 열의 값 분포 (같은 구간으로 겹쳐 그림), 평균 표시',
  params: {
    columns: { type: 'columns', label: '열', min: 1, max: 6 },
    bins: { type: 'number', label: '구간 수', default: 40, min: 2, max: 500 },
    density: { type: 'boolean', label: '비율(%)로 보기', default: false },
  },
  async render(ctx) {
    const { d3, el, width, height, params: p, theme, format } = ctx;
    const cols = p.columns || [];
    if (!cols.length) {
      el.innerHTML = `<div style="padding:16px;color:${theme.muted}">열을 하나 이상 지정하세요.</div>`;
      return;
    }
    const stats = await ctx.data.stats(cols);
    const lo = d3.min(stats, (s) => s && s.min);
    const hi = d3.max(stats, (s) => s && s.max);
    if (lo === undefined || hi === undefined) {
      el.innerHTML = `<div style="padding:16px;color:${theme.muted}">이 구간에 데이터가 없습니다.</div>`;
      return;
    }
    const zx = ctx.zoom && ctx.zoom.x;
    const [b0, b1] = zx || [lo, hi === lo ? lo + 1 : hi];
    const hs = await Promise.all(cols.map((c) => ctx.data.histogram(c, { bins: p.bins, min: b0, max: b1 })));
    if (ctx.signal.aborted) return;
    const ys = hs.map((hh) => hh.counts.map((n) => (p.density ? (100 * n) / Math.max(1, hh.total) : n)));
    const m = { top: 28, right: 16, bottom: 30, left: 56 };
    const w = Math.max(10, width - m.left - m.right);
    const h = Math.max(10, height - m.top - m.bottom);
    const x = d3.scaleLinear().domain([hs[0].min, hs[0].max]).range([0, w]);
    const y = d3.scaleLinear().domain([0, d3.max(ys.flat()) || 1]).nice().range([h, 0]);
    const svg = d3.select(el).append('svg').attr('width', width).attr('height', height);
    const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
    const bw = w / p.bins;
    ys.forEach((counts, k) => {
      const color = theme.palette[k % theme.palette.length];
      g.append('g').selectAll('rect').data(counts).join('rect')
        .attr('x', (_, i) => i * bw + 0.5).attr('width', Math.max(1, bw - 1))
        .attr('y', (n) => y(n)).attr('height', (n) => h - y(n))
        .attr('fill', color).attr('fill-opacity', cols.length > 1 ? 0.5 : 0.85)
        .on('mousemove', (e, n) => {
          const i = counts.indexOf(n);
          ctx.tooltip.show(e.clientX, e.clientY, `${cols[k].label}<br>${format.number(x.invert(i * bw))} ~ ${format.number(x.invert((i + 1) * bw))}<br><b>${p.density ? `${n.toFixed(2)} %` : n.toLocaleString()}</b>`);
        })
        .on('mouseleave', () => ctx.tooltip.hide());
      const mean = stats[k] && stats[k].mean;
      if (Number.isFinite(mean)) g.append('line').attr('x1', x(mean)).attr('x2', x(mean)).attr('y1', 0).attr('y2', h).attr('stroke', color).attr('stroke-dasharray', '4 3');
    });
    const axis = (s) => s.call((a) => a.selectAll('text').attr('fill', theme.muted)).call((a) => a.selectAll('line,path').attr('stroke', theme.grid));
    g.append('g').attr('transform', `translate(0,${h})`).call(d3.axisBottom(x).ticks(Math.max(2, w / 80))).call(axis);
    g.append('g').call(d3.axisLeft(y).ticks(Math.max(2, h / 40)).tickFormat((v) => (p.density ? `${v}%` : format.number(v, 3)))).call(axis);
    if (zx) svg.append('text').attr('x', width - m.right).attr('y', 16).attr('text-anchor', 'end').attr('fill', theme.faint).text('확대됨 · 더블클릭: 전체');
    // drag = pan, Ctrl+drag = box zoom along the value axis, double-click = fit
    ctx.enableZoom({ x, area: { left: m.left, top: m.top, width: w, height: h } });
    let lx = 0;
    cols.forEach((c, k) => {
      const t = svg.append('text').attr('x', m.left + lx + 14).attr('y', 16).attr('fill', theme.text).text(`${c.label}  (평균 ${format.number(stats[k] && stats[k].mean)})`);
      svg.append('rect').attr('x', m.left + lx).attr('y', 7).attr('width', 10).attr('height', 10).attr('fill', theme.palette[k % theme.palette.length]);
      lx += t.node().getComputedTextLength() + 30;
    });
  },
};
