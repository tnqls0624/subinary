# 주택 브랜드 연동 일반화 설계 (수자인 → N개 브랜드)

- 기준 커밋: `5f88738`(수자인 분양대금조회 수정)
- 상태: 0·1·2·3·5단계를 구현했다(2026-11-08). 수자인 수정(`5f88738`)은 같은 날 운영 실조회가 성공했다(두 가구, 분양대금 9줄 + 별도 계약 품목 옵션 6줄 반영). 4단계(러너 키트)는 같은 날 코드와 테스트를 넣었다. 완료 기준의 이미지 재빌드·실조회 확인은 배포 때 한다(6장 4단계).

## 1. 배경·목표

사용자는 두 가지를 물었다. "청약 관련 브랜드가 늘어날 텐데 너무 수자인에만 맞춰져 있는 건 아닌지?", "전체적으로 코드 재활용이 필요한 상황 아닌가". 순서는 사용자가 정했다. 수자인을 먼저 고쳐 배포하고, 그다음 리팩터링한다.

목표는 다음과 같다.

1. 두 번째 브랜드를 붙일 때 서비스·계약·웹·DB 를 '고치는' 대신 '추가'만 하게 한다. 이를 위해 브랜드 목록 하나, 어댑터 하나, 등록표 한 줄, 마이그레이션 한 개를 둔다.
2. 기존 데이터를 그대로 둔다. `brand='sujain'`, `sujain_fetch`, 금고 AAD `provider='sujain'`, 지문 `sha256('sujain:'+id)` 는 재암호화나 UPDATE 없이 계속 동작한다.
3. 지금 단계에서는 화면과 응답이 바이트 단위로 같아야 한다. 각 단계는 따로 배포하고 따로 되돌릴 수 있다.
4. 운영 Mac 이미지에 Chromium 을 두 벌 넣지 않는다.

일반화는 '출력 계약'(`HousingBrandFetchedItem`)과 '프로세스 뼈대'(stdin·launch·허용 목록·결과 JSON)까지만 한다. 표 해석과 화면 수집은 두 번째 사이트 화면을 본 뒤에 정한다.

## 2. 지금 결합 지점

| 갈래 | 위치(근거) | 지금 상태 |
|---|---|---|
| 계약: 브랜드 값 | `packages/contracts/src/housing-brand-sync.ts:5` `housingBrandSchema = z.literal('sujain')` | 단일 literal |
| 계약: 중복 literal | `packages/contracts/src/manual-finance.ts:189` `brand: z.literal('sujain')` | 위와 따로 정의돼 있다. `housing-brand-sync.ts` 가 `manual-finance.js` 를 import 하므로 반대 방향 import 는 순환이 된다 |
| 계약: 사이트 상수 | `housing-brand-sync.ts:136~141` `SUJAIN_OFFICIAL` | 쓰는 곳은 정의 파일 하나뿐이다 |
| 계약: 값 출처 | `manual-finance.ts:126` `manualHousingValueSourceSchema` 의 `'sujain_fetch'`, `housing-brand-sync.ts:90` 미리보기 `source: z.literal('sujain_fetch')`, 라벨 `'신축 조회'`(132행) | 화면 글자는 이미 브랜드와 무관하다 |
| DB | `drizzle/0076_housing_brand_sync.sql` `CHECK (brand = 'sujain')`, `schema.ts:4962` `$type<'sujain'>()`, `:4979` check, `:4851·4852` value source CHECK | 마지막 마이그레이션은 0077 |
| 금고 | `apps/api/src/finance-connections/finance-vault.ts:17·26·27` `provider` 유니온, `PROVIDERS`, `CREDENTIALS_ONLY` | AAD 에 `'sujain'` 이 들어간다 |
| 서비스 | `housing-brand-sync.service.ts` 19~20행이 `SujainBrowserClient`·`isSujainUnsupportedLayout` 를 직접 import 한다. 47~52행의 `loginFingerprint`(`'sujain:'`)·`vaultContext`(`provider:'sujain'`), 117~145행의 `publicErrorMessage`(수자인 글자, `unit_not_registered` 는 'My 분양단지'라는 사이트 고유 용어), 250~285행의 금고 평문 `brand:'sujain'` 과 insert/update `brand:'sujain'`, 343~369행의 read·parseRows·0건 판정 | 어댑터 경계가 없다 |
| 서비스: 미리보기 잔존 | connect 의 update 경로(260~270행)가 `lastPreview` 를 비우지 않는다 | 브랜드를 바꿔 다시 연결하면 이전 미리보기가 남는다 |
| 동시 실행 게이트 | `sujain-browser.ts:347`, `bank-browser.ts:26` 의 `#active` | 클라이언트 인스턴스마다 따로 있다 |
| 웹 | `housing-brand-panel.tsx` 84행 `brand: "sujain"`, 94·177·179·181·195·209·213·226행의 '수자인' 글자, 217·230행 `name="sujain-login/password"`, `housing-brand-sync-error.ts:8` FALLBACK | 정적 export 번들에 들어간다 |
| 러너 | `tools/sujain-web-runner/{run,policy,collect,table-capture,urls}.mjs` | stdin·launch·route·SIGTERM·결과 JSON 뼈대가 수자인 파일 안에 섞여 있다 |
| 이미지 | `infrastructure/docker/Dockerfile.prod:94~111` 수자인 러너 폴더에서만 `npm install` 하고 headless shell 을 설치한다 | 은행 러너는 설치하지 않는다 |
| CI | `.github/workflows/ci.yml:90~92` `node --test tools/*/test/*.test.mjs` 를 직접 나열한다 | turbo 밖이다 |
| 테스트 공백 | `apps/api/src/housing-brand-sync/` 에는 public-error·browser·parse 테스트만 있다 | 서비스 단위 테스트가 없다 |

