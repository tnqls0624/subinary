# sandbox iframe 게임 엔진 실행 검증

실행일: 2026-09-06 KST. 지시서와 선행 조사 파일의 2026-09 명칭을 유지했다.

**Phaser로 진행 가능하다.** `sandbox="allow-scripts"`를 유지한 실제 Chromium에서 Phaser 4.2.1의 부팅, WebGL 렌더링, 업데이트 루프, 인라인 PNG, 캔버스 생성 텍스처, 부모 메시지 왕복을 실행했다. 다만 CORS 헤더가 없는 동봉 PNG·JSON의 상대경로 로딩은 실패하므로 자산 제공 경로를 정해야 한다. 이 결과는 Capacitor 실기기 출하 검증을 대신하지 않는다.

## 환경과 재현

- macOS 26.5.0, ARM64, Aside의 Chromium `151.0.7922.171` 실제 브라우저.
- HTTP: `http://127.0.0.1:8765/index.html`, Python 3.13.0 `http.server`.
- 부모와 자식, PNG와 JSON은 같은 서버·디렉터리다. iframe 속성은 `sandbox="allow-scripts"`뿐이며 `allow-same-origin`을 추가하지 않았다.
- `tile.png`는 자체 생성 32×32 PNG, 104 B. HTTP 200, `Content-type: image/png`, **Access-Control-Allow-Origin 없음**을 응답과 서버 로그에서 확인했다.
- UMD는 CDN에서 버전 고정 파일을 검증 폴더에 내려받아 일반 `<script src>`로 제공했다. 프로젝트 의존성 추가나 기존 앱 코드 변경은 없다.
- 부모 수신 로그의 두 iframe `event.origin`은 모두 `"null"`이었다. 부모는 `event.source`를 iframe `contentWindow`와 비교한다.

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory scripts/verify-sandbox-engine
```

브라우저에서 위 HTTP URL을 열고 Phaser 캔버스를 클릭한다. 재검증 파일 설명은 [README](../scripts/verify-sandbox-engine/README.md)에 있다.

## Phaser 결과

| 항목 | 판정 | 실행 증거 |
|---|---|---|
| 1. UMD 로딩과 `new Phaser.Game` | **통과** | `engine PASS`, version `4.2.1`, renderer `2`(WebGL), 400×280 canvas, `loop PASS {frames:60}` |
| 2. 동일 디렉터리 PNG `this.load.image()` | **실패** | `external-image FAIL`, XHR status `0`, 아래 CORS 오류 |
| 3a. data URI PNG `this.load.image()` | **통과** | `inline-image PASS {width:32}`, 엔진 텍스처 등록 및 이미지 생성 |
| 3b. 캔버스 생성 텍스처 | **통과** | `createCanvas` → fillRect → refresh → `add.image`, `canvas-texture PASS {width:32}` |
| 4. 타일맵 JSON `this.load.json()` | **실패** | `external-json FAIL`, XHR status `0`, 아래 CORS 오류; JSON 파일 읽기 검증이며 완성된 타일맵 렌더링 시험은 아님 |
| 5a. 마우스→엔진 pointer | **통과** | `pointer PASS`, `type:mousedown`, `wasTouch:false`, `isTrusted:true`, 좌표 `(198,137)` |
| 5b. 터치 | **통과 — 브라우저 에뮬레이션** | 터치 에뮬레이션을 켠 뒤 Phaser 재초기화, CDP `Input.dispatchTouchEvent` → `type:touchstart`, `wasTouch:true`, `isTrusted:true`, `(210,223)`; 실기기는 **확인 못 함** |
| 6. 부모 postMessage 왕복 | **통과** | 자식 ping → 부모 ack revision 7 → 자식 roundtrip PASS → 부모 수신 |

Phaser PNG 오류 원문:

```text
Access to XMLHttpRequest at 'http://127.0.0.1:8765/tile.png' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.
Failed to load resource: net::ERR_FAILED
```

Phaser JSON 오류 원문:

```text
Access to XMLHttpRequest at 'http://127.0.0.1:8765/map.json' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.
Failed to load resource: net::ERR_FAILED
```

브라우저의 iframe CDP `Log.entryAdded`에서 수집한 오류다. status 0만 보고 CORS로 추정한 것이 아니다. 부모 콘솔의 VERIFY 로그와 iframe 브라우저 보안 로그는 별개라 프레임별 수집이 필요했다.

터치 활성화 전에 만든 Phaser 인스턴스에 터치를 보내면 호환 마우스 이벤트가 관찰됐다. 터치 에뮬레이션 활성화 후 엔진을 재초기화한 별도 실행에서 위 `touchstart`를 확보했다. DOM에 가짜 이벤트를 dispatch한 시험이 아니다. `pointerType`은 원본 TouchEvent/MouseEvent에서 undefined라 JSON에 생략된다.

스크린샷 [engines-observed.png](../scripts/verify-sandbox-engine/evidence/engines-observed.png)를 직접 확인했다. 두 프레임에서 인라인 PNG는 초록 사각형으로 보이며, Phaser 생성 텍스처와 Excalibur Actor는 노란색으로 보인다. 외부 이미지 위치는 비어 있다. [원시 관측 JSON](../scripts/verify-sandbox-engine/evidence/sandbox-findings.json)과 [전체 화면](../scripts/verify-sandbox-engine/evidence/sandbox-verify-full.png)에 엔진·입력·로그 증거를 보존했다.

## Excalibur 비교

| 항목 | 판정 | 실행 증거 |
|---|---|---|
| 1. UMD 로딩과 `new ex.Engine`, start | **통과** | version `0.32.0`, 400×280 canvas, `engine PASS`, `loop PASS {frames:60}` |
| 2. `new ex.ImageSource('tile.png').load()` | **실패** | Excalibur 문서 URL의 `Log.entryAdded`에서 PNG CORS 차단 확인; 이미지 표시 없음 |
| 4. `new ex.Resource('map.json','json').load()` | **실패** | Excalibur 문서 URL의 `Log.entryAdded`에서 JSON CORS 차단 확인; 로드 성공 결과 없음 |
| 추가: data URI ImageSource | **통과** | `inline-image PASS {width:32}`, Sprite 생성 |
| 추가: 부모 왕복 | **통과** | origin null, revision 7 roundtrip PASS |

처음에는 검증 HTML에서 body가 생기기 전에 엔진을 실행해 `TypeError: Cannot read properties of null (reading 'appendChild')`가 발생했다. 검증 HTML에 body를 명시하고 iframe URL을 `?v=2`로 바꿔 캐시를 갱신한 다음 재실행하자 엔진·루프가 통과했다. 이는 수정한 테스트 하네스 결함이며 sandbox 비호환으로 분류하지 않는다.

Excalibur의 두 오류 원문은 다음과 같다. 브라우저 로그의 발생 문서 URL은 `http://127.0.0.1:8765/excalibur.html?v=2`이며 Phaser 오류를 대신 인용한 것이 아니다.

