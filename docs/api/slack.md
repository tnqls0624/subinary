# Slack Import / 동기화 / 조회 API 명세

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
| Import 상태 조회 | JWT | `GET /v1/slack/imports/:importId` |
| 메시지 편집/삭제 | JWT + JSON 또는 path | `PATCH /v1/slack/messages/:id` · `DELETE /v1/slack/messages/:id` |
| 워크스페이스 목록/상세 | JWT | `GET /v1/slack/workspaces` · `GET /v1/slack/workspaces/:id` |
| 메시지 검색 | JWT | `GET /v1/slack/messages?...` |
| 스레드 조회 | JWT | `GET /v1/slack/threads?...` |

- 업로드는 **Slack Export ZIP** 또는 사전 변환된 **단일 JSON 번들** multipart다
  (ADR-0032가 ADR-0011 §1의 "ZIP 아님"을 대체). 형식은 서버가 **매직 바이트**로 판별하며
  클라이언트가 지정하지 않는다. 서버는 파일을 MinIO(원문 권위 사본) + `source_items`
  (kind=`slack`)에 이중 보존하고 transactional outbox를 통해 `slack-import` 큐로 파싱을 위임한다.
  **ZIP 해제는 워커에서** 하고, API는 압축을 풀지 않은 채 central directory만 선검사한다.
- 파싱은 워커에서 **비동기**다. 업로드 응답은 즉시 `status:"queued"`로 수락하고, 결과는
  **`GET /v1/slack/imports/:importId`**(§3)를 폴링해 `completed`/`failed`로 확인한다.
  `queued`만 보고 성공이라 말하지 않는다.
- Import는 **멱등**이다. 기본 `merge`는 생성·편집만 반영하고, 명시적 `snapshot`은 번들에 포함된
  채널 안에서만 누락 메시지를 삭제한다. 기존 tombstone은 재업로드로 복구하지 않는다.
- **접근제어(PRD §26)**: Slack 데이터는 개인 데이터다. `workspaces.ownerUserId == 요청자`인
  **소유자 본인만** 조회할 수 있다 — 가족 구성원·제3자 모두 불가(`403 Forbidden`).
- **로그 비노출(PRD §11)**: 메시지 원문/PII/secret/토큰을 운영 로그에 남기지 않는다(개수/식별자만).

---

## 1. 업로드 형식 (multipart 파일 `file`)

**두 형식을 받는다.** 서버가 매직 바이트(`PK\x03\x04`)로 판별한다 — content-type·확장자는
분기 근거가 아니다(사용자가 마음대로 쓸 수 있다).

### 1-A. Slack Export ZIP (권장)

Slack에서 내려받은 Export ZIP을 **그대로** 올린다. 압축을 직접 풀 필요가 없다.

```
channels.json                 채널 목록  [{ id, name, ... }]           ← 필수
users.json                    사용자 목록 [{ id, team_id, name, ... }]  ← 필수
groups.json / mpims.json      (있으면) 비공개 채널 · 멀티 DM — 채널 목록에 병합
<채널이름>/YYYY-MM-DD.json     그 채널의 그 날짜 메시지 배열
```

서버(워커)가 이 구조를 §1-B의 번들로 변환한 뒤 기존 파서에 넘긴다. 두 가지가 자동 처리된다.

1. **날짜 파일의 메시지에는 `channel` 필드가 없다** → 디렉터리 이름을 `channels.json`의
   `name`으로 찾아 채널 **id**를 채운다.
2. **편집 시각이 `edited: { user, ts }` 객체다** → `edited_ts` 문자열로 편다.

가져오지 않는 것(개수는 워커 로그에 남는다): `dms.json`(1:1 DM — 이름이 없고 가장 민감),
`integration_logs.json`, 멤버십 잡음 메시지(`channel_join`/`channel_leave` 등),
대응 채널을 찾지 못한 디렉터리.

**안전 상한** (`DEFAULT_ZIP_LIMITS` · ADR-0032 §4 — 전부 `[가설]`, 근거는 ADR 참조):

| 항목 | 상한 | 초과 시 코드 |
|---|---|---|
| 압축 파일 크기 | 50 MiB | `413` |
| 엔트리 개수 | 20,000 | `zip_too_many_entries` |
| 엔트리 개별 해제 크기 | 32 MiB | `zip_entry_too_large` |
| 누적 해제 크기 | 128 MiB | `zip_total_too_large` |
| 엔트리 압축비 | 200:1 | `zip_ratio_exceeded` |

경로 탈출(`../`·절대경로·역슬래시·NUL), 심볼릭 링크, 암호화 아카이브, Zip64·멀티디스크,
CRC 불일치는 **아카이브 전체를 거부**한다(일부만 처리하지 않는다).

### 1-B. 단일 JSON 번들 (기존 경로 — 유지)

