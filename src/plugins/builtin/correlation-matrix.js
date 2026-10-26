// Chronos Vault plugin: Pearson correlation between columns (paired by timestamp).
export default {
  id: 'correlation-matrix',
  name: '상관행렬',
  version: '1.0.0',
  description: '여러 열 사이의 피어슨 상관계수를 색과 숫자로 (같은 시각끼리 짝지음)',
  params: {
    columns: { type: 'columns', label: '열', min: 2, max: 30 },
    sample: { type: 'number', label: '계산에 쓸 최대 행 수', default: 50000, min: 1000, max: 1000000, step: 1000 },
    showValues: { type: 'boolean', label: '숫자 표시', default: true },
  },
  async render(ctx) {
    const { d3, el, width, height, params: p, theme } = ctx;
    const cols = p.columns || [];
    if (cols.length < 2) {
      el.innerHTML = `<div style="padding:16px;color:${theme.muted}">열을 두 개 이상 지정하세요.</div>`;
      return;
    }
    const rows = await ctx.data.aligned(cols, { maxRows: p.sample });
    if (ctx.signal.aborted) return;
    const k = cols.length;
    const corr = (a, b) => {
      let n = 0, ma = 0, mb = 0, saa = 0, sbb = 0, sab = 0;
      for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        n++;
        const dx = x - ma, dy = y - mb;
        ma += dx / n;
        mb += dy / n;
        saa += dx * (x - ma);
        sbb += dy * (y - mb);
        sab += dx * (y - mb);
      }
      return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
    };
    const cells = [];
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) cells.push({ i, j, r: i === j ? 1 : j < i ? cells[j * k + i].r : corr(rows.columns[i], rows.columns[j]) });
    const label = (i) => cols[i].label;
    const left = Math.min(160, 12 + 7 * d3.max(cols, (c) => c.label.length));
    const size = Math.max(10, Math.min(width - left - 70, height - 30 - left * 0.0));
    const m = { top: 20, left };
    const x = d3.scaleBand().domain(d3.range(k)).range([0, Math.min(size, height - m.top - 10)]).padding(0.03);
    const color = d3.scaleDiverging(d3.interpolateRdBu).domain([1, 0, -1]);
    const svg = d3.select(el).append('svg').attr('width', width).attr('height', height);
    const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
    g.selectAll('rect').data(cells).join('rect')
      .attr('x', (c) => x(c.j)).attr('y', (c) => x(c.i)).attr('width', x.bandwidth()).attr('height', x.bandwidth())
      .attr('fill', (c) => (Number.isFinite(c.r) ? color(c.r) : theme.grid))
      .on('mousemove', (e, c) => ctx.tooltip.show(e.clientX, e.clientY, `${label(c.i)} × ${label(c.j)}<br><b>r = ${Number.isFinite(c.r) ? c.r.toFixed(3) : '—'}</b>`))
      .on('mouseleave', () => ctx.tooltip.hide());
    if (p.showValues && x.bandwidth() > 22)
      g.selectAll('text.v').data(cells).join('text').attr('class', 'v')
        .attr('x', (c) => x(c.j) + x.bandwidth() / 2).attr('y', (c) => x(c.i) + x.bandwidth() / 2 + 4)
        .attr('text-anchor', 'middle').style('font-size', `${Math.min(12, x.bandwidth() / 3.5)}px`)
        .attr('fill', (c) => (Math.abs(c.r) > 0.55 ? '#fff' : '#222')).text((c) => (Number.isFinite(c.r) ? c.r.toFixed(2) : ''));
    g.selectAll('text.l').data(d3.range(k)).join('text').attr('class', 'l')
      .attr('x', -6).attr('y', (i) => x(i) + x.bandwidth() / 2 + 4).attr('text-anchor', 'end').attr('fill', theme.muted)
      .text((i) => (label(i).length > 22 ? `${label(i).slice(0, 21)}…` : label(i)));
    svg.append('text').attr('x', m.left).attr('y', 13).attr('fill', theme.faint).text(`n = ${rows.total.toLocaleString()}${rows.total > rows.t.length ? ` (계산 ${rows.t.length.toLocaleString()}행)` : ''}`);
  },
};
