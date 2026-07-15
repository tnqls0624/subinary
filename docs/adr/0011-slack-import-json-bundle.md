# ADR-0011: Slack Import — JSON 번들 업로드 · 개인 workspace 분리 · 멱등 import · 스레드 복원 · trgm 검색

## 제목

Slack Export 를 **단일 JSON 번들 multipart 업로드**로 수집하고(ZIP 해제 라이브러리 불필요),
Slack 데이터를 **개인 데이터 컨테이너 `workspaces`(ownerUserId+kind)** 아래 분리해 **소유자
본인만** 접근하게 하며(가족 구성원도 불가), import 를 **`slack_messages`
UNIQUE(slackChannelId, ts) + `onConflictDoNothing`** 으로 멱등화하고, 스레드를
**`thread_ts` 그룹핑 + `ts` 오름차순** 으로 복원하며, 키워드 검색을
**`pg_trgm` + `ILIKE` + GIN(gin_trgm_ops)** 로 제공하는 설계 채택(PRD §18/§26/§37, Phase 6).

## 상태

승인됨 (Accepted) — 2026-07-16

## 배경

Phase 6 은 "개인화 AI(업무 기록 수집)"의 시작으로, Slack Export 를 업로드해 채널·사용자를
정규화하고 메시지를 저장·스레드 복원·키워드 검색까지 제공한다(PRD §31 Phase 6). 실시간
Slack App/OAuth, Task/Decision/Incident 추출(§18), RAG/임베딩(Phase 7)은 범위 밖이다.

요구 불변식:

- **JSON 번들 업로드**(PRD §18): Slack export ZIP 을 클라이언트가 풀어 하나의 JSON 번들로
  올린다고 가정한다. 서버는 파일을 받아 원문(MinIO) 저장 후 워커에서 파싱한다.
- **개인 데이터 분리·소유자 전용**(PRD §3.6/§26): Slack 데이터는 가족 공유 대상이 아니라
  **개인** 데이터다. 소유자 본인만 조회 가능하고, 다른 사용자·가족 구성원은 접근할 수 없다.
- **멱등 import**(PRD §17): 동일 export 를 재업로드해도 메시지가 중복 저장되지 않는다.
- **스레드 복원**: Slack 스레드(루트 + 답글)의 순서와 답글 수를 정확히 복원한다.
- **키워드/채널/날짜 검색**: 한국어를 포함한 부분일치 검색을 제공한다. 본격 FTS/벡터는 Phase 7.
- **로그 비노출**(PRD §11): 메시지 원문/PII/secret/토큰을 운영 로그에 남기지 않는다.

설계 포인트는 다섯 가지다. (1) 업로드 형식을 ZIP 으로 할 것인가 JSON 번들로 할 것인가,
(2) Slack 데이터의 소유·접근 경계를 어떻게 모델링할 것인가, (3) 재import 를 어떻게 멱등화할
것인가, (4) 스레드를 어떻게 복원할 것인가, (5) 키워드 검색을 어떤 인덱스로 제공할 것인가.

## 결정

### 1. 업로드 = JSON 번들 multipart (ZIP 아님)

- 클라이언트가 Slack export ZIP 을 풀어 **하나의 JSON 번들**로 합쳐 올린다. 번들은
  `{ workspace, channels[], users[], messages[] }` 형태다(형식은 §번들 형식, docs/api/slack.md).
- 서버(`apps/api`)는 `@fastify/multipart` 로 파일 `file` 을 수신 → MinIO 에 원문 저장 →
  BullMQ `slack-import` 큐로 파싱을 위임한다. **ZIP 해제 라이브러리·디렉터리 순회 로직이
  불필요**하고, 원문은 카드 문자 수집(ADR-0008)과 동일하게 `source_items`(kind='slack') 1건 +
  MinIO objectKey 로 이중 보존된다.
- multipart 필드: `file`(번들 JSON) + `mySlackUserId`(옵션, 내 메시지 필터) +
  `workspaceName`(옵션 override) + `kind`(옵션, 기본 `company`).
- 파싱은 **순수 패키지 `@family/slack-parser`** 의 `parseSlackExport(bundle)` 가 담당한다
  (구조 검증, 채널·사용자·메시지 정규화, 스레드 그룹핑, 명백한 secret 패턴 warning). API 는
  최소 검증(JSON.parse 실패 시 400)만 하고 전체 구조 검증은 워커에서 수행한다.

### 2. 개인 데이터 컨테이너 `workspaces` + 소유자 전용 접근

