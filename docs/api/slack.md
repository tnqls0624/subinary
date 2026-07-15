# Slack Import / 조회 API 명세

> Phase 6 기준. 계약 스키마의 단일 소스는 `@family/contracts`(zod)이며, 본 문서는 예시다.
> 모든 엔드포인트는 전역 prefix `v1`을 사용한다. 시각은 ISO 8601 문자열(`toISOString`),
> 기간 경계·표시는 `Asia/Seoul`, Slack `ts`는 `"epoch.micro"` 문자열이다.
>
> 관련 설계: [ADR-0011 Slack Import JSON 번들](../adr/0011-slack-import-json-bundle.md) ·
> [ADR-0008 카드 문자 수집·파싱](../adr/0008-card-sms-ingestion-and-parsing.md)(원문 이중보존·멱등 패턴 계승) ·
> [Phase 6 빌드 스펙](../phase6-build-spec.md)

## 개요

Phase 6은 Slack Export(JSON 번들)를 업로드해 채널·사용자를 정규화하고, 메시지를 저장하며,
스레드 복원·키워드 검색·내 메시지 필터를 제공한다.

| 동작 | 방식 | 경로 |
|---|---|---|
| Import(업로드) | JWT + multipart 파일 | `POST /v1/slack/import` |
| 워크스페이스 목록/상세 | JWT | `GET /v1/slack/workspaces` · `GET /v1/slack/workspaces/:id` |
| 메시지 검색 | JWT | `GET /v1/slack/messages?...` |
| 스레드 조회 | JWT | `GET /v1/slack/threads?...` |

- 업로드는 **JSON 번들 multipart**다(ZIP 아님, ADR-0011 §1). 클라이언트가 Slack export ZIP을
  풀어 하나의 JSON 번들로 합쳐 올린다. 서버는 파일을 MinIO(원문 권위 사본) + `source_items`
  (kind=`slack`)에 이중 보존하고 BullMQ `slack-import` 큐로 파싱을 위임한다.
- 파싱은 워커에서 **비동기**다. 업로드 응답은 즉시 `status:"queued"`로 수락하고, 결과
  (messageCount 등)는 `GET /v1/slack/workspaces/:id`를 폴링(권장 상한 10초)해 확인한다.
- Import는 **멱등**이다 — `slack_messages` UNIQUE(slackChannelId, ts) + `onConflictDoNothing`
  이라 동일 번들 재업로드는 새 `importId`(source_item)만 생기고 **메시지는 중복 저장되지 않는다**.
- **접근제어(PRD §26)**: Slack 데이터는 개인 데이터다. `workspaces.ownerUserId == 요청자`인
  **소유자 본인만** 조회할 수 있다 — 가족 구성원·제3자 모두 불가(`403 Forbidden`).
- **로그 비노출(PRD §11)**: 메시지 원문/PII/secret/토큰을 운영 로그에 남기지 않는다(개수/식별자만).

---

## 1. 번들 형식 (multipart 파일 `file`)

클라이언트가 Slack export를 풀어 합친 **단일 JSON 번들**이다.

```json
{
  "workspace": { "name": "회사 슬랙", "slackTeamId": "T123" },
  "channels": [
    { "id": "C1", "name": "eng-backend" },
    { "id": "C2", "name": "general" }
  ],
  "users": [
    { "id": "U1", "name": "soobeen", "real_name": "수빈" },
    { "id": "U2", "name": "alex", "real_name": "Alex Kim" }
  ],
  "messages": [
    { "channel": "C1", "ts": "1721040600.000100", "user": "U1",
      "text": "배포 스레드 시작합니다", "thread_ts": "1721040600.000100", "edited_ts": null },
    { "channel": "C1", "ts": "1721040660.000200", "user": "U2",
      "text": "확인했습니다", "thread_ts": "1721040600.000100", "edited_ts": null },
    { "channel": "C1", "ts": "1721040720.000300", "user": "U1",
      "text": "머지 완료했어요", "thread_ts": "1721040600.000100", "edited_ts": null },
    { "channel": "C2", "ts": "1721041100.000100", "user": "U1",
      "text": "점심 뭐 먹을까요", "edited_ts": null }
  ]
}
```

