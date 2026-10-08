# Chronos Vault — 대용량 CSV 시계열 뷰어 (Windows 데스크톱)

[binjr](https://binjr.eu)의 핵심 기능을 옮긴, Obsidian 테마의 시계열 뷰어입니다.
차트 하나하나가 **위젯**이고, 워크시트(**탭**) 안에서 자유롭게 배치·크기 조절합니다.
데이터 처리는 Rust 엔진이 맡고 화면에는 그릴 점만 보내므로 **1 GB 이상 CSV**도 다룹니다.

## 설치

`Chronos Vault_<버전>_x64-setup.exe` 를 실행합니다 (현재 사용자 설치, 관리자 권한 불필요).
WebView2가 없는 PC에서는 설치 중 자동으로 내려받습니다.
코드 서명 전이라 처음 실행할 때 SmartScreen 경고가 뜨면 **추가 정보 → 실행**을 누르세요.

## 사용법

| 작업 | 방법 |
|---|---|
| CSV 열기 | 창에 끌어다 놓기, 리본의 폴더 아이콘, `Ctrl+Shift+O` |
| 워크스페이스 열기 | `.chronos` 더블클릭, `Ctrl+O`, 탐색기의 최근 파일 |
| 저장 / 다른 이름 | `Ctrl+S` / `Ctrl+Shift+S` |
| 차트 만들기 | 탐색기의 열을 위젯 위(추가) 또는 빈 공간(새 위젯)으로 끌기, 더블클릭, 파일 우클릭 → 모든 열을 차트로 |
| 시리즈 옮기기 | 범례 행을 다른 위젯으로 끌기 (`Ctrl` = 복사) |
| 줌 / 이동 | 드래그 = 구간 확대, 휠 = 줌, `Shift`+드래그·가운데 버튼 = 이동, 더블클릭 = 초기화, `←/→`, `+/-`, `A` |
| 줌 기록 | `Alt+←` / `Alt+→` |

### 워크스페이스 파일 (.chronos)

- 레이아웃과 함께 각 CSV의 **절대경로와 워크스페이스 기준 상대경로**, 크기·수정 시각, 가져오기 설정을 저장합니다.
- **전처리 결과(파싱된 값 + 블록 인덱스)는 크기와 관계없이 항상 같은 파일에 저장**됩니다.
- 다시 열 때:
  - CSV가 그대로면 저장된 전처리를 바로 읽습니다 (재파싱 없음).
  - CSV가 바뀌었으면 같은 설정으로 자동 재처리하고 파일을 갱신합니다.
  - CSV가 없으면 저장된 데이터를 그대로 씁니다.
- 폴더째 옮기면 상대경로로, 워크스페이스만 옮기면 절대경로로 찾습니다.
- 저장하기 전 작업은 앱 데이터 폴더의 **Untitled**에 자동 보관되고, 다음 실행 때 마지막 워크스페이스가 다시 열립니다.
- 헤더가 파일 끝에 있어, 레이아웃만 바뀐 저장은 수 KB만 덧붙입니다 (1 GB 파일도 수십 ms). 죽은 영역이 1/3을 넘으면 전체를 다시 씁니다.

## 성능 (16M 행 × 6열, 약 1 GB CSV)

측정 환경은 4코어 리눅스 VM이고, 메모리 페이지 할당이 느린 환경이라 일반 PC보다 불리합니다.

| 항목 | 시간 |
|---|---|
| 가져오기 (UI 포함) | 약 2.9초 (64-bit 값), 32-bit 선택 시 메모리 절반 |
| 전체 구간 렌더 (6 시리즈) | 창 계산 약 27 ms, 다운샘플 후 화면 약 9만 점 |
| 구간 통계 (최소/최대/평균) | 약 2 ms |
| 레이아웃 저장 | 약 20 ms |
| 워크스페이스 다시 열기 | 약 1초 |

## 구조

```
engine/          Rust 데이터 엔진 (chronos-engine)
  src/csv.rs       미리보기·감지, 병렬 파서 (mmap + rayon, 단일 할당), 따옴표 파일 경로
  src/time.rs      타임스탬프 파싱 (ISO / D.M.Y / M/D/Y / epoch)
  src/series.rs    값 저장 (f64/f32), 64행 블록 인덱스, M4 다운샘플, 구간 통계
  src/chronos.rs   .chronos v3 형식 (끝에 헤더, 추가 저장, 경로 해석)
  src/lib.rs       Engine::call — 모든 명령의 단일 진입점
  examples/bench.rs  1 GB 벤치마크
src-tauri/       Tauri 2 앱: engine 명령, 대화상자, 단일 인스턴스, .chronos 연결
engine-bridge/   테스트용 HTTP 브리지 (배포하지 않음)
src/             UI (TypeScript, uPlot, gridstack)
  engine.ts        엔진 클라이언트 (Tauri invoke / 브리지)
  project.ts       워크스페이스 파일, 자동 보관, 최근 파일
  ui/              셸, 위젯, 탐색기, 속성, 탭, 드래그 앤 드롭
```

## 개발

필요: Node 20+, Rust (stable), Windows에서는 WebView2.

```bash
npm install
npm run app:dev        # 데스크톱 앱 개발 실행 (Windows/macOS/Linux)
npm run app:build      # 현재 OS용 설치 파일 (Windows: NSIS)
cargo test -p chronos-engine --release
```

리눅스에서 Windows 설치 파일 교차 빌드:

```bash
sudo apt install nsis lld llvm clang
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
PATH=/usr/lib/llvm-18/bin:$PATH npm run app:build:win
# → target/x86_64-pc-windows-msvc/release/bundle/nsis/Chronos Vault_<버전>_x64-setup.exe
```

브라우저에서 실제 엔진으로 UI 테스트:

```bash
npm run bridge &                 # http://127.0.0.1:7878
npm run dev                      # http://localhost:5173/?bridge=http://127.0.0.1:7878
```
