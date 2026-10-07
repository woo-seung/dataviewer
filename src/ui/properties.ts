import { Camera, Copy, Download, Trash2, X } from 'lucide';
import { store } from '../store';
import type { SeriesRef, WidgetState, YAxisOptions } from '../types';
import { PALETTE, SLOT_NAMES, resolveColor, slotColor, slotIndex } from '../palette';
import { formatDuration, formatTime } from '../data/time';
import { formatCount, h, icon, iconButton } from '../util';
import { CHART_TYPES } from './chartWidget';
import type { WorksheetView } from './worksheetView';

export function toggle(on: boolean, onChange: (v: boolean) => void, label = ''): HTMLElement {
  const t = h('div', { class: `checkbox-container ${on ? 'is-enabled' : ''}`, role: 'switch', tabindex: 0, 'aria-checked': String(on), 'aria-label': label });
  const flip = () => {
    on = !on;
    t.classList.toggle('is-enabled', on);
    t.setAttribute('aria-checked', String(on));
    onChange(on);
  };
  t.addEventListener('click', flip);
  t.addEventListener('keydown', (e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), flip()));
  return t;
}

function row(name: string, control: HTMLElement, desc = ''): HTMLElement {
  return h(
    'div',
    { class: 'setting-item' },
    h('div', { class: 'setting-item-info' }, h('div', { class: 'setting-item-name' }, name), desc ? h('div', { class: 'setting-item-description' }, desc) : null),
    h('div', { class: 'setting-item-control' }, control),
  );
}

function numInput(v: number | null, onChange: (v: number | null) => void, placeholder = '', step = 'any'): HTMLInputElement {
  const i = h('input', { type: 'number', value: v ?? '', placeholder, step, class: 'num-input' });
  i.addEventListener('change', () => onChange(i.value === '' ? null : Number(i.value)));
  return i;
}

function textInput(v: string, onChange: (v: string) => void, placeholder = ''): HTMLInputElement {
  const i = h('input', { type: 'text', value: v, placeholder });
  i.addEventListener('change', () => onChange(i.value));
  return i;
}