| 필드 | 규칙 |
|---|---|
| `workspace.name` | 선택. 워크스페이스 표시명(업로드 `workspaceName` 필드로 override 가능). |
| `workspace.slackTeamId` | 선택. Slack 팀 id. |
| `channels[].id` / `.name` | 채널 id(정규화 키) / 이름. `UNIQUE(slackWorkspaceId, slackChannelId)`. |
| `users[].id` / `.name` / `.real_name` | 유저 id(정규화 키) / 이름 / 실명(선택). |
| `messages[].channel` | 소속 채널 id. `channels`에 없으면 **skip + warning**. |
| `messages[].ts` | `"epoch.micro"` 문자열. `occurredAt = new Date(Number(ts.split('.')[0]) * 1000)`. |
| `messages[].user` | 작성자 유저 id(선택). |
| `messages[].text` | 원문(없으면 빈 문자열/skip). |
| `messages[].thread_ts` | 스레드 루트 ts. `thread_ts === ts`(또는 없음)면 **루트**, 아니면 **답글**. |
| `messages[].edited_ts` | 편집 시각(선택, nullable). |

> 명백한 secret 패턴(`xoxb-`, `AKIA`, `-----BEGIN` 등)이 `text`에 있으면 파서가 **warning**만
> 남기고 **저장은 유지**한다(MVP — 본격 마스킹은 후순위, PRD §26).

---

## 2. Import — `Controller('slack')` → `POST /v1/slack/import`

번들 JSON을 multipart로 업로드한다. 사용자 인증(Bearer) 필요. 요청자가 소유한 워크스페이스로
upsert되며, 없으면 새로 생성된다.

### 요청 (multipart/form-data)

| 파트 | 필수 | 설명 |
|---|---|---|
| `file` | ✅ | 번들 JSON 파일(위 §1 형식). 최대 50MB. |
| `mySlackUserId` | 선택 | 내 Slack user id(예: `U1`) — `isMine`/`mine` 필터 기준. 미지정 시 기존 유지. |
| `workspaceName` | 선택 | 워크스페이스 표시명 override(미지정 시 `workspace.name` → 없으면 `Slack`). |
| `kind` | 선택 | 데이터 컨테이너 종류(`personal` \| `company`). 기본 `company`. |

```bash
# 번들 파일 bundle.json 을 multipart 로 업로드
curl -s -X POST http://localhost:3001/v1/slack/import \
  -H 'Authorization: Bearer <accessToken>' \
  -F 'mySlackUserId=U1' \
  -F 'workspaceName=회사 슬랙' \
  -F 'kind=company' \
  -F 'file=@bundle.json;type=application/json'
```

### 응답 `200 OK` (`slackImportResponseSchema`)

```json
{
  "importId": "a1b2c3d4-…",
  "slackWorkspaceId": "f9e8d7c6-…",
  "status": "queued"
}
```

| 필드 | 의미 |
|---|---|
| `importId` | 이번 import의 `source_items.id`(감사·원문 추적 키). 재업로드마다 **새 값**. |
| `slackWorkspaceId` | 대상 `slack_workspaces.id`. 소유 워크스페이스라 재업로드 시 **동일**. |
| `status` | 항상 `queued`(파싱 큐 등록). "완료"가 아니라 "등록"을 뜻한다 — 아래 §3을 폴링. |

오류:

| 상황 | 응답 |
|---|---|
| `file` 누락 / JSON.parse 실패(번들 형식 위반) | `400` |
| 인증 없음/만료 | `401` |
| 파일 크기 초과(50MB) | `413` |

> 파싱은 비동기다 — `queued`는 파싱 완료가 아니다. 결과는 워크스페이스 상세를 폴링(≤10초)해
> `messageCount`로 확인한다. 워커가 처리 완료 시 `lastImportedAt`이 갱신된다.

---

## 3. 워크스페이스 — `GET /v1/slack/workspaces[/:id]`

사용자 인증(Bearer) 필요. **소유자 본인만** 조회한다 — 비소유자는 목록에 노출되지 않고,
상세/하위 조회는 `403`.

