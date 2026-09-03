/**
 * 푸시 알림 유형(kind)과 안드로이드 알림 채널 매핑.
 *
 * 생산자(promotion / scheduler)와 소비자(notification-dispatch.processor), 그리고
 * 네이티브(createChannel)가 **같은 채널 id**를 써야 하므로 여기 한 곳에서 공유한다.
 * FCM HTTP v1 payload의 `android.notification.channel_id`와 네이티브
 * `PushNotifications.createChannel({ id })`가 이 값으로 합의된다.
 */

/** 알림 유형 → 안드로이드 채널 id. */
export const NOTIFICATION_CHANNELS = {
  transaction: 'txn',
  budget: 'budget',
  reminder: 'reminder',
  summary: 'summary',
  /** 결제가 반복 거절됨 — 사용자가 결제수단/한도를 손대야 하는 사건. */
  decline: 'decline',
  /**
   * 확정된 정기 결제가 곧 나간다 — 예고(금액 레이어 S3).
   *
   * `reminder`와 나눈 이유: 저기는 "이미 일어난 일 중 확인이 필요한 것"이고 여기는
   * "아직 일어나지 않은 일"이다. 성격이 달라 따로 끌 수 있어야 한다
   * (`docs/concept-upcoming-spend-2026-08.md` §5 "알림 피로").
   *
   * ⚠️ **끌 수 있는 범위는 Android뿐이다.** 채널 생성은 `native.ts`의
   * `platform === 'android'` 분기 안에 있고, 앱 내 알림 선호는 kind별이 아니다
   * (`pushEnabled`·`minAmount`·무음시간만). iOS에서는 앱 전체를 끄는 것뿐이므로,
   * 이 분리의 실효는 Android 시스템 설정과 **알림함에서의 구분**이다. kind별 선호를
   * 만들 때 이 kind가 그 기반이 된다.
   */
  upcoming: 'upcoming',
} as const;

export type NotificationKind = keyof typeof NOTIFICATION_CHANNELS;

/** 채널 메타(네이티브 createChannel + 시스템 설정 노출용 한국어 라벨). */
export interface NotificationChannelMeta {
  id: string;
  name: string;
  description: string;
}

/** 네이티브가 앱 시작 시 생성할 채널 정의(kind 순서 고정). */
export const NOTIFICATION_CHANNEL_META: readonly NotificationChannelMeta[] = [
  { id: NOTIFICATION_CHANNELS.transaction, name: '결제 알림', description: '새 결제·취소 알림' },
  { id: NOTIFICATION_CHANNELS.budget, name: '예산 알림', description: '예산 사용률 경고' },
  { id: NOTIFICATION_CHANNELS.reminder, name: '확인 리마인더', description: '확인이 필요한 거래 알림' },
  { id: NOTIFICATION_CHANNELS.summary, name: '소비 요약', description: '주간 소비 요약' },
  {
    id: NOTIFICATION_CHANNELS.decline,
    name: '결제 실패',
    description: '반복 거절된 결제 알림',
  },
  {
    id: NOTIFICATION_CHANNELS.upcoming,
    name: '정기 결제 예고',
    description: '내일 나갈 정기 결제 안내',
  },
];

/**
 * notification-dispatch 잡 payload. 생산자가 `kind`를 실으면 소비자가 유형별로
 * 수신자·메시지·채널을 해석한다. `sentTokenIds`는 재시도 간 중복 발송 방지용
 * 진행 상태(모든 kind 공통).
 */
export type NotificationDispatchJob =
  | {
      kind: 'transaction';
      householdId: string;
      transactionId: string;
      sentTokenIds?: string[];
    }
  | {
      kind: 'budget';
      householdId: string;
      budgetId: string;
      budgetName: string;
      /** 돌파한 임계치(백분율 정수): 80 | 100. */
      threshold: number;
      sentTokenIds?: string[];
    }
  | {
      kind: 'reminder';
      householdId: string;
      userId: string;
      /** 확인 필요(pending_review + duplicate_suspected) 건수. */
      count: number;
      sentTokenIds?: string[];
    }
  | {
      /**
       * 같은 가맹점·금액 결제가 반복 거절됐다. 카드사는 정기결제 실패를 매일 재시도하므로
       * 낱개가 아니라 묶음으로 알린다(실측: OO피트니스 99,000원 7일 연속).
       */
      kind: 'decline';
      householdId: string;
      /**
       * 표시용 가맹점명 — **canonical 신원**(정규화 + 사용자 별칭). 없으면 null.
       * 원문이 아닌 이유: 사용자가 `GS25`/`지에스25`를 같은 가게로 확정했으면 알림도
       * 화면(`listDeclines`)과 같은 이름·같은 묶음이어야 한다(P1-16).
       */
      merchant: string | null;
      /** 거절 금액(minor units). 없으면 null. */
      amount: number | null;
      /** 누적 거절 시도 횟수. */
      attempts: number;
      /** 거절 사유 코드. 문구를 못 알아봤으면 'unknown', 미파싱이면 null. */
      reason: string | null;
      sentTokenIds?: string[];
    }
  | {
      kind: 'summary';
      householdId: string;
      userId: string;
      /** 기간 순지출(KRW 정수). */
      totalNet: number;
      txnCount: number;
      /** 사람이 읽는 기간 라벨(예: '지난주'). */
      periodLabel: string;
      /**
       * 요약 기간이 속한 달(`YYYY-MM`, KST). 딥링크가 홈의 **그 달**을 열게 한다 —
       * 8월 1일에 오는 '지난주' 요약을 탭했을 때 8월 화면(거의 빈 화면)이 아니라
       * 7월 화면이 떠야 한다. 없으면 이번 달 홈으로 간다(구 잡 호환).
       */
      month?: string;
      sentTokenIds?: string[];
    }
  | {
      /**
       * 내일 나갈 정기 결제 예고. **하루 전 1회, 묶어서** 보낸다(기획 D5) —
       * 구독 8개면 개별 알림은 폭탄이다.
       */
      kind: 'upcoming';
      householdId: string;
      userId: string;
      /** 내일 예정된 확정 series 건수. */
      count: number;
      /**
       * 금액을 예고할 수 있는 것들의 합(KRW minor units). **`null`이면 금액을 말하지
       * 않는다** — 근거에 v1이 섞였거나 전부 외화인 경우다(기획 D2). 0과 구분해야
       * 한다: 0원은 "0원 나간다"는 뜻이고 null은 "얼마인지 모른다"는 뜻이다.
       */
      totalAmount: number | null;
      /** 금액을 세지 못해 합계에서 빠진 건수. 0이 아니면 문구가 그 사실을 말한다. */
      excludedCount: number;
      sentTokenIds?: string[];
    };

/** kind → 알림 탭 시 이동할 앱 내 딥링크 경로. */
export function notificationDeepLink(job: NotificationDispatchJob): string {
  switch (job.kind) {
    case 'transaction':
      return `/transactions?txn=${job.transactionId}`;
    case 'budget':
      return '/budgets';
    case 'reminder':
      return '/transactions?status=pending_review';
    case 'decline':
      return '/declines';
    case 'summary':
      return job.month
        ? `/dashboard?month=${encodeURIComponent(job.month)}`
        : '/dashboard';
    case 'upcoming':
      // 목록으로 보낸다 — 예고를 받은 사람이 다음에 하는 일은 "무엇이 나가는지 확인"이다.
      // 필터를 붙이지 않는다: P1-20("리마인더 딥링크가 이번 달 필터에 걸려 대상이 안
      // 보인다")이 그렇게 생겼다.
      return '/more/recurring';
  }
}
