ALTER TABLE "notification_preferences" ALTER COLUMN "notify_own_collected" SET DEFAULT false;--> statement-breakpoint
-- 기존 행도 함께 반전한다. 현재 값 true는 사용자가 고른 것이 아니라 행 생성 시
-- 박힌 옛 기본값이며, 기본값만 바꾸면 기존 사용자에게는 아무 효과가 없다.
-- 되돌리려면 앱 알림 설정에서 "내 결제도 알림"을 다시 켜면 된다.
UPDATE "notification_preferences" SET "notify_own_collected" = false;