- `workspaces(id, ownerUserId, kind∈{personal,company}, name)` 를 도입해 개인 데이터의 컨테이너로
  삼는다. `slack_workspaces` 는 `workspaceId` 로 1:1(UNIQUE) 연결되고, 그 아래
  `slack_channels`/`slack_users`/`slack_messages`/`slack_threads` 가 매달린다.
- 접근제어는 **`ownerUserId == actorUserId` 만 허용**한다(PRD §26). 서비스 계층
  `requireOwnedSlackWorkspace(userId, slackWorkspaceId)` 가 소유자가 아니면 `Forbidden(403)`
  을 던진다. 가족 멤버십(ADR-0006 `requireMembership`)과 **무관** — Slack 은 가족 공유 데이터가
  아니라 개인 데이터다. 이 강제는 컨트롤러가 아니라 서비스에 두어 새 조회 경로에도 일관 적용된다.
- 향후 Phase 8 의 `personal_events` 가 `workspaceId` 로 연결돼 장기기억(Task/Decision/Incident)
  으로 확장될 자리를 남긴다.

### 3. 멱등 import — UNIQUE(slackChannelId, ts) + onConflictDoNothing

- `slack_messages` 는 **UNIQUE(slackChannelId, ts)** 를 갖고, 워커는
  `onConflictDoNothing` 으로 삽입한다 → 동일 export 재업로드 시 **중복 행이 원천적으로 불가능**.
- `slack_channels`/`slack_users` 는 `onConflictDoUpdate`(이름 갱신)로 upsert 한다 — 채널명/유저명이
  바뀌면 반영하되 중복 생성하지 않는다. `slack_threads` 는 재계산 upsert(replyCount/lastReplyAt).
- import 단위마다 **새 `source_items`(kind='slack')** 1건이 생기지만(감사·원문 보존), 메시지는
  중복 저장되지 않는다. 즉 "새 importId + 불변 messageCount" 가 멱등의 관찰 가능한 증거다.
- 워커는 처리 완료 후 `slack_workspaces.lastImportedAt` 을 갱신한다.

### 4. 스레드 복원 — thread_ts 그룹핑 + ts 오름차순

- Slack `ts` 는 `"epoch.micro"` 문자열이다. `thread_ts === ts`(또는 `thread_ts` 없음)면 **루트**,
  아니면 **답글**이다.
- 파서는 `thread_ts` 로 메시지를 그룹핑해 `slack_threads(slackChannelId, threadTs)` 를 upsert 한다:
  `rootTs` = 그룹 최소 `ts`, `replyCount` = 그룹 크기 − 1, `lastReplyAt` = 그룹 최대 `occurredAt`.
- 스레드 조회는 `threadTs` 로 메시지를 모아 **`ts` 오름차순**으로 정렬한다. `ts` 는 zero-pad 문자열이
  아니므로 **숫자 비교**(`compareTs`)로 정렬한다(문자열 사전순 금지).
- `occurredAt` 은 `new Date(Number(ts.split('.')[0]) * 1000)` 으로 파생하고, 경계·표시는
  `Asia/Seoul`, 저장/응답 시각은 ISO 문자열이다.

### 5. 키워드 검색 — pg_trgm + ILIKE + GIN(gin_trgm_ops)

- Phase 0 에서 설치된 `pg_trgm` 확장을 활용해 `slack_messages.text` 에
  **GIN(text gin_trgm_ops)** 인덱스를 만들고 `text ILIKE '%q%'` 로 부분일치 검색한다. trigram 은
  **한국어에도 안전**하고 형태소 분석기 없이 동작한다.
- 채널(`channelId`)·날짜(`occurredAt ∈ [from,to]`)·`mine`(내 메시지: `slackUserId ==
  mySlackUserId`) 필터를 결합하고, `occurredAt desc, id` 기준 keyset 페이지네이션(`nextCursor`)을
  제공한다. `isMine` 은 `mySlackUserId` 대비로 계산한다.
- 출처는 `channelName`/`authorName`/`ts`/`permalinkHint` 로 노출한다. 실제 permalink 는 export 에
  없으므로 `permalinkHint` 는 채널명+ts 조합(`#channel@ts` 또는 `slack://`)의 **힌트 문자열**이다.
- 본격 전문검색(FTS)·의미검색(벡터/임베딩)은 Phase 7 로 미룬다.

## 검토한 대안

