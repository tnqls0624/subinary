"use client";
import { Gamepad2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ListRow, PageBackHeader } from "@/components/widgets";
import { MINIAPPS } from "@/lib/miniapp-registry";

/** 등록된 게임의 진입 목록. */
export default function PlayPage() {
  return <div className="mx-auto w-full max-w-2xl space-y-5">
    <PageBackHeader title="함께 놀기" />
    <Card className="divide-border divide-y overflow-hidden p-0">
      {MINIAPPS.map((app) => <ListRow key={app.key} href={`/play/app?key=${app.key}`}
        icon={<Gamepad2 />} title={app.name} subtitle={app.description} chevron />)}
    </Card>
  </div>;
}