export class PropertiesPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private busy = false;
  getView: () => WorksheetView | null = () => null;

  constructor() {
    this.body = h('div', { class: 'properties-body' });
    this.el = h('div', { class: 'properties' }, h('div', { class: 'nav-header' }, h('div', { class: 'pane-title' }, '속성')), this.body);
    const refresh = () => !this.busy && this.render();
    store.on('selection', refresh);
    store.on('widget', (p) => p.id === store.ws.selectedWidgetId && refresh());
    store.on('widgets', refresh);
    store.on('active', refresh);
    store.on('range', refresh);
    store.on('settings', refresh);
    store.on('worksheets', refresh);
    this.render();
  }

  private mut(fn: () => void) {
    this.busy = true;
    try {
      fn();
    } finally {
      this.busy = false;
    }
  }

  private render() {
    const sel = store.ws.selectedWidgetId;
    const found = sel ? store.findWidget(sel) : null;
    this.body.replaceChildren();
    if (found) this.renderWidget(found.ws.id, found.w);
    else this.renderSheet();
  }

  private section(title: string, ...children: (HTMLElement | null)[]) {
    this.body.append(h('div', { class: 'prop-section' }, h('div', { class: 'prop-section-title' }, title), ...children));
  }

  private renderSheet() {
    const ws = store.active;
    const r = store.sheetRange(ws.id);
    const ext = store.sheetExtent(ws.id);
    const points = ws.widgets.reduce((n, w) => n + w.series.reduce((m, s) => m + (store.sources.get(s.sourceId)?.time.length ?? 0), 0), 0);
    this.section(
      '워크시트',
      row('이름', textInput(ws.name, (v) => store.renameWorksheet(ws.id, v))),
      row('크로스헤어', toggle(ws.crosshair, (v) => store.updateWorksheet(ws.id, { crosshair: v }), '크로스헤어'), '연동된 모든 차트에 커서 동기화'),
      h(
        'div',
        { class: 'prop-stats' },
        h('div', {}, h('span', {}, '위젯'), h('b', {}, String(ws.widgets.length))),
        h('div', {}, h('span', {}, '시리즈'), h('b', {}, String(ws.widgets.reduce((n, w) => n + w.series.length, 0)))),
        h('div', {}, h('span', {}, '원본 포인트'), h('b', {}, formatCount(points))),
        h('div', {}, h('span', {}, '표시 구간'), h('b', {}, r ? formatDuration(r.end - r.start) : '—')),
      ),
      r ? h('div', { class: 'prop-note' }, `${formatTime(r.start)}\n→ ${formatTime(r.end)}`) : null,
      ext ? h('div', { class: 'prop-note muted' }, `데이터 범위: ${formatTime(ext.start)} → ${formatTime(ext.end)}`) : null,
    );
    const s = store.ws.settings;
    this.section(
      '보기 설정',
      row('다크 테마', toggle(s.theme === 'dark', (v) => store.updateSettings({ theme: v ? 'dark' : 'light' }), '다크 테마')),
      row('Y축 줌 허용', toggle(s.zoomY, (v) => store.updateSettings({ zoomY: v }), 'Y축 줌'), '박스/휠 줌을 값 축에도 적용'),
      row('드래그로 이동', toggle(s.dragMode === 'pan', (v) => store.updateSettings({ dragMode: v ? 'pan' : 'zoom' }), '드래그 이동'), '끄면 드래그가 구간 확대'),
      row(
        '기본 최대 포인트',
        numInput(s.defaultMaxPoints, (v) => store.updateSettings({ defaultMaxPoints: Math.max(0, v ?? 0) }), '4000', '500'),
        '새 위젯의 시리즈당 렌더 포인트 (0 = 제한 없음)',
      ),
      row(
        '캐시 한도 (MB)',
        numInput(s.cacheLimitMb, (v) => store.updateSettings({ cacheLimitMb: Math.max(0, v ?? 0) }), '400', '50'),
        '이보다 큰 데이터는 브라우저에 저장하지 않음 (새로고침 후 파일 다시 열기)',
      ),
    );
    this.body.append(h('div', { class: 'prop-hint' }, '위젯을 클릭하면 해당 위젯의 속성이 여기에 표시됩니다.'));
  }

  private renderWidget(wsId: string, w: WidgetState) {
    const upd = (patch: Partial<WidgetState>) => this.mut(() => store.updateWidget(wsId, w.id, patch));
    const updY = (patch: Partial<YAxisOptions>) => {
      upd({ yAxis: { ...w.yAxis, ...patch } });
      this.render();
    };

    const types = h('div', { class: 'segmented' });
    for (const c of CHART_TYPES) {
      const b = h('button', { type: 'button', class: w.type === c.type ? 'is-active' : '', title: c.label, 'aria-label': c.label }, icon(c.icon, 15));
      b.addEventListener('click', () => store.setChartType(wsId, w.id, c.type));
      types.append(b);
    }
    const lw = h('input', { type: 'range', min: 0.5, max: 5, step: 0.5, value: w.lineWidth, class: 'slider' });
    lw.addEventListener('input', () => upd({ lineWidth: Number(lw.value) }));

    const view = this.getView();
    const head = h(
      'div',
      { class: 'prop-header' },
      h('div', { class: 'prop-header-title' }, w.title),
      iconButton(Camera, '스냅샷', () => void view?.widget(w.id)?.snapshot()),
      iconButton(Download, 'CSV 내보내기', () => view?.widget(w.id)?.exportCsv()),
      iconButton(Copy, '복제', () => store.duplicateWidget(wsId, w.id)),
      iconButton(Trash2, '삭제', () => store.removeWidget(wsId, w.id)),
      iconButton(X, '선택 해제', () => store.select(null)),
    );
    this.body.append(head);

    this.section(
      '위젯',
      row('제목', textInput(w.title, (v) => v.trim() && store.updateWidget(wsId, w.id, { title: v.trim() }))),
      row('차트 유형', types),
      row('타임라인 연동', toggle(w.linked, (v) => {
        this.mut(() => store.updateWidget(wsId, w.id, v ? { linked: true } : { linked: false, range: store.sheetRange(wsId) }));
        store.emit('range', wsId);
      }, '타임라인 연동'), '워크시트 시간축과 줌/이동 공유'),
      row('범례 테이블', toggle(w.showLegend, (v) => upd({ showLegend: v }), '범례')),
      row('선 굵기', lw),
      row('마커 표시', toggle(w.markers, (v) => upd({ markers: v }), '마커')),
      row('최대 포인트', numInput(w.maxPoints, (v) => upd({ maxPoints: Math.max(0, v ?? 0) }), '0 = 제한 없음', '500'), 'M4 다운샘플링 (시리즈당, 0 = 원본)'),
    );

    const y = w.yAxis;
    this.section(
      'Y축',
      row('자동 범위', toggle(y.auto, (v) => updY({ auto: v }), '자동 범위')),
      y.auto ? null : row('최소', numInput(y.min, (v) => updY({ min: v }))),
      y.auto ? null : row('최대', numInput(y.max, (v) => updY({ max: v }))),
      row('0 포함', toggle(y.includeZero, (v) => updY({ includeZero: v }), '0 포함')),
      row('로그 스케일', toggle(y.log, (v) => updY({ log: v }), '로그 스케일')),
      row('SI 접두사', toggle(y.siPrefix, (v) => updY({ siPrefix: v }), 'SI 접두사'), 'k, M, G … 로 축약'),
      row('단위', textInput(y.unit, (v) => updY({ unit: v.trim() }), '예: °C, %, V')),
    );

    const list = h('div', { class: 'series-list' });
    w.series.forEach((s) => list.append(this.seriesEditor(wsId, w, s)));
    if (!w.series.length) list.append(h('div', { class: 'prop-hint' }, '탐색기에서 시리즈를 위젯으로 드래그하세요.'));
    this.section(`시리즈 (${w.series.length})`, list);
  }

  private seriesEditor(wsId: string, w: WidgetState, s: SeriesRef): HTMLElement {
    const theme = store.ws.settings.theme;
    const upd = (patch: Partial<SeriesRef>) => this.mut(() => store.updateSeries(wsId, w.id, s.id, patch));
    const color = resolveColor(s.color, theme);
    const swatches = h('div', { class: 'swatches' });
    PALETTE[theme].forEach((c, i) => {
      const b = h('button', {
        type: 'button',
        class: `swatch ${slotIndex(s.color) === i ? 'is-active' : ''}`,
        style: `--swatch:${c}`,
        title: SLOT_NAMES[i],
        'aria-label': `색상 ${SLOT_NAMES[i]}`,
      });
      b.addEventListener('click', () => {
        store.updateSeries(wsId, w.id, s.id, { color: slotColor(i) });
      });
      swatches.append(b);
    });
    const custom = h('input', { type: 'color', value: color, class: 'color-input', title: '사용자 지정 색상' });
    custom.addEventListener('change', () => store.updateSeries(wsId, w.id, s.id, { color: custom.value }));
    swatches.append(custom);
    const src = store.sources.get(s.sourceId);

    const card = h(
      'div',
      { class: `series-card ${s.visible ? '' : 'is-hidden'}` },
      h(
        'div',
        { class: 'series-card-head' },
        h('span', { class: 'series-dot', style: `--swatch:${color}` }),
        textInput(s.label, (v) => v.trim() && upd({ label: v.trim() })),
        toggle(s.visible, (v) => {
          upd({ visible: v });
          card.classList.toggle('is-hidden', !v);
        }, '보이기'),
        iconButton(Trash2, '제거', () => store.removeSeries(wsId, w.id, [s.id])),
      ),
      h('div', { class: 'series-card-src' }, `${src?.name ?? store.ws.sourceMeta?.find((m) => m.id === s.sourceId)?.name ?? '(없는 소스)'}${src ? '' : ' (로드 안 됨)'} › ${s.column}`),
      swatches,
      h(
        'div',
        { class: 'series-transform' },
        h('label', {}, '× 배율', numInput(s.scale, (v) => upd({ scale: v ?? 1 }), '1')),
        h('label', {}, '+ 오프셋', numInput(s.offset, (v) => upd({ offset: v ?? 0 }), '0')),
      ),
    );
    return card;
  }
}
