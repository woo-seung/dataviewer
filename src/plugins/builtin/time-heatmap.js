// Chronos Vault plugin: calendar heatmap — one column aggregated by hour of
// day against weekday or date. Clicking a date row zooms the worksheet to it.
export default {
  id: 'time-heatmap',
  name: '시간대 히트맵',
  version: '1.0.0',
  description: '시간(0–23시) × 요일 또는 날짜별로 한 열의 평균·최대·최소·개수를 색으로',
  params: {
    column: { type: 'column', label: '열' },
    rows: { type: 'select', label: '세로축', options: [{ value: 'weekday', label: '요일' }, { value: 'day', label: '날짜' }], default: 'weekday' },
    agg: { type: 'select', label: '집계', options: [{ value: 'mean', label: '평균' }, { value: 'max', label: '최대' }, { value: 'min', label: '최소' }, { value: 'count', label: '개수' }], default: 'mean' },
    scheme: { type: 'select', label: '색', options: ['viridis', 'magma', 'blues', 'reds'], default: 'viridis' },
  },
  async render(ctx) {
    const { d3, el, width, height, params: p, theme, format } = ctx;
    if (!p.column) {
      el.innerHTML = `<div style="padding:16px;color:${theme.muted}">열을 지정하세요.</div>`;
      return;
    }
    const cells = await ctx.data.buckets(p.column, { keys: ['hour', p.rows] });
    if (ctx.signal.aborted) return;
    const value = (c) => (p.agg === 'count' ? c.count : c[p.agg]);
    const WD = ['월', '화', '수', '목', '금', '토', '일'];
    const rowKeys = p.rows === 'weekday' ? d3.range(7) : [...new Set(cells.map((c) => c.b))].sort((a, b) => a - b);
    const rowLabel = (k) => (p.rows === 'weekday' ? WD[k] : format.time(k * 86400000).slice(0, 10));
    const m = { top: 24, right: 70, bottom: 26, left: p.rows === 'weekday' ? 30 : 80 };
    const w = Math.max(10, width - m.left - m.right);
    const h = Math.max(10, height - m.top - m.bottom);
    const x = d3.scaleBand().domain(d3.range(24)).range([0, w]).padding(0.04);
    const y = d3.scaleBand().domain(rowKeys).range([0, h]).padding(rowKeys.length > 60 ? 0 : 0.04);
    const vals = cells.map(value).filter(Number.isFinite);
    const interp = { viridis: d3.interpolateViridis, magma: d3.interpolateMagma, blues: d3.interpolateBlues, reds: d3.interpolateReds }[p.scheme] || d3.interpolateViridis;
    const color = d3.scaleSequential(interp).domain(d3.extent(vals).map((v) => v ?? 0));

    const svg = d3.select(el).append('svg').attr('width', width).attr('height', height);
    const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
    g.selectAll('rect').data(cells).join('rect')
      .attr('x', (c) => x(c.a)).attr('y', (c) => y(c.b)).attr('width', x.bandwidth()).attr('height', Math.max(1, y.bandwidth()))
      .attr('fill', (c) => color(value(c))).attr('rx', y.bandwidth() > 6 ? 2 : 0)
      .style('cursor', p.rows === 'day' ? 'pointer' : 'default')
      .on('mousemove', (e, c) => ctx.tooltip.show(e.clientX, e.clientY, `${rowLabel(c.b)} ${c.a}시<br><b>${format.number(value(c))}</b> (${p.agg}) · n=${c.count}`))
      .on('mouseleave', () => ctx.tooltip.hide())
      .on('click', (e, c) => p.rows === 'day' && ctx.setRange(c.b * 86400000, (c.b + 1) * 86400000));
    const axis = (s) => s.call((a) => a.selectAll('text').attr('fill', theme.muted)).call((a) => a.selectAll('line,path').attr('stroke', 'none'));
    g.append('g').call(d3.axisTop(x).tickValues(d3.range(0, 24, w < 400 ? 3 : 1)).tickFormat((d) => `${d}`)).call(axis);
    const every = Math.max(1, Math.ceil(rowKeys.length / Math.max(1, h / 14)));
    g.append('g').call(d3.axisLeft(y).tickValues(rowKeys.filter((_, i) => i % every === 0)).tickFormat(rowLabel)).call(axis);
    g.append('text').attr('x', w / 2).attr('y', h + 18).attr('text-anchor', 'middle').attr('fill', theme.faint).text('시 (UTC)');

    // colour legend
    const lh = Math.min(h, 160);
    const defs = svg.append('defs').append('linearGradient').attr('id', 'lg').attr('x1', 0).attr('x2', 0).attr('y1', 1).attr('y2', 0);
    d3.range(0, 1.01, 0.1).forEach((t) => defs.append('stop').attr('offset', t).attr('stop-color', interp(t)));
    const lg = svg.append('g').attr('transform', `translate(${width - m.right + 14},${m.top})`);
    lg.append('rect').attr('width', 10).attr('height', lh).attr('fill', 'url(#lg)');
    const ls = d3.scaleLinear().domain(color.domain()).range([lh, 0]);
    lg.append('g').attr('transform', 'translate(10,0)').call(d3.axisRight(ls).ticks(4).tickFormat((v) => format.number(v, 3))).call(axis);
  },
};
