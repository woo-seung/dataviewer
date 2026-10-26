// Chronos Vault plugin: 2-D density of two columns (paired by timestamp) on a grid.
export default {
  id: 'density-heatmap',
  name: '밀도 히트맵 (X×Y)',
  version: '1.0.0',
  description: '두 열을 같은 시각끼리 짝지어 X×Y 격자에 몇 번 나타났는지를 색으로 (로그 스케일)',
  params: {
    x: { type: 'column', label: 'X 열' },
    y: { type: 'column', label: 'Y 열' },
    bins: { type: 'number', label: '격자 칸 수', default: 60, min: 5, max: 300, step: 5 },
  },
  async render(ctx) {
    const { d3, el, width, height, params: p, theme, format } = ctx;
    if (!p.x || !p.y) {
      el.innerHTML = `<div style="padding:16px;color:${theme.muted}">X 열과 Y 열을 지정하세요.</div>`;
      return;
    }
    const hm = await ctx.data.histogram2d(p.x, p.y, { xBins: p.bins, yBins: p.bins });
    if (ctx.signal.aborted) return;
    const m = { top: 24, right: 16, bottom: 36, left: 64 };
    const w = Math.max(10, width - m.left - m.right);
    const h = Math.max(10, height - m.top - m.bottom);
    if (!hm.total) {
      el.innerHTML = `<div style="padding:16px;color:${theme.muted}">이 구간에 짝지을 데이터가 없습니다.</div>`;
      return;
    }
    const x = d3.scaleLinear().domain([hm.xMin, hm.xMax]).range([0, w]);
    const y = d3.scaleLinear().domain([hm.yMin, hm.yMax]).range([h, 0]);
    const max = d3.max(hm.counts);
    const color = d3.scaleSequentialLog(theme.dark ? d3.interpolateInferno : d3.interpolateYlGnBu).domain([1, Math.max(2, max)]);
    const dpr = window.devicePixelRatio || 1;
    const c = d3.select(el).append('canvas').attr('width', w * dpr).attr('height', h * dpr)
      .style('position', 'absolute').style('left', `${m.left}px`).style('top', `${m.top}px`).style('width', `${w}px`).style('height', `${h}px`);
    const g2 = c.node().getContext('2d');
    g2.scale(dpr, dpr);
    const cw = w / hm.xBins;
    const ch = h / hm.yBins;
    for (let j = 0; j < hm.yBins; j++)
      for (let i = 0; i < hm.xBins; i++) {
        const n = hm.counts[j * hm.xBins + i];
        if (!n) continue;
        g2.fillStyle = color(n);
        g2.fillRect(i * cw, h - (j + 1) * ch, Math.ceil(cw), Math.ceil(ch));
      }
    const svg = d3.select(el).append('svg').attr('width', width).attr('height', height).style('position', 'absolute').style('left', 0).style('top', 0);
    const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
    const axis = (s) => s.call((a) => a.selectAll('text').attr('fill', theme.muted)).call((a) => a.selectAll('line,path').attr('stroke', theme.grid));
    g.append('g').attr('transform', `translate(0,${h})`).call(d3.axisBottom(x).ticks(Math.max(2, w / 80))).call(axis);
    g.append('g').call(d3.axisLeft(y).ticks(Math.max(2, h / 40))).call(axis);
    g.append('text').attr('x', w).attr('y', h + 30).attr('text-anchor', 'end').attr('fill', theme.muted).text(p.x.label);
    g.append('text').attr('transform', `translate(${-m.left + 12},${h / 2}) rotate(-90)`).attr('text-anchor', 'middle').attr('fill', theme.muted).text(p.y.label);
    svg.append('text').attr('x', width - m.right).attr('y', 16).attr('text-anchor', 'end').attr('fill', theme.faint).text(`n = ${hm.total.toLocaleString()} · 최대 ${format.number(max)}회/칸`);
    svg.on('mousemove', (e) => {
      const [px, py] = d3.pointer(e, g.node());
      const i = Math.floor(px / cw);
      const j = Math.floor((h - py) / ch);
      if (i < 0 || j < 0 || i >= hm.xBins || j >= hm.yBins) return ctx.tooltip.hide();
      ctx.tooltip.show(e.clientX, e.clientY, `${p.x.label} ${format.number(x.invert(i * cw))}~${format.number(x.invert((i + 1) * cw))}<br>${p.y.label} ${format.number(y.invert(h - j * ch))}~${format.number(y.invert(h - (j + 1) * ch))}<br><b>${hm.counts[j * hm.xBins + i]}</b>회`);
    }).on('mouseleave', () => ctx.tooltip.hide());
  },
};