이미 브랜드와 무관한 것은 다음과 같다. `HousingBrandFetchedItem`, `matchFetchedItems`, apply(`'confirmed'` 만 쓴다), 컨트롤러 경로(`/brand-connection`·`/brand-sync`), 상태 라벨, `HousingBrandStoredPreview` 모양, active plan 당 연결 1개라는 제약.

## 3. 목표 구조

| 경로 | 책임 | 시점 |
|---|---|---|
| `packages/contracts/src/housing-brands.ts` (새 leaf) | `HOUSING_BRANDS`, `housingBrandSchema = z.enum(...)`, `HousingBrand`, `DEFAULT_HOUSING_BRAND`, `HOUSING_BRAND_INFO`(label·officialSite·allowedHosts), `HOUSING_BRAND_FETCH_SOURCE = 'sujain_fetch'`. `manual-finance.ts` 와 `housing-brand-sync.ts` 가 둘 다 여기서 import 한다 | 1단계 |
| `packages/contracts/src/housing-brand-sync.ts` | `housing-brands.js` 를 다시 내보낸다. 미리보기 `source` 는 `z.literal(HOUSING_BRAND_FETCH_SOURCE)`. `SUJAIN_OFFICIAL` 은 `@deprecated` 로 남긴다 | 1단계 |
| `packages/contracts/src/manual-finance.ts` | 189행 literal 을 `housingBrandSchema` 로 바꾼다 | 1단계 |
| `apps/api/src/housing-brand-sync/brand-adapter.ts` | `HousingBrandAdapter`, `HousingBrandReadError`, `HousingBrandReadResult`. 레이아웃 진단은 인터페이스에 올리지 않는다 | 2단계 |
| `apps/api/src/housing-brand-sync/sujain-adapter.ts` | `SujainBrowserClient.read` → `parseSujainRows` → 0건이면 `unsupported_layout`. `SujainBrowserError` 를 `HousingBrandReadError` 로 바꾼다. 수자인 고유 공개 문구(`unit_not_registered`)를 덮어쓴다. `sujain-browser.ts`·`sujain-parse.ts` 는 감싸기만 하고 고치지 않는다 | 2단계 |
| `apps/api/src/housing-brand-sync/brand-registry.ts` | 생성자 주입으로 어댑터를 받아 `Map` 을 만든다. 부팅할 때 `HOUSING_BRANDS` 와 1:1 인지 검사한다. 브라우저 작업은 프로세스 전체에서 1개만 돌도록 `run()` 게이트를 둔다 | 2단계 |
| `apps/api/src/housing-brand-sync/housing-brand-match.ts` | `matchFetchedItems` 를 옮긴다. `sujain-parse.ts` 에는 재수출 한 줄만 남긴다 | 2단계 |
| `apps/api/src/housing-brand-sync/housing-brand-sync.service.ts` | `SujainBrowserClient` 대신 `HousingBrandRegistry` 를 받는다(`@Inject(HousingBrandRegistry)`). 0단계 특성 테스트가 `SujainBrowserClient` 를 직접 넣는 경우만 수자인 어댑터 하나로 등록표를 만든다. connect 는 `input.brand` 로 지문·금고 context·평문·행 brand 를 만들고(사이트를 읽지 않으므로 어댑터는 부르지 않는다), sync 는 `connection.brand` 로 어댑터를 고른다. `publicErrorMessage`·`loginFingerprint`·`vaultContext` 는 brand 를 인자로 받는다 | 2단계 |
| `apps/web/.../housing-brand-panel.tsx`, `housing-brand-sync-error.ts` | 글자와 brand 를 `HOUSING_BRAND_INFO` 에서 가져온다. 이 패널만 고치고 공용 컴포넌트는 건드리지 않는다. `name="sujain-login"` 은 유지한다 | 3단계 |
| `tools/sujain-web-runner/kit/{stdin,launch,allowlist,result}.mjs` | 브랜드 무관 러너 뼈대. `playwright-core` 는 import 하지 않고 `chromium` 을 인자로 받는다 | 4단계 |
| `tools/sujain-web-runner/test/kit-*.test.mjs` | 키트 단위 테스트와 키트 규칙 소스 검사(`kit-rules`). 기존 CI 줄(ci.yml 91행)이 잡도록 이 폴더에 둔다 | 4단계 |
| `apps/api/src/housing-brand-sync/runner-process.ts` | spawn·stdin·stdout/stderr 상한·시간 초과·SIGTERM→SIGKILL 을 공용으로 뽑는다. 응답 zod 와 stderr 거르기는 브랜드 클라이언트에 남긴다 | 두 번째 브랜드 때 |
| `tools/<러너>/brands/<id>/` | 같은 러너 디렉터리, 같은 `playwright-core`, 같은 headless shell 을 쓰는 새 브랜드 수집 코드 | 두 번째 브랜드 때 |
| `packages/database/drizzle/00NN_housing_brand_<id>.sql` | brand CHECK 를 IN 목록으로 바꾼다 | 두 번째 브랜드 때 |

