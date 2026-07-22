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
      kind: 'summary';
      householdId: string;
      userId: string;
      /** 기간 순지출(KRW 정수). */
      totalNet: number;
      txnCount: number;
      /** 사람이 읽는 기간 라벨(예: '지난주'). */
      periodLabel: string;
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
    case 'summary':
      return '/dashboard';
  }
}