클라이언트가 Slack export를 풀어 합친 **단일 JSON 번들**이다. 스크립트·고급 사용자를 위해
그대로 유지한다.

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
| `file` | ✅ | Slack Export **ZIP**(§1-A) 또는 단일 JSON 번들(§1-B). 최대 50MB. |
| `mySlackUserId` | 선택 | 내 Slack user id(예: `U1`) — `isMine`/`mine` 필터 기준. 미지정 시 기존 유지. |
| `workspaceName` | 선택 | 워크스페이스 표시명. **ZIP에는 워크스페이스 이름이 없으므로 사실상 필수다** — 미지정 시 업로드 **파일 이름**에서 유도하고, 그것도 없으면 `Slack`. JSON 번들은 `workspace.name`을 쓴다. |
| `kind` | 선택 | 데이터 컨테이너 종류(`personal` \| `company`). 기본 `company`. |
| `syncMode` | 선택 | `merge` \| `snapshot`. 기본 `merge`; `snapshot`은 `channels[]`에 포함된 채널만 완전본으로 간주. |

```bash
# 번들 파일 bundle.json 을 multipart 로 업로드
curl -s -X POST http://localhost:3001/v1/slack/import \
  -H 'Authorization: Bearer <accessToken>' \
  -F 'mySlackUserId=U1' \
  -F 'workspaceName=회사 슬랙' \
  -F 'kind=company' \
  -F 'syncMode=merge' \
  -F 'file=@bundle.json;type=application/json'

# Slack Export ZIP 을 그대로 업로드
curl -s -X POST http://localhost:3001/v1/slack/import \
  -H 'Authorization: Bearer <accessToken>' \
  -F 'workspaceName=회사 슬랙' \
  -F 'file=@"우리회사 Slack export Jan 1 2026 - Aug 1 2026.zip";type=application/zip'
```

### 응답 `200 OK` (`slackImportResponseSchema`)

```json
{
  "importId": "a1b2c3d4-…",
  "slackWorkspaceId": "f9e8d7c6-…",
  "syncMode": "merge",
  "status": "queued",
  "format": "zip"
}
```

| 필드 | 의미 |
|---|---|
| `importId` | 이번 import의 `source_items.id`(감사·원문 추적 키). 재업로드마다 **새 값**. |
| `slackWorkspaceId` | 대상 `slack_workspaces.id`. 소유 워크스페이스라 재업로드 시 **동일**. |
| `syncMode` | 적용한 동기화 방식. 누락 시 `merge`. |
| `status` | 항상 `queued`(outbox 접수). "완료"가 아니라 "등록"을 뜻한다 — 아래 §3을 폴링. |
| `format` | 서버가 매직 바이트로 판별한 형식(`json` \| `zip`). |

오류:

| 상황 | 응답 |
|---|---|
| `file` 누락 / JSON.parse 실패(번들 형식 위반) | `400` |
| ZIP 선검사 거부(경로 탈출·개수·크기·압축비·암호화 등) | `400` + 본문 `errorCode`(§3 어휘) |
| 인증 없음/만료 | `401` |
| 파일 크기 초과(50MB) | `413` |
| 동시 업로드 메모리 예산 초과 | `503` + `retryAfterSeconds` |

> 파싱은 비동기다 — `queued`는 파싱 완료가 **아니다**. 결과는 **§3의 import 상태 조회**로
> 확인한다. 워커가 처리 완료 시 `lastImportedAt`도 갱신된다.
>
> **503(동시 업로드)**: API는 업로드 파일을 메모리에 올리므로 프로세스 전역 예산
> (150MiB = 50MiB × 3)을 넘으면 거절한다. 사용자 잘못이 아니라 서버 여유 문제라 429가
> 아니며, 같은 파일을 잠시 뒤 그대로 다시 올리면 된다(ADR-0032 §5).

---

## 3. Import 상태 — `GET /v1/slack/imports/:importId`

사용자 인증(Bearer) 필요. **소유자 본인만** 조회한다(import의 워크스페이스 소유권을 다시
확인 — 비소유자 `403`, 없는 id `404`).

**왜 이 조회가 있는가**: 업로드 응답은 항상 `queued`라 그것만으로는 성공을 알 수 없었다.
구조 검증은 워커에서 하므로 HTTP 200 뒤에 실패할 수 있는데, 예전에는 사용자가 그 이유를
영영 알 수 없었다(PO 판정 Q3-4). 상태는 **DB(`slack_imports`, 마이그레이션 0054)**에 있어
새로고침·앱 재시작 뒤에도 복구된다 — BullMQ 잡은 `removeOnComplete`로 사라지므로 잡 상태에
기대지 않는다.