```text
Access to XMLHttpRequest at 'http://127.0.0.1:8765/tile.png' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.
Access to XMLHttpRequest at 'http://127.0.0.1:8765/map.json' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.
Failed to load resource: net::ERR_FAILED
```

**차이점:** Phaser는 `loaderror`를 반환한 뒤 씬 실행을 계속했다. Excalibur는 두 외부 자산에서 `.then/.catch` 결과 행이 나오지 않았지만 브라우저 CORS 차단은 명확했다. [0.32.0 배포 소스](https://cdn.jsdelivr.net/npm/excalibur@0.32.0/build/dist/excalibur.js)의 `Resource.load()`는 XHR `error`에서 자체 이벤트만 emit하고 Promise를 reject하지 않는다. 이 소스 경로는 관찰된 미완료 상태를 설명한다. Excalibur를 채택한다면 로더 오류 이벤트와 시간 제한을 연결해 로딩 화면이 무기한 대기하지 않도록 처리하는 추가 비용이 있다.

## 우회 방법과 비용

| 방법 | 이번 실행 판정 | 비용·제약 |
|---|---|---|
| Phaser data URI PNG | **통과** | base64 문자열 길이는 이 104 B PNG에서 140자이며 URI 접두부가 추가된다. 일반적으로 인코딩 길이는 `4×ceil(n/3)`이며 압축 전 수치다. 큰 atlas는 JS 파싱·문자열 메모리와 캐시 갱신 단위를 고려해야 한다. |
| Phaser canvas 생성 텍스처 | **통과** | 외부 이미지 요청 없이 초기 도형 표현 가능. 복잡한 그림은 생성 코드나 별도 자산 파이프라인을 작성해야 한다. |
| JSON을 일반 JS 데이터로 동봉하거나 부모 메시지로 전달 | **확인 못 함** | 이 시험의 메시지 왕복은 작은 상태 객체만 사용했다. 실제 지도 크기·스키마·엔진 캐시 등록 경로는 추가 구현 및 검증이 필요하다. |
| 공개 정적 PNG/JSON에 CORS 허용 헤더 설정 | **확인 못 함** | 서버·CDN 설정과 자산 요청 모드 검증이 필요하다. 이번 서버에 헤더를 추가한 성공 대조시험은 수행하지 않았다. Capacitor 로컬 scheme에 그대로 적용된다고 가정할 수 없다. |

권장 후속 작업은 초기 이미지를 인라인/생성 텍스처로 구성하고, 지도 데이터 경로를 구현한 뒤 iOS·Android 실제 WebView에서 동일 sandbox로 부팅·터치·복원을 확인하는 것이다. Excalibur로 바꿔도 이번 외부 PNG·JSON의 CORS 차단은 동일했다.

## 검증 범위와 자료

실기기 터치, Capacitor 로컬 scheme, CSP, 오디오, 실제 atlas·Tiled 전체 가져오기, 오프라인 재시작, 장시간 성능·메모리, 제품 저장 브리지의 재시도·스키마 처리는 **확인 못 함**이다. 60회 업데이트는 루프 생존 증거이며 FPS 벤치마크가 아니다.

검증 스크립트 3개의 `node --check`와 `git diff --check`가 통과했다. Next.js 앱 코드나 의존성을 바꾸지 않아 앱 전체 빌드·테스트는 수행하지 않았다. 정상 경로(인라인 자산·통신), 경계(불투명 출처의 같은 서버 자산), 오류(CORS 및 로더 미완료)를 실제 브라우저에서 확인했다.

외부 API는 [Phaser LoaderPlugin](https://docs.phaser.io/api-documentation/class/loader-loaderplugin), [Excalibur ImageSource](https://excaliburjs.com/docs/imagesource/), [Resource](https://excaliburjs.com/api/class/Resource/), [Engine 시작 예제](https://excaliburjs.com/docs/getting-started/)를 확인했다. 도구 목록에 Memory·context7·sequential-thinking MCP가 없어 Memory 로드·기록 및 context7 조회는 수행하지 못했다.

SHA-256은 선행 조사와 일치한다.

```text
Phaser:    66348b1b5141e49b7d5ebbe688cddcb502eab1cb00f21c538686a5b2c5abe4de
Excalibur: fda7652d4b3f6abd00326874518186459f1889ac285568667c985f0e354319d5
```