1. **ZIP 업로드 + 서버 해제**: Slack export 원본 ZIP 을 그대로 받아 서버가 푼다. ZIP 해제
   라이브러리 의존성·디렉터리 순회·zip-slip 류 보안 표면·대용량 스트리밍 복잡도가 늘어난다.
   클라이언트가 이미 export 를 다루므로 **JSON 번들 1개**로 단순화했다(범위는 업로드만, PRD §18).
2. **Slack 데이터를 가족 공유(household) 스코프로**: 카드/거래처럼 `householdId` 스코프로 둘 수도
   있다. 그러나 Slack 은 개인 업무 기록이라 가족 공유가 부적절하다(PRD §26). 개인 컨테이너
   `workspaces(ownerUserId)` 로 분리하고 **소유자 전용**으로 강제했다.
3. **번들을 큐 payload 에 직접 실어 전달**: MinIO 왕복을 피할 수 있으나 번들이 커지면 Redis/큐에
   부담이고 원문 권위 사본이 사라진다. 카드 수집과 동일하게 **MinIO 원문 저장 + 큐에는
   식별자(sourceItemId/slackWorkspaceId)만** 싣고 워커가 MinIO 에서 읽어 파싱한다.
4. **재import 시 기존 메시지 삭제 후 재삽입(replace)**: 단순하지만 sourceItemId 연결·감사 이력이
   끊기고 동시 import 시 경합이 크다. **UNIQUE + onConflictDoNothing** 으로 append-멱등을 택했다.
5. **스레드를 애플리케이션에서 매 조회마다 재그룹핑**: 조회 비용·일관성 문제가 있다. import 시
   `slack_threads` 로 `replyCount`/`lastReplyAt` 를 **미리 물화**해 조회를 단순화했다.
6. **검색을 FTS(tsvector) 또는 벡터로 지금 구현**: 한국어 FTS 는 사전/형태소 설정이 필요하고 벡터는
   임베딩 파이프라인(Phase 7)이 선행돼야 한다. MVP 는 언어 무관·무설정인 **trgm ILIKE** 로 충분하다.
7. **ts 를 문자열 사전순 정렬**: `"epoch.micro"` 는 zero-pad 가 아니라 자리수 차이로 사전순이
   깨질 수 있다. **숫자 비교**로 정렬해 정확성을 확보했다.

## 장점

- ZIP 해제 의존성·보안 표면 없이 업로드가 단순하고, 원문은 MinIO+source_items 로 이중 보존돼
  감사·재처리가 가능하다(ADR-0008 패턴 계승).
- Slack 데이터가 개인 컨테이너로 분리되고 소유자 전용 강제가 서비스 한 곳에 모여, 진입점과 무관하게
  일관되며 e2e(`verify-phase6.mjs` §10)로 회귀를 막는다.
- UNIQUE + onConflictDoNothing 으로 재import 가 중복 없이 멱등이라 재업로드/부분 재전송이 안전하다.
- 스레드가 물화돼 조회가 저렴하고 순서·답글 수가 결정론적이다.
- trgm 검색은 한국어에도 무설정으로 동작하고 GIN 인덱스로 대량 데이터에서도 실용적이다.

## 단점

- 클라이언트가 Slack export ZIP → JSON 번들 변환 책임을 진다(업로드 스펙 준수 필요).
- 번들 전체를 한 번에 파싱하므로 초대형 export 는 워커 메모리/시간이 커진다(청크 스트리밍 여지).
- `permalinkHint` 는 실제 permalink 가 아닌 힌트라, 원본 Slack 으로의 정확한 딥링크는 보장하지 않는다.
- trgm ILIKE 는 의미검색이 아니라 부분일치라, 동의어/문맥 검색은 Phase 7 벡터 검색을 기다려야 한다.
- 워커가 MinIO 에서 번들을 읽어야 하므로 worker 에 경량 object-storage(S3 클라이언트) 접근이 추가된다.

## 변경조건

- 초대형 export 가 흔해지면 번들을 채널/기간 단위로 청크 업로드하거나 워커에서 스트리밍 파싱으로
  전환하되, 멱등 규약(UNIQUE + onConflictDoNothing)은 유지한다.
- 실시간 Slack App/OAuth 연동이 필요해지면(PRD 후순위) 이벤트 수집 경로를 추가하되 소유자 전용
  접근·개인 workspace 분리는 그대로 둔다.
- 의미검색/AI 질의가 필요해지면 Phase 7 에서 임베딩·벡터 인덱스를 도입하되 trgm 키워드 검색은
  보조 경로로 유지한다.
- Task/Decision/Incident 추출(§18)·장기기억이 붙으면 Phase 8 `personal_events` 를 `workspaceId`
  로 연결한다.