어댑터 파일은 지금 `housing-brand-sync/` 바로 아래에 둔다. `adapters/sujain/` 로 옮기는 것은 파일 이동 diff 만 키우므로 두 번째 브랜드 때 판단한다.

## 4. 인터페이스

```ts
// packages/contracts/src/housing-brands.ts
export const HOUSING_BRANDS = ['sujain'] as const;
export const housingBrandSchema = z.enum(HOUSING_BRANDS);   // z.literal('sujain') 과 parse 결과·와이어가 같다
export type HousingBrand = z.infer<typeof housingBrandSchema>;
export const DEFAULT_HOUSING_BRAND: HousingBrand = 'sujain';
export type HousingBrandInfo = {
  label: string;                                // 화면 이름 '수자인'
  officialSite: `https://${string}/`;
  allowedHosts: readonly string[];              // 러너 허용 목록·문서의 단일 근거
};
export const HOUSING_BRAND_INFO = {
  sujain: { label: '수자인', officialSite: 'https://www.sujain.co.kr/', allowedHosts: ['www.sujain.co.kr', 'm.sujain.co.kr'] },
} as const satisfies Record<HousingBrand, HousingBrandInfo>;
/** 이름은 옛것이고 뜻은 '주택 브랜드 사이트에서 읽음'(브랜드 무관). 영구 토큰이며 바꾸지 않는다. */
export const HOUSING_BRAND_FETCH_SOURCE = 'sujain_fetch' as const;
```

```ts
// apps/api/src/housing-brand-sync/brand-adapter.ts
export type HousingBrandCredentials = { loginId: string; password: string };
/** matchedPaymentId=null, changedFields=[] 상태. 맞추기는 서비스가 한다. */
export type HousingBrandReadResult = {
  capturedAt: string;                 // ISO, offset 포함
  items: HousingBrandFetchedItem[];
  unreadCount: number;
  unreadReasons: string[];
};
export class HousingBrandReadError extends Error {
  constructor(readonly code: HousingBrandSyncError, readonly reason: string | null = null) {
    super('Housing brand read did not complete');
  }
}
export interface HousingBrandAdapter {
  readonly brand: HousingBrand;
  readonly available: boolean;        // false 면 read 는 runtime_unavailable
  /** 자격 증명은 stdin 으로만 넘기고 보관하지 않는다. 0건이면 unsupported_layout(빈 성공 금지). */
  read(credentials: HousingBrandCredentials, signal: AbortSignal): Promise<HousingBrandReadResult>;
  /** 브랜드 고유 용어가 필요한 코드만 덮어쓴다. null 이면 공용 문구를 쓴다. */
  publicErrorOverride?(code: HousingBrandSyncError, reason: string | null): string | null;
}
```

```ts
// apps/api/src/housing-brand-sync/brand-registry.ts
@Injectable()
export class HousingBrandRegistry {
  constructor(sujain: SujainAdapter /* , next: XAdapter */);   // HOUSING_BRANDS 와 1:1 이 아니면 생성자에서 throw → 부팅 실패
  get(brand: HousingBrand): HousingBrandAdapter;              // 없으면 HousingBrandReadError('runtime_unavailable')
  /** API 프로세스 안의 주택 브랜드 브라우저 작업을 1개로 제한한다. 이미 돌고 있으면 runtime_unavailable. */
  run<T>(brand: HousingBrand, job: (a: HousingBrandAdapter) => Promise<T>): Promise<T>;
}
```

```ts
// housing-brand-sync.service.ts (바뀌는 시그니처)
export function publicErrorMessage(code: string, reason?: string | null, brand: HousingBrand = DEFAULT_HOUSING_BRAND): string;
// 공용 문구는 `${HOUSING_BRAND_INFO[brand].label} 로그인에 실패했어요…` 꼴이다. 수자인은 지금 글자와 한 글자도 다르지 않다.
// unit_not_registered 는 SujainAdapter.publicErrorOverride 가 지금 문구('…My 분양단지…')를 그대로 돌려준다.
// publicErrorMessage 는 공개 함수라 등록표 없이도 같은 글자를 내야 해서, 어댑터와 같은 순수 함수(sujainPublicErrorOverride)를
// 서비스의 PUBLIC_ERROR_OVERRIDES: Record<HousingBrand, …> 표로도 부른다. 브랜드를 빠뜨리면 컴파일이 막힌다.
function loginFingerprint(brand: HousingBrand, loginId: string): string;   // sha256(`${brand}:${lower}`), sujain 이면 기존 값과 같다
function vaultContext(ownerUserId: string, connectionId: string, brand: HousingBrand): VaultContext; // provider: brand
```

```js
// tools/sujain-web-runner/kit/*.mjs — 순수 ESM, playwright-core 를 import 하지 않는다 (2026-11-08 구현 기준)
// stdin.mjs
export async function readJobJson(stream, { maxBytes = 8192, onError, onReadComplete, validate }); // 넘치거나 깨지거나 validate 가 던지면 onError('operation_unknown') 를 던진다. onReadComplete 는 해석 직전에 부른다
// launch.mjs
export function chromiumSandboxEnabled(getuid = process.getuid);         // root 일 때만 false
export function isAbsoluteExecutable(value);
export async function launchHeadless({ chromium, executablePath, chromiumSandbox, timeoutMs = 20_000, timezone = 'Asia/Seoul', sourceEnv = process.env }); // 절대 경로, chromiumSandbox 는 boolean 필수, env 는 PATH·TZ 만
export async function openIsolatedContext(browser);                      // acceptDownloads:false, serviceWorkers:'block'
export function createCloser(getters);                                   // 받은 순서(context → browser)대로 한 번만 닫고 오류는 삼킨다
export function installSignalCleanup(close, proc = process);             // SIGTERM·SIGINT → close 뒤 exit(0). 떼는 함수를 돌려준다
// allowlist.mjs
export function makeOriginAllowlist(origins);                            // username·password 가 붙은 URL 은 거절. 항목이 bare origin 이 아니면 throw
export async function routeAllowlist(context, allowed);
// result.mjs
export function sanitizeErrorName(error);                                // 영문자만, 40자
export function buildFailurePayload({ error, code, allowedCodes, failureReason, stage, classify }); // 허용 목록 밖 code 는 operation_unknown. layout 은 받지 않는다
export function writeResult(payload, out = process.stdout);
```

처음 스케치와 달라진 점은 다음과 같다. 모두 0단계 출력 고정(`test/output-shape.test.mjs`)과 기존 `test/policy.test.mjs` 를 고치지 않고 통과시키려고 정한 것이다.

- `launchHeadless` 는 `getuid` 대신 `chromiumSandbox`(boolean, 기본값 없음)를 받는다. 빠뜨리면 Playwright 기본값(꺼짐)으로 조용히 떨어지기 때문이다. `run.mjs` 가 `chromiumSandboxEnabled()` 로 정해 넘긴다.
- 기동과 context 를 나눴다(`openIsolatedContext`). 실패 JSON 의 stage 가 `launch`(사유 `chromium_launch_failed`)와 `context` 로 갈린다. 실행 파일 절대 경로 검사(`isAbsoluteExecutable`)도 `run.mjs` 가 `import` 단계에서 먼저 부른다.
- `readJobJson` 에 `onReadComplete`·`validate` 를 더했다. 넘침은 stage `stdin`, 깨진 JSON 은 stage `validate` 로 남는다.
- `buildFailurePayload` 는 `layout` 을 받지 않는다. 레이아웃 진단은 규칙 3대로 `policy.mjs` 가 거르고, `run.mjs` 가 맨 뒤 키로 붙인다.
- 닫기(`createCloser`)도 키트로 옮겼다. 닫을 대상은 닫는 그때 읽는다.
- `policy.mjs` 는 `chromiumSandboxEnabled`·`sanitizeRunnerErrorName`(= `sanitizeErrorName`)·`allowedRequest`(= `makeOriginAllowlist(SUJAIN_ORIGINS)`)를 같은 이름으로 다시 내보낸다.

키트 규칙은 세 가지다.

1. `import('playwright-core')` 는 러너 진입 파일(`run.mjs`)에서만 한다. 모듈 해석이 호출 파일 위치를 기준으로 하기 때문이다.
2. `page.evaluate` 안에서 도는 함수(`captureSujainTables`·`countUnitOptions` 등)는 직렬화되므로 키트를 부르지 않는다. 키트는 Node 쪽만 맡는다.
3. 레이아웃 진단 sanitize 는 수자인 `policy.mjs` 에 남긴다. 허용 토큰이 브랜드마다 다르다.

```ts
// 두 번째 브랜드 때만: apps/api/src/housing-brand-sync/runner-process.ts
export function runRunnerJob(opts: {
  runnerPath: string; env: Record<string, string>; job: unknown;
  stdoutMaxBytes: number; stderrMaxBytes: number; timeoutMs: number; signal: AbortSignal;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string;
  aborted: 'parent_deadline' | 'response_too_large' | 'stdin_error' | null }>;
// 응답 zod 검증·stderr 거르기·경고 로그 줄은 브랜드 클라이언트에 남긴다.
```

## 5. 데이터 호환·마이그레이션

리팩터링 단계(0~5단계)에는 DB 마이그레이션이 없고, 운영 DB 에도 손대지 않는다.

1. **`sujain_fetch`**: 영구히 유지한다. 계약 enum, DB CHECK 두 개(`manual_housing_payments_amount_source_check`·`paid_source_check`), 미리보기 literal 을 모두 그대로 둔다. 이유는 셋이다.
   - 웹이 `manualHousingPlanListResponseSchema.parse` 로 strict 하게 읽는다(`manual-finance-client.ts:155`). 새 토큰이 실리면 옛 OTA 번들의 주택 화면 전체가 깨진다.
   - 계획 저장 왕복으로 사용자 행에 남아 있을 수 있다.
   - 라벨이 이미 '신축 조회'로 중립이다.

   새 브랜드도 같은 토큰을 쓴다. 어느 브랜드에서 왔는지는 plan 의 활성 연결(`housing_brand_connections.brand`)로 안다. 코드에서는 `HOUSING_BRAND_FETCH_SOURCE` 로만 부른다.
2. **brand CHECK**: 두 번째 브랜드 PR 에서만 바꾼다. 번호는 머지 직전에 다음 빈 번호로 정한다(지금 마지막은 0077이고, 다른 작업자가 먼저 쓸 수 있다).
   ```sql
   ALTER TABLE housing_brand_connections DROP CONSTRAINT housing_brand_connections_brand_check;
   --> statement-breakpoint
   ALTER TABLE housing_brand_connections ADD CONSTRAINT housing_brand_connections_brand_check CHECK (brand IN ('sujain', '<id>'));
   ```
   - 테이블이 몇 행뿐이라 NOT VALID/VALIDATE 로 나누지 않는다. 정규식 CHECK 대신 명시 IN 목록을 쓴다. DB 가 마지막 방어선이다.
   - 같은 PR 에서 `schema.ts` 의 `$type<HousingBrand>()` 와 check 문자열을 바꾸고, `packages/database/test/migrations.test.mjs` 에 새 파일 단언을 추가한다. 0076 단언은 그대로 둔다.
   - 일관성 테스트를 둔다. 마지막 brand CHECK 의 IN 목록과 `HOUSING_BRANDS`(contracts dist)가 같아야 한다.
   - 롤백은 `SELECT count(*) FROM housing_brand_connections WHERE brand <> 'sujain'` 이 0일 때만 한다.
3. **금고 AAD**: 기존 봉투의 AAD 는 `['family.finance-vault',1,owner,'sujain',connId,'credentials',ver]` 이다. `vaultContext(..., connection.brand)` 는 수자인일 때 같은 값을 만들므로 재암호화가 필요 없다. 0단계 테스트로 고정한다(옛 context 로 암호화 → 새 context 로 복호화). provider 를 `'housing:sujain'` 같은 일반형으로 '정리'하는 일은 영구히 금지한다.
4. **login_fingerprint**: `sha256('sujain:'+lower(id))` 는 일반화 뒤에도 같다. 테스트로 고정한다.
5. **브랜드 전환 시 미리보기**: 같은 plan 에서 다른 브랜드로 다시 연결하면 `lastPreview` 를 null 로 비운다. 두 번째 브랜드 PR 에서 넣는다. 수자인→수자인 재연결의 동작은 지금과 같게 유지한다(brand 가 바뀔 때만 비운다).
6. **와이어**: `z.literal('sujain')` 을 `z.enum(['sujain'])` 으로 바꿔도 JSON 과 TS 타입이 같다. 이미 배포된 OTA 번들도 영향이 없다.

## 6. 단계

모든 단계의 전제: 수자인 수정(`5f88738`)이 운영에 배포되고 본인 계정 실조회까지 확인된 뒤 시작한다. 단계마다 `main` 에 따로 푸시하고, 백업 → deploy → 운영 확인을 거친다.

### 0단계: 동작 고정 (배포 없음, CI 만)

- **서비스 특성 테스트**: 새 파일 `housing-brand-sync.service.test.ts`. 가짜 `SujainBrowserClient`·가짜 vault·DB 더블로 다음을 고정한다.
  1. connect 가 쓰는 brand·fingerprint·vault context·평문 brand
  2. sync 성공 미리보기(`source='sujain_fetch'`·items·status)
  3. 0건이면 `unsupported_layout` 과 markFailure 문구
  4. `SujainBrowserError(code, reason)` 이 공개 문구로 바뀌는 방식
  5. 재연결 시 `lastPreview` 를 유지하는 현재 동작
- **파서 골든**: 새 파일 `sujain-parse.golden.test.ts`. 기존 fixture 전부와 표 3개 합성 fixture 의 `parseSujainRows` 결과를 `key` 만 빼고 스냅샷한다. 옵션 label 이 한 글자라도 바뀌면 기존 확정 일정과 안 맞아 중복 줄이 생긴다. 이 테스트가 이후 모든 단계의 차단 조건이다.
- **러너 출력 고정**: 수자인 `run.mjs` 성공·실패 JSON 의 키 집합과 순서를 가짜 page 로 고정한다.
- **금고·지문**: `finance-vault.test.ts` 에 provider `'sujain'` AAD 왕복을, 서비스 테스트에 지문 기대값을 고정한다.
- **완료 기준**: 새 테스트가 지금 코드에서 통과하고 CI 가 초록이다.

### 1단계: 계약 (packages/contracts)

- `housing-brands.ts` 를 만들고 `housing-brand-sync.ts`·`manual-finance.ts` 가 쓰게 한다. `SUJAIN_OFFICIAL` 은 deprecated 로 남긴다.
- **테스트**: `packages/contracts/test/housing-brand-sync.test.mjs` 에 'sujain 통과 / 다른 문자열 거절 / HOUSING_BRAND_INFO 키 = HOUSING_BRANDS' 를 넣는다. tsup build 뒤 api·web typecheck 를 돌린다.
- **완료 기준**: 0단계 테스트를 고치지 않고 통과한다. 배포는 이미지 재빌드뿐이고 동작은 바뀌지 않는다.

### 2단계: API 어댑터 이음매 (apps/api, DB·웹 그대로)

- `brand-adapter.ts`·`sujain-adapter.ts`·`brand-registry.ts`·`housing-brand-match.ts` 를 추가하고 `module.ts` providers 를 갱신한다.
- 서비스는 `registry.run(connection.brand, a => a.read(...))` 를 쓰고 catch 에서는 `HousingBrandReadError` 만 본다. 0건 판정은 어댑터 안으로 옮긴다.
- `publicErrorMessage`·`loginFingerprint`·`vaultContext` 에 brand 를 넣는다.
- **테스트**: 0단계 서비스·골든·public-error 테스트를 수정 없이 통과해야 한다. registry 테스트(누락 브랜드면 부팅 실패, 없는 브랜드면 `runtime_unavailable`, 동시 두 번째 `run` 이면 `runtime_unavailable`)를 추가한다(`brand-registry.test.ts`, 수자인 어댑터 단위 테스트 포함).
- 0단계 서비스 테스트가 생성자 세 번째 인자로 가짜 `SujainBrowserClient` 를 넣기 때문에, 서비스 생성자는 `HousingBrandRegistry | SujainBrowserClient` 를 받고 클라이언트면 수자인 어댑터로 감싼다. 그 테스트를 등록표 주입으로 바꾸는 날 이 분기를 지운다.
- **완료 기준**: 운영에서 수자인 '확인' 1회가 성공하고, api 경고 로그 줄 형식이 이전과 같다.

### 3단계: 웹 문구 (OTA 웹 번들, 2단계와 순서 무관)

- 패널의 '수자인'과 `brand:"sujain"` 을 `HOUSING_BRAND_INFO[connection?.brand ?? DEFAULT_HOUSING_BRAND]` 에서 가져온다.
- FALLBACK 은 label 치환으로 지금 글자를 유지한다. `name="sujain-login/password"` 는 브라우저에 저장된 자격 증명 연결을 지키려고 그대로 둔다. 브랜드 고르기 UI 는 만들지 않는다.
- **테스트**: `housing-brand-panel.test.tsx` 가 같은 화면 글자를 단언한다.
- **완료 기준**: 화면이 픽셀 단위로 같고, OTA 배포 뒤 실기기에서 확인한다.

### 4단계: 러너 키트 (tools/sujain-web-runner 안)

2026-11-08 에 코드와 테스트를 넣었다(인터페이스는 4장). 아래 완료 기준의 이미지 재빌드·실조회 확인은 배포 때 한다.

- `kit/{stdin,launch,allowlist,result}.mjs` 를 뽑고, `run.mjs` 는 키트와 수자인 상수만 조합하게 줄인다. `ERRORS`·`RUNNER_STAGES`·`validateJob`·`SUJAIN_ORIGINS`·레이아웃 진단은 `policy.mjs` 에 남긴다.
- **테스트**(`test/kit-*.test.mjs`, node:test, 가짜 chromium·page):
  - stdin 8192바이트 초과나 깨진 JSON → `operation_unknown`
  - `getuid=0` → 샌드박스 꺼짐
  - username 이 붙은 URL 거절
  - 허용 목록 밖 code → `operation_unknown`
  - 키트 규칙 소스 검사(`kit-rules`): `playwright-core` import 는 `run.mjs` 만, 키트는 `node:`·형제 키트만 import, 키트에 브랜드 글자 없음, `page.evaluate` 로 넘기는 함수(`captureSujainTables`·`countUnitOptions`)가 키트를 부르지 않음
  - 기존 `test/*.test.mjs` 와 0단계 출력 고정 테스트가 그대로 통과
- `scripts/lib/sujain-web-runtime.test.mjs` 에 '.dockerignore 가 kit/ 을 빼지 않는다'를 추가한다. 은행 러너는 건드리지 않는다.
- **완료 기준**: 이미지를 재빌드하고(Dockerfile 변경 없음, `/app` 전체 복사), 실조회 1회와 실패 경로 진단 줄(`layout=...`)의 모양을 확인한다.

### 5단계: 문서

`docs/operations/sujain-web-connections.md` 에 '새 브랜드 추가 절차' 절을 추가한다. 7장 체크리스트를 옮긴다. 별도 문서는 만들지 않는다.

### 6단계: 두 번째 브랜드가 실제로 정해졌을 때 (이 순서를 지킨다)

- **6a 계약+웹**: `HOUSING_BRANDS`·`HOUSING_BRAND_INFO` 에 추가한다. 패널에는 브랜드가 2개 이상일 때만 고르기 UI 를 둔다. OTA 를 먼저 배포한다. 새 brand 행이 생기기 전에 새 번들이 깔려 있어야 옛 번들의 strict parse 가 깨지지 않는다.
- **6b DB·금고**: brand CHECK 마이그레이션을 넣고, `finance-vault.ts` 의 provider 유니온·`PROVIDERS`·`CREDENTIALS_ONLY` 에 id 를 추가한다. 배포 전에 백업한다.
- **6c 러너**: 4단계 키트는 이미 있다(2026-11-08). 같은 디렉터리에 `brands/<id>/` 를 추가하고 `validateJob` 이 provider 로 분기하게 한다. 디렉터리 이름을 `tools/housing-brand-runner` 로 바꿀지 이때 정한다. 바꾼다면 Dockerfile.prod·config 기본 runnerPath·`SUJAIN_WEB_*`(대체값 유지)·compose·runtime 테스트·문서를 한 PR 에서 같이 바꾼다. Chromium 은 계속 한 벌이다.
- **6d API**: `runner-process.ts` 를 뽑아 `SujainBrowserClient` 와 새 클라이언트가 같이 쓴다. 새 어댑터를 registry 에 등록하고 브랜드별 enabled 설정을 둔다(기본 false). 연결 시 brand 가 바뀌면 `lastPreview` 를 비운다.
- **6e 공용 표 해석(선택)**: 두 파서에서 실제로 같은 규칙(합계 줄·N차 회차·칸 이름 동의어)이 보일 때만 순수 함수를 `housing-table-parse.ts` 로 뽑는다. 수자인 골든이 한 글자도 바뀌지 않아야 한다.
- **6f 활성화**: enabled=false 로 배포한다. 본인 계정 실조회 1회와 api 로그에 개인 값이 없음을 확인한 뒤 enabled=true 로 바꾼다.

## 7. 새 브랜드 추가 체크리스트

1. **사전 확인**: 정상 브라우저로 이용 조건, 로그인 방식(보안 키패드·캡차·2FA 는 우회하지 않고 `authentication_required`), 조회 경로, 허용 호스트, 표 머리 구성, 세대 선택 방식을 확인한다. 값이 없는 메타데이터만 기록한다.
2. **id 정하기**: 소문자 영숫자로 한다. 기존 금고 공급자(`toss_securities`·`shinhan_bank`·`sujain`)와 겹치지 않아야 한다. 한 번 정하면 AAD·지문·DB 값으로 영구 고정된다.
3. **contracts**: `HOUSING_BRANDS`, `HOUSING_BRAND_INFO[id] = { label, officialSite, allowedHosts }`. 오류 코드는 `housingBrandSyncErrorSchema` 에 추가만 한다. 로그인 규칙이 다르면 `loginIdSchema` 를 브랜드별로 refine 한다.
4. **웹**: 패널 고르기 UI(2개 이상일 때)를 넣고 OTA 를 먼저 배포한다. 공용 컴포넌트를 바꿔야 하면 영향 화면을 보여 주고 먼저 묻는다.
5. **DB**: brand CHECK IN 목록 마이그레이션을 넣는다. `schema.ts` 의 check·`$type`, `migrations.test.mjs`, `HOUSING_BRANDS`↔CHECK 일관성 테스트를 갱신한다. value source 는 `HOUSING_BRAND_FETCH_SOURCE` 를 그대로 쓴다.
6. **금고**: `finance-vault.ts` 유니온·`PROVIDERS`·`CREDENTIALS_ONLY` 에 id 를 넣고 `finance-vault.test.ts` 에 왕복 테스트를 추가한다.
7. **러너**: `brands/<id>/{urls,policy,collect}.mjs` 를 만든다. 허용 origin 은 `allowedHosts` 와 맞추고, ERRORS·STAGES·페이지 토큰 허용 목록, `validateJob(provider===id)`, 진단 sanitize 를 둔다. 키트 stdin·launch·allowlist·result 를 쓴다. 브라우저 쪽 수집 함수는 자기완결로 짠다.
8. **러너 테스트**: 가짜 page·DOM 으로 로그인 실패·추가 인증·표 없음·세대 미등록·정상 표·허용 밖 요청 abort·진단에 셀 값 없음을 테스트한다. 기존 CI 글롭이 잡는 위치에 둔다.
9. **API 클라이언트**: `<id>-browser.ts` 를 만들어 `runner-process.ts` 로 spawn 한다. 응답 zod·stdout 상한·stderr 거르기를 둔다. 자격 증명은 stdin `{provider:id, credentials}` 로만 넘기고 env·argv·로그에는 넣지 않는다.
10. **API 파서**: `<id>-parse.ts` 에서 `HousingBrandFetchedItem[]`·unread 를 만든다. 모르는 칸은 null 과 사유로 남기고 추정하지 않는다. 합계 줄은 건너뛴다. 옵션 label 은 결정적이어야 하며 골든 테스트로 고정한다.
11. **API 어댑터**: `<id>-adapter.ts` 에서 0건이면 `unsupported_layout` 을 던진다. 고유 용어 문구는 `publicErrorOverride` 로 낸다. module providers 와 registry 생성자에 등록한다(누락은 부팅 검사가 잡는다).
12. **설정·compose**: `packages/config` 에 브랜드별 enabled(기본 false)를 두고, runnerPath·browserExecutable 은 공유한다. compose 에는 비밀이 아닌 값만 넣는다. `config-validation.test.mjs`·`.env.example` 을 갱신한다.
13. **이미지**: Dockerfile 변경이 없어야 한다. 새 디렉터리를 만든다면 이유와 이미지 증가량을 PR 에 적는다.
14. **문서**: 운영 문서에 허용 호스트, 읽는 화면, 확인 날짜, 진단에 남는 값 목록, 끄는 법을 남긴다.
15. **배포 순서**: 계약+웹 OTA → DB 마이그레이션 → API·러너 이미지(enabled=false) → 실계정 1회 확인 → enabled=true. 롤백은 enabled=false 가 먼저이고, CHECK 를 되돌리는 것은 새 brand 행이 0건일 때만 한다.

## 8. 하지 않을 것

- `tools/bank-web-runner`·`bank-browser.ts` 와의 공용화. 운영 이미지에 설치되지 않고 기능도 꺼져 있다. 은행 러너가 root 에서 `chromiumSandbox:true` 로 고정된 문제는 은행 문서에 '재활성화 전 확인 항목'으로만 적는다. 은행을 다시 켤 때 키트와 `runner-process.ts` 를 옮겨 쓰는 것을 검토한다.
- `tools/mac-bank-runner`(파이썬 Mac repl)와 `tools/shinhan-loan-collector`. 실행 위치·언어·보안 모델이 다르다.
- `tools/web-runner-kit` 같은 별도 폴더나 `packages/` 워크스페이스 패키지. CI 줄과 tsup DTS 빌드가 늘고, Dockerfile COPY 강제(dockerfile-workspaces 테스트)가 생긴다.
- 브랜드가 하나인 동안 공용 표 해석 프로필이나 브라우저 캡처 설정형을 만드는 것.
- `sujain_fetch` 이름 바꾸기와 기존 행 UPDATE. 금고 provider·지문 접두사 '정리'.
- `SUJAIN_WEB_*` env 이름 바꾸기(디렉터리를 바꿔도 대체값으로 남긴다). 러너 경로 이동(6c 판단 전까지).
- 다중 세대 선택, worker 정기 자동 조회, HTTP API 로 조회되는 브랜드. 어댑터가 브라우저를 가정하지 않으므로 그때 추가한다.

## 9. 위험

| 위험 | 대응 |
|---|---|
| 진행 중인 수자인 작업과 같은 파일 충돌(병렬 커밋·미커밋 일부 업로드 함정) | 배포와 실조회 확인 뒤 시작한다. 2단계는 감싸기만 하고, 예외는 `matchFetchedItems` 이동과 재수출 한 줄뿐이다 |
| 옵션 label 결정성이 깨져 확정 일정 옆에 중복 줄이 생김 | 0단계 파서 골든을 모든 단계의 차단 조건으로 둔다 |
| 서비스 테스트가 없어 회귀를 놓침 | 0단계 없이 2단계를 하지 않는다 |
| 금고 AAD·지문 회귀로 기존 자격 증명 복호화 실패 | 왕복·기대값 고정 테스트. provider 문자열은 영구 고정이다 |
| 옛 OTA 번들의 strict parse 로 주택 화면 전체 실패 | 새 브랜드는 '계약+웹 OTA 먼저 → 서버 활성화' 순서를 지킨다 |
| 공개 문구 회귀(수자인 고유 용어) | label 치환과 `publicErrorOverride` 를 쓰고, public-error 테스트를 그대로 통과해야 한다 |
| Chromium 동시 실행으로 Mac 메모리 압박 | registry `run()` 게이트(주택 브랜드 전체 1개). 사용자가 몰리면 `runtime_unavailable` 이므로, 문구를 나누는 `runner_busy` 사유 추가를 검토한다. 은행이 켜지면 게이트를 공용 provider 로 올린다 |
| 키트 모듈 해석, `page.evaluate` 직렬화 | `chromium` 을 주입하고 키트는 Node 쪽만 맡는다. 운영 전에 이미지에서 실조회 1회를 한다 |
| 키트 테스트가 CI 에서 안 돎 | 기존 글롭(`tools/sujain-web-runner/test/*.test.mjs`) 안에 둔다 |
| 진단 누출 | 레이아웃 진단은 인터페이스에 올리지 않고 브랜드 클라이언트 안의 허용 목록 값만 로그에 남긴다 |
| 러너와 API 진단 문자열 두 벌이 어긋남 | 선택 사항으로, 공유 JSON fixture(입력 layout → 기대 warn 조각)를 러너 node:test 와 API vitest 가 같이 읽게 한다 |
| 브랜드별 디렉터리로 이미지가 커짐 | 같은 러너 디렉터리에 `brands/` 를 두는 것을 원칙으로 한다. 예외라면 PR 에 증가량을 적고 디스크 여유를 확인한다 |
| 추측 일반화 | 공용은 출력 계약과 프로세스 뼈대까지만 둔다. 파서·수집 공용화는 두 번째 사이트를 본 뒤 6e 에서 판단한다 |