| 메서드 · 경로 | 성공 | 설명 |
|---|---|---|
| `GET /v1/slack/workspaces` | `200` | 내가 소유한 워크스페이스 목록(summary). |
| `GET /v1/slack/workspaces/:id` | `200` | 단건 상세(count 집계 포함). 비소유자 `403`. |

응답 항목 `slackWorkspaceSummarySchema`:

```json
{
  "id": "f9e8d7c6-…",
  "workspaceId": "0a1b2c3d-…",
  "name": "회사 슬랙",
  "slackTeamId": "T123",
  "mySlackUserId": "U1",
  "channelCount": 2,
  "userCount": 2,
  "messageCount": 7,
  "lastImportedAt": "2026-07-16T02:10:00.000Z"
}
```

| 필드 | 의미 |
|---|---|
| `id` | `slack_workspaces.id`(= import 응답의 `slackWorkspaceId`). |
| `workspaceId` | 개인 데이터 컨테이너 `workspaces.id`(`ownerUserId`로 소유 판정). |
| `channelCount` / `userCount` / `messageCount` | 정규화된 채널/유저/메시지 개수(SQL 집계). |
| `lastImportedAt` | 마지막 import 처리 완료 시각(워커 갱신, nullable). |

> `GET /v1/slack/workspaces`(목록)는 `{ items: [...] }` 형태이거나 bare 배열일 수 있다 — 항목
> 스키마는 위와 동일하다.

---

## 4. 메시지 검색 — `GET /v1/slack/messages`

사용자 인증(Bearer) 필요. `slackWorkspaceId` 소유자만 조회 가능(비소유자 `403`).
`pg_trgm` + `ILIKE`(GIN)로 키워드 부분일치, 채널/날짜/`mine` 필터를 결합한다.

| 쿼리 | 규칙 |
|---|---|
| `slackWorkspaceId` | 필수. 요청자가 소유해야 함(아니면 `403`). |
| `channelId` | 선택. 특정 채널로 필터. |
| `from` / `to` | 선택. `occurredAt` 범위(ISO 8601, `Asia/Seoul` 경계). |
| `q` | 선택. 키워드 부분일치(`text ILIKE '%q%'`, trigram — 한국어 안전). |
| `mine` | 선택. `true`면 내 메시지(`slackUserId == mySlackUserId`)만. |
| `limit` | 선택. 페이지 크기(기본값 있음). |
| `cursor` | 선택. keyset 페이지네이션 커서(`occurredAt desc, id`). |

```bash
curl -s 'http://localhost:3001/v1/slack/messages?slackWorkspaceId=f9e8d7c6-…&q=스프린트회고&mine=true' \
  -H 'Authorization: Bearer <accessToken>'
```

### 응답 `200 OK` (`slackMessageListResponseSchema`)

```json
{
  "items": [
    {
      "id": "11111111-…",
      "slackChannelId": "22222222-…",
      "channelName": "eng-backend",
      "slackUserId": "U1",
      "authorName": "수빈",
      "ts": "1721041000.000100",
      "threadTs": null,
      "text": "스프린트회고 문서 정리했습니다",
      "editedTs": null,
      "occurredAt": "2024-07-15T12:16:40.000Z",
      "isMine": true,
      "permalinkHint": "#eng-backend@1721041000.000100"
    }
  ],
  "nextCursor": null
}
```

| 필드 | 의미 |
|---|---|
| `channelName` / `authorName` | 정규화된 채널명 / 작성자명(출처 표시, `authorName` nullable). |
| `ts` / `occurredAt` | Slack ts / 파생 절대시각(ISO). `occurredAt = new Date(sec*1000)`. |
| `threadTs` | 스레드 루트 ts(스레드 소속이면 non-null). |
| `isMine` | `slackUserId == mySlackUserId` 여부. |
| `permalinkHint` | 출처 힌트(`#channel@ts` 또는 `slack://`) — 실제 permalink는 export에 없어 조합. |

---

## 5. 스레드 조회 — `GET /v1/slack/threads`

사용자 인증(Bearer) 필요. 소유자만 조회 가능(비소유자 `403`). `threadTs`로 메시지를 모아
**`ts` 오름차순**(숫자 비교)으로 정렬해 루트 + 답글을 순서대로 돌려준다.

