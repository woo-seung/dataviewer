/**
 * The plugin specification copied for an LLM ("플러그인 명세서 복사"): the
 * contract, the data API, rules, a complete example and the user's current
 * columns, ending with what to output.
 */
import exampleSrc from './builtin/scatter-regression.js?raw';
import { store } from '../store';

function columnsSection(): string {
  const lines: string[] = [];
  for (const s of store.sources.values()) {
    const cols = s.columns.slice(0, 60).map((c) => c.name);
    lines.push(`- ${s.name} (${s.rows.toLocaleString()}행): ${cols.join(', ')}${s.columns.length > 60 ? ` … 외 ${s.columns.length - 60}개` : ''}`);
  }
  return lines.length ? lines.join('\n') : '- (아직 불러온 데이터가 없습니다)';
}

export function pluginSpec(): string {
  return `# Chronos Vault 차트 플러그인 명세서

당신은 **Chronos Vault**(브라우저용 시계열 CSV 뷰어)의 차트 플러그인을 작성합니다.
플러그인은 **JavaScript 파일 하나**이며, 워크시트의 위젯 하나를 그립니다.
아래 규칙과 API를 정확히 따르세요. 사용자가 원하는 그래프는 이 명세서 뒤에 적혀 있습니다.

## 1. 파일 형식

\`\`\`js
export default {
  id: 'my-chart',            // 영문 소문자·숫자·-·_·. (2~64자). 같은 id로 다시 불러오면 업데이트됩니다.
  name: '보여줄 이름',
  version: '1.0.0',
  description: '한 줄 설명',
  params: { /* 사용자가 위젯마다 지정하는 파라미터 (아래 2장) */ },
  async render(ctx) { /* 그리기 (아래 3장) */ },
};
\`\`\`

- **import 금지.** d3 v7이 전역 \`d3\`(그리고 \`ctx.d3\`)로 이미 있습니다. 다른 라이브러리는 없습니다.
- 네트워크·저장소 접근은 막혀 있습니다 (fetch, localStorage, 외부 이미지/폰트 모두 불가).
- 파일 하나에 모든 코드를 넣으세요. 보조 함수는 render 안이나 객체 밖 최상위에 둬도 됩니다.

## 2. params (파라미터 정의)

키 = 파라미터 이름, 값 = 정의. 사용자는 위젯 속성 패널에서 값을 고르고, 바뀌면 render가 다시 호출됩니다.

| type | 추가 필드 | render에서 받는 값 |
|---|---|---|
| \`column\` | \`optional?\` | \`{ source, column, label }\` 또는 \`null\` |
| \`columns\` | \`min?\`, \`max?\` | \`[{ source, column, label }, …]\` |
| \`number\` | \`default?\`, \`min?\`, \`max?\`, \`step?\` | number |
| \`select\` | \`options\`: 문자열 배열 또는 \`[{ value, label }]\`, \`default?\` | 선택한 value (string) |
| \`boolean\` | \`default?\` | boolean |
| \`text\` | \`default?\` | string |
| \`color\` | \`default?\` ('#rrggbb') | string |

모든 정의에 \`label\`(한국어 권장)과 선택적 \`description\`이 있습니다.
열(column/columns) 파라미터가 아직 지정되지 않았을 수 있으니, 그 경우 안내 문구를 그리고 끝내세요.

## 3. render(ctx)

위젯 크기·파라미터·시간 범위·테마가 바뀔 때마다 호출됩니다. 호출될 때마다 \`ctx.el\`은 비워져 있으니 처음부터 다시 그리세요.

| ctx | 설명 |
|---|---|
| \`el\` | 그릴 곳 (HTMLDivElement, \`position:absolute; inset:0\`). SVG/Canvas/HTML 무엇이든 append |
| \`width\`, \`height\` | 그릴 영역 크기 (px) |
| \`params\` | 2장의 값 |
| \`range\` | 워크시트의 현재 시간 범위 \`{ start, end }\` (epoch ms, UTC) 또는 null |
| \`theme\` | \`{ dark, text, muted, faint, grid, background, accent, palette: [8색], font }\` — 이 색을 쓰세요 (배경은 투명) |
| \`data\` | 데이터 함수 (4장). 모두 Promise |
| \`format.time(ms, withSeconds?)\` | 'YYYY-MM-DD HH:MM' (UTC) |
| \`format.number(v, digits=4)\` | 보기 좋은 숫자 문자열 |
| \`tooltip.show(clientX, clientY, html)\`, \`tooltip.hide()\` | 마우스 툴팁 |
| \`setRange(start, end)\` | 워크시트 시간 범위를 바꿈 (예: 셀 클릭 → 그 날짜로 확대) |
| \`signal\` | AbortSignal. 더 새로운 render가 시작되면 aborted — await 뒤에 \`if (ctx.signal.aborted) return;\` |
| \`state\` | 렌더 사이에 유지되는 빈 객체 (캐시 등) |
| \`zoom\` | 사용자가 확대/이동한 보기 \`{ x: [min, max] \| null, y: [min, max] \| null }\` (데이터 단위) 또는 null — 있으면 축 domain으로 쓰세요 |
| \`enableZoom({ x, y, area })\` | 그린 뒤 호출하면 **드래그 = 이동, Ctrl+드래그 = 박스 확대, Ctrl+휠 = 커서 기준 확대/축소, Shift+휠 = 좌우 이동, 더블클릭 = 전체** 가 켜집니다. x·y는 d3 연속 스케일(\`invert\` 필요, 한쪽만 줘도 됨), area는 \`{ left, top, width, height }\` = ctx.el 기준 플롯 영역(스케일 range는 이 영역 안 좌표 0…width / height…0). 연속 축이 있는 차트라면 꼭 호출하세요 |
| \`hoverPoints({ x, y, xScale, yScale, area, label })\` | 그린 점들을 등록하면 커서가 가까이(14px) 가면 그 점에 표시를 하고 \`label(i)\`가 돌려준 HTML(이름·값·시각 등)을 커서 옆에 띄웁니다. x·y = 데이터 값 배열, xScale·yScale = 그린 스케일, area = enableZoom과 같은 플롯 영역. 점·선 그래프라면 꼭 호출하세요 (크로스헤어는 enableZoom만 하면 자동) |
| \`d3\` | d3 v7 |

## 4. ctx.data — 데이터 (엔진이 전체 데이터에서 계산, 결과만 전달)

시간 옵션 \`{ start, end }\`를 생략하면 **현재 보이는 시간 범위**, \`{ all: true }\`면 전체 데이터입니다.
값 배열은 Float64Array이며 빈 값은 NaN입니다. 시각은 epoch ms(UTC)입니다.

| 함수 | 반환 |
|---|---|
| \`columns()\` | 불러온 모든 열 \`[{ source, column, label, sourceName, rows, start, end, min, max, mean }]\` |
| \`stats(columns, opts?)\` | 열마다 \`{ min, max, mean, count }\` 또는 null |
| \`series(column, { maxPoints?, …opts })\` | 시간축 다운샘플(M4) \`{ t, v, total }\` — 선 그래프용 |
| \`raw(column, { limit=200000, …opts })\` | 원본 샘플(균등 간격으로 솎음) \`{ t, v, total }\` |
| \`aligned(columns, { maxRows=20000, …opts })\` | **같은 시각에 모두 값이 있는 행**만 \`{ t, columns: [Float64Array…], total }\` — 산점도·상관 등 |
| \`regression(x, y, { normalize?, …opts })\` | 전체 짝에 대한 최소제곱 \`{ n, slope, intercept, r, r2, xMean, yMean, xMin, xMax, yMin, yMax, normalized, r2Identity }\` — \`normalize: true\`면 x·y를 0–1(최소–최대)로 바꾼 뒤 계산 (r·R²는 같고 기울기·절편이 바뀜). \`r2Identity\` = y = x 선 기준 R² |
| \`histogram(column, { bins=50, min?, max?, …opts })\` | \`{ min, max, counts: number[], total }\` |
| \`histogram2d(x, y, { xBins=50, yBins=50, xMin?, xMax?, yMin?, yMax?, …opts })\` | \`{ xMin, xMax, yMin, yMax, xBins, yBins, counts (행 우선: counts[yi*xBins+xi]), total }\` |
| \`buckets(column, { keys: [k1, k2?], …opts })\` | 달력 집계 \`[{ a, b, count, mean, min, max, sum }]\` — 키: \`hour\`(0–23), \`minute\`, \`weekday\`(0=월), \`dayOfMonth\`, \`month\`(1–12), \`year\`, \`day\`(1970-01-01부터 일수), \`yearMonth\`(1970-01부터 월수). a=k1 값, b=k2 값 |

**대용량 주의:** 데이터는 수천만 행일 수 있습니다. 원본 전체를 가져오지 말고 위 집계 함수와 maxRows/limit를 쓰세요. 점은 수만 개 이상이면 Canvas로 그리세요.

## 5. 규칙

- 한국어 라벨, 축·눈금·범례를 갖춘 읽기 쉬운 그래프. \`theme\`의 색과 \`palette\`를 쓰세요.
- 크기가 작아도(예: 240×150) 깨지지 않게 여백을 계산하세요.
- 예외는 던져도 됩니다 (위젯에 오류로 표시됨). 하지만 열이 비었을 때는 안내 문구로 처리하세요.
- 시간 범위가 바뀌면 다시 그려지므로, 보이는 범위 기준으로 계산하는 것이 기본입니다.
- 점 툴팁은 \`ctx.hoverPoints\`로 (막대·셀처럼 영역이 있는 그래프는 \`ctx.tooltip\`을 직접 써도 됩니다).
- 확대/이동은 직접 구현하지 말고 \`ctx.zoom\` + \`ctx.enableZoom\`을 쓰세요 (앱 전체와 같은 조작: 드래그 = 이동, Ctrl+드래그 = 확대, Ctrl+휠 = 확대/축소).

## 6. 완전한 예제 (내장 "산점도 + 회귀" 플러그인)

\`\`\`js
${exampleSrc.trim()}
\`\`\`

## 7. 사용자의 현재 데이터 (참고용 — 열은 파라미터로 받으세요)

${columnsSection()}

## 8. 출력

위 형식의 플러그인 코드 **전체를 하나의 \`\`\`js 코드 블록으로만** 출력하세요. 설명은 코드 블록 앞에 짧게만.

---

## 만들 그래프 (사용자 요청)

`;
}
