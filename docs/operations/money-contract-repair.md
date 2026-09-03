# 금액 계약 수리 운영 절차 (ADR-0027 7단계)

> 적용 환경: 로컬 맥의 `docker-compose.prod.yml` 단일 운영 서버
> 관련 결정: [ADR-0027](../adr/0027-single-transaction-money-contract.md) §데이터 마이그레이션 계획

5단계 전환(`MONEY_CONTRACT_MODE=v2`)은 **앞으로 쓰이는 행**에만 적용된다. 그 전에 만들어진
행은 `money_contract_version = 1`로 남고, 8단계 VALIDATE는 "v2 행에만 적용되는 제약"을
검증하므로 v1 행이 남아 있는 한 열 수 없다. 이 절차가 그 잔여를 없앤다.

## 이 도구가 하지 않는 것부터

**자동 적용은 금액을 한 원도 바꾸지 않는다.** 계약 버전 스탬프만 찍는다.

금액이나 취소 체인이 바뀌는 판정(`krw_amount_delta` · `fx_amount_delta` · `plan_failed` ·
`link_target_differs`)은 하나도 자동 적용하지 않고 manifest에 남긴다. 그 행들은 사람이
`transaction_money_repair_log`의 before/after를 보고 개별 판단해야 한다.

그래서 `plan`이 "검토 N건"을 보고했다고 해서 절차가 실패한 것이 아니다. **검토 대상이
있다는 사실을 아는 것이 이 단계의 절반**이다.

## 1. 현황 확인

```bash
pnpm money:repair:status
```

마지막 줄의 `남은 v1 N건`이 이 단계의 완료 지표다. 0이 되면 8단계로 갈 수 있다.

## 2. 계획 적재 (거래 행을 바꾸지 않는다)

```bash
pnpm money:repair:plan
```

v1 행 전체에 관찰기를 재생해 **미적용 manifest**를 적재한다. 쓰는 곳은
`transaction_money_repair_log`뿐이고 `card_transactions`는 건드리지 않는다.

출력의 `자동(스탬프) N건 · 사람 검토 M건`과 판정 분포를 확인한다. 종료 코드가 `1`이면
검토 대상이 있다는 뜻이다(실패가 아니다).

> 판정 로직은 이 스크립트에 없다. 운영 이미지의 `@family/transaction-domain`에 있는
> 관찰기를 그대로 부른다 — 게이트와 수리가 다른 답을 내지 않게 하기 위해서다.

## 3. 적용

```bash
node scripts/repair-money-contract.mjs apply <batch-id>
```

배치의 **auto 행만** `money_contract_version = 2`로 올린다. 행마다 짧은 트랜잭션에서
`FOR UPDATE`로 대상을 다시 읽고 체크섬을 대조한다.

| 결과 | 뜻 | 조치 |
| --- | --- | --- |
| `적용 N건` | 스탬프 완료 | — |
| `낡은 manifest N건` | 계획 이후 누군가 그 거래를 수정했다 | `plan`을 다시 돌려 새 배치를 만든다. 덮어쓰지 않은 것이 **정상 동작**이다 |
| `이미 v2 N건` | 이전 실행이 이미 처리 | 무해. 이 명령은 멱등하다 |
| `사람 검토로 남김 N건` | auto 대상이 아님 | 아래 4절 |

종료 코드: `0` 정상 · `1` 검토 대상 잔존 · `2` 낡은 manifest를 건너뜀 · `3` 실행 실패.

## 4. 사람 검토 대상 처리

자동으로 넘어가지 않은 행은 manifest에 남아 있다. 판정별로 무엇을 봐야 하는지는 ADR
§데이터 마이그레이션 계획 §2의 분류표를 따른다.

```sql
select transaction_id, reason, net_amount_before, net_amount_after, net_amount_delta, note
from transaction_money_repair_log
where batch_id = '<batch-id>' and reason like 'repair:review:%'
order by abs(coalesce(net_amount_delta, 0)) desc;
```

⚠️ 이 테이블은 금액과 (`restore_image`를 통해) 가맹점명을 담는다. **운영 로그·관측 싱크로
내보내지 말 것** — ADR은 운영 로그에 집계 수치만 쓰라고 정한다.

## 5. 되돌림

```bash
node scripts/repair-money-contract.mjs revert <batch-id>
```

배치를 역순으로 되돌린다. `checksum_after`가 현재 행과 다르면 **되돌리지 않는다** — 적용 후
사용자가 그 거래를 손댔다는 뜻이고, 자동 되돌림이 그 수정을 덮어쓰는 것보다 멈추는 편이
안전하다(ADR §4). 멈춘 행은 `revert_blocked_reason`을 갖고, 사람이 before/after와 현재값을
병합해야 한다.

환율 스냅샷과 수리 로그는 되돌려도 삭제하지 않는다.

## 6. 완료 판정

`남은 v1 0건`이면 8단계(VALIDATE 마이그레이션)로 넘어간다. v1 행이 의도적으로 남는다면
이유와 건수를 ADR 롤아웃 표에 적고 넘어간다 — **설명되지 않는 잔존은 두지 않는다.**
