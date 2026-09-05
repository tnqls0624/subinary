"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 플레이그라운드 (/play)
 *
 * 지출 데이터로 노는 작은 화면들이 모이는 자리다.
 *
 * ## 왜 별도 자리인가
 *
 * 홈·거래·예산은 **답을 얻으러 오는 화면**이라 화면당 질문이 하나여야 한다. 놀이는
 * 성격이 다르다 — 목적 없이 들어와 둘러보는 것이 자연스럽다. 섞으면 둘 다 나빠진다.
 *
 * ## 여기 들어올 수 있는 것의 기준
 *
 * 이 저장소의 원칙이 놀이에도 그대로 적용된다. **관측된 사실만 말한다.**
 *
 * - ✅ "지난달 같은 기간보다 182,969원 적어요" — 두 숫자 모두 실측이다
 * - ⛔ "평소보다 많이 썼어요" — '평소'의 기준을 지어내야 한다
 * - ⛔ 절약 점수·등급 — A등급의 A가 어디서 오는지 설명할 수 없다
 * - ⛔ 무지출 연속 보상 — "지출 없는 날이 좋은 날"이라는 가치판단을 시스템이 만든다.
 *   병원비를 낸 날이 실패가 된다
 *
 * 게임적 재미는 판정에서 나오지 않아도 된다. 진행 중인 비교, 수집, 연속 기록처럼
 * **사실을 배치하는 방식**만으로 충분히 나온다.
 *
 * ## 구조에 대한 메모
 *
 * 지금은 그냥 라우트다. 미니앱을 격리 실행(iframe + postMessage)하거나 별도 번들로
 * 배포하는 구조는 **아직 만들지 않는다** — 제공자가 우리 자신뿐이라 격리가 막아 줄
 * 것이 없다. 그 구조가 값을 하는 시점은 우리가 아닌 사람이 미니앱을 만들 때다.
 * 몇 개를 만들어 보고 **공통으로 필요했던 것만** 브릿지로 뽑는다.
 * ------------------------------------------------------------------------- */
import { Gauge } from "lucide-react";

import { Card } from "@/components/ui/card";
import { ListRow, PageBackHeader } from "@/components/widgets";

interface PlayItem {
  href: string;
  icon: typeof Gauge;
  title: string;
  description: string;
}

const ITEMS: ReadonlyArray<PlayItem> = [
  {
    href: "/play/pace",
    icon: Gauge,
    title: "이번 달 페이스",
    description: "지난달 같은 날짜까지와 나란히 견줘요",
  },
];

export default function PlayPage() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <PageBackHeader
        title="플레이그라운드"
        subtitle="쌓인 지출로 보는 작은 화면들이에요"
      />
      <Card className="divide-border divide-y overflow-hidden p-0">
        {ITEMS.map((item) => (
          <ListRow
            key={item.href}
            href={item.href}
            icon={<item.icon />}
            title={item.title}
            subtitle={item.description}
            chevron
          />
        ))}
      </Card>
    </div>
  );
}