| 쿼리 | 규칙 |
|---|---|
| `slackWorkspaceId` | 필수. 소유자만. |
| `channelId` | 필수. 스레드가 속한 채널. |
| `threadTs` | 필수. 스레드 루트 ts. |

```bash
curl -s 'http://localhost:3001/v1/slack/threads?slackWorkspaceId=f9e8d7c6-…&channelId=22222222-…&threadTs=1721040600.000100' \
  -H 'Authorization: Bearer <accessToken>'
```

### 응답 `200 OK` (`slackThreadResponseSchema`)

```json
{
  "threadTs": "1721040600.000100",
  "channelName": "eng-backend",
  "replyCount": 2,
  "messages": [
    { "id": "…", "ts": "1721040600.000100", "authorName": "수빈", "text": "배포 스레드 시작합니다",
      "threadTs": "1721040600.000100", "channelName": "eng-backend", "isMine": true, "…": "…" },
    { "id": "…", "ts": "1721040660.000200", "authorName": "Alex Kim", "text": "확인했습니다",
      "threadTs": "1721040600.000100", "channelName": "eng-backend", "isMine": false, "…": "…" },
    { "id": "…", "ts": "1721040720.000300", "authorName": "수빈", "text": "머지 완료했어요",
      "threadTs": "1721040600.000100", "channelName": "eng-backend", "isMine": true, "…": "…" }
  ]
}
```

| 필드 | 의미 |
|---|---|
| `threadTs` | 스레드 루트 ts. |
| `replyCount` | 답글 수(그룹 크기 − 1). 위 예: 루트 1 + 답글 2 → `replyCount=2`. |
| `messages` | `slackMessageSummary` 배열. **`ts` 오름차순**(루트 먼저, 이후 답글). |

> `messages[]` 항목은 §4 `slackMessageSummarySchema`와 동일하다.

---

## 6. 접근제어 · 멱등 요약

- **소유자 전용(PRD §26)**: 모든 조회는 `workspaces.ownerUserId == 요청자`를 서비스 계층에서
  강제한다. 비소유자(가족 구성원 포함)는 상세/메시지/스레드에서 `403`, 목록에서 미노출.
- **멱등(ADR-0011 §3)**: 재업로드는 새 `importId`(source_item)만 만들고 `slack_messages`는
  UNIQUE(slackChannelId, ts) + `onConflictDoNothing`으로 중복 저장하지 않는다. channels/users는
  `onConflictDoUpdate`(이름 갱신), threads는 재계산 upsert. 즉 재import 후 `messageCount`는 불변.

---

## 7. 검증 (완료 조건 e2e)

Phase 6 완료 조건은 `scripts/verify-phase6.mjs`가 실 스택(`http://localhost:3001`)을 대상으로
자동 검증한다(스펙 §8 시나리오 1~10). Node 내장 `fetch` + `FormData` + `Blob`만 사용하고,
번들을 `new Blob([json], { type:'application/json' })`로 만들어 `mySlackUserId=U1` 필드와 함께
multipart 업로드한다. 파싱은 비동기이므로 워크스페이스 상세를 최대 10초 폴링한다.

```bash
# 전체 스택 기동(진행자 수행): docker compose up -d --build (+ migrate 0005)
node scripts/verify-phase6.mjs
# 다른 호스트/포트: API_BASE_URL=http://localhost:3001 node scripts/verify-phase6.mjs
```

검증 시나리오: 업로드 `200 queued` → 폴링 후 `messageCount=7`/`channelCount=2`/`userCount=2` →
동일 번들 재업로드 시 새 `importId`+`messageCount` 불변(멱등) → 스레드 `ts` 오름차순·`replyCount=2`
(루트+답글2) → 키워드 검색(유니크 토큰 1건)/채널 필터/날짜 필터 → `mine=true` 시 내(U1) 메시지만
`isMine=true` → 출처(`channelName`/`authorName`/`ts`/`permalinkHint`) → 비소유자 userB 조회 `403`.
전부 통과 시 종료 코드 `0`, 하나라도 실패하면 첫 실패 지점에서 명확한 메시지와 함께 `1`로 종료한다.
로그에는 메시지 원문·secret·토큰을 출력하지 않는다(개수/식별자만).