```json
{
  "importId": "a1b2c3d4-…",
  "slackWorkspaceId": "f9e8d7c6-…",
  "status": "completed",
  "format": "zip",
  "syncMode": "merge",
  "errorCode": null,
  "uploadBytes": 4823910,
  "attempt": 1,
  "channelCount": 12,
  "userCount": 34,
  "messageCount": 5821,
  "createdMessageCount": 5821,
  "updatedMessageCount": 0,
  "deletedMessageCount": 0,
  "skippedMessageCount": 0,
  "warningCount": 3,
  "queuedAt": "2026-08-13T02:11:04.000Z",
  "startedAt": "2026-08-13T02:11:06.000Z",
  "finishedAt": "2026-08-13T02:11:31.000Z"
}
```

| 필드 | 의미 |
|---|---|
| `status` | `queued`(outbox 대기) → `processing`(워커 처리 중) → `completed` \| `failed`. |
| `errorCode` | `failed`일 때만 채워진다. **닫힌 어휘**(아래) — 자유 텍스트가 아니다. |
| 건수 필드 | `completed` 전에는 **`null`**이다. "아직 모른다"와 "0건"은 다른 사실이다. |
| `attempt` | 워커 시도 횟수(재시도 포함). 재시도가 남아 있으면 실패해도 `processing`으로 남는다. |

### `errorCode` 어휘

| 코드 | 뜻 |
|---|---|
| `zip_invalid` | ZIP 구조가 아니거나 손상됨(EOCD 없음, CRC 불일치) |
| `zip_unsafe_entry` | 경로 탈출(zip-slip) 또는 심볼릭 링크 |
| `zip_too_many_entries` | 엔트리 개수 상한(20,000) 초과 |
| `zip_entry_too_large` | 엔트리 개별 해제 크기 상한(32MiB) 초과 |
| `zip_total_too_large` | 누적 해제 크기 상한(128MiB) 초과 |
| `zip_ratio_exceeded` | 압축비 상한(200:1) 초과 — zip bomb |
| `zip_encrypted` | 암호화된 아카이브 |
| `zip_unsupported` | Zip64 · 멀티디스크 · 미지원 압축 방식 |
| `zip_missing_channels` | 아카이브에 `channels.json`이 없음 |
| `zip_missing_users` | 아카이브에 `users.json`이 없음 |
| `zip_malformed_metadata` | 목록 파일이 JSON 배열이 아님 |
| `bundle_invalid_json` | 업로드가 JSON으로 파싱되지 않음 |
| `bundle_invalid_structure` | 번들 구조가 §1-B 계약과 다름 |
| `storage_unavailable` | MinIO에서 원문을 읽지 못함 |
| `internal_error` | 분류되지 않은 실패(상세는 서버 로그에만) |

> **원문·경로·PII는 이 값에 담기지 않는다.** 예외 메시지를 그대로 흘리면 객체 키·파일
> 경로·JSON 조각이 사용자 화면까지 새어 나간다(PRD §11 로그 비노출과 같은 원칙).

### 폴링 계약

- 권장: 30초까지 **2초** 간격, 이후 **5초** 간격.
- **처리 시간 SLO는 없다**(`[가설]`도 아니라 **모름**이다 — 운영 표본이 없다). 오래
  걸린다고 "실패"로 단정하지 말고 자동 갱신만 멈춘 뒤 재확인을 제안한다.
- `403`/`404`를 받으면 그 `importId`는 이 사용자의 것이 아니다 — 로컬에 기억해 둔 값이
  있으면 지운다.

---

## 4. 워크스페이스 — `GET /v1/slack/workspaces[/:id]`

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

## 5. 메시지 검색 — `GET /v1/slack/messages`

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

## 6. 스레드 조회 — `GET /v1/slack/threads`

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

> `messages[]` 항목은 §5 `slackMessageSummarySchema`와 동일하다.

---

## 7. 접근제어 · 멱등 요약

- **소유자 전용(PRD §26)**: 모든 조회와 메시지 변경은 `workspaces.ownerUserId == 요청자`를
  서비스 계층에서 강제한다. 비소유자(가족 구성원 포함)는 `403`, 목록에서는 미노출된다.
- **멱등(ADR-0011 §3)**: 재업로드는 새 `importId`를 만들지만 `(slackChannelId, ts)` change-set으로
  생성·편집·삭제를 한 번만 반영한다. 동일 source job 재시도는 빈 change-set이 되어 event를 늘리지 않는다.
- **삭제 범위**: `merge`의 누락 행은 보존한다. `snapshot`도 `channels[]`에 없는 채널은 건드리지 않는다.
  기존 tombstone 복구가 필요하면 별도 복구 정책/API가 필요하며 import는 자동 복구하지 않는다.
- **편집 순서**: 현재 메시지보다 `editedTs`가 없거나 오래된 수신 편집은 무시해 과거 export가 최신 값을
  덮지 못하게 한다.

---

## 8. 검증 (완료 조건 e2e)

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
