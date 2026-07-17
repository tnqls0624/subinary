"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 가족 스위처 (앱 셸 상단)
 *
 * - 여러 가족 전환(Zustand store에 선택 저장) + 현재 가족/역할 표시.
 * - "새 가족 만들기": 기존 사용자도 가족을 추가로 만들 수 있는 다이얼로그
 *   (온보딩과 동일한 create 흐름 재사용). 생성 후 그 가족으로 전환.
 * ------------------------------------------------------------------------- */
import { zodResolver } from "@hookform/resolvers/zod";
import { Check, ChevronsUpDown, Plus, Users } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import {
  householdCreateRequestSchema,
  type HouseholdCreateRequest,
  type HouseholdRole,
} from "@family/contracts";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import { cn } from "@/lib/utils";

const ROLE_LABEL: Record<HouseholdRole, string> = {
  owner: "소유자",
  admin: "관리자",
  member: "구성원",
  viewer: "뷰어",
};

export function HouseholdSwitcher() {
  const { authedFetch, refreshMemberships } = useAuth();
  const { householdId, setHouseholdId, activeMembership, memberships } =
    useHousehold();
  const [createOpen, setCreateOpen] = useState(false);

  const form = useForm<HouseholdCreateRequest>({
    resolver: zodResolver(householdCreateRequestSchema),
    defaultValues: { name: "" },
  });

  async function onCreate(values: HouseholdCreateRequest) {
    try {
      const created = await authedFetch((token) =>
        api.households.create(token, values),
      );
      await refreshMemberships();
      setHouseholdId(created.id);
      toast.success(`'${created.name}' 가족을 만들었어요.`);
      setCreateOpen(false);
      form.reset();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "가족 생성에 실패했습니다.";
      form.setError("name", { message });
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="h-9 max-w-56 justify-between gap-2"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Users className="text-muted-foreground size-4 shrink-0" />
              <span className="truncate">
                {activeMembership?.name ?? "가족 선택"}
              </span>
            </span>
            <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel className="text-muted-foreground text-xs">
            내 가족
          </DropdownMenuLabel>
          {memberships.map((m) => (
            <DropdownMenuItem
              key={m.householdId}
              onClick={() => setHouseholdId(m.householdId)}
              className="gap-2"
            >
              <Check
                className={cn(
                  "size-4",
                  m.householdId === householdId ? "opacity-100" : "opacity-0",
                )}
              />
              <span className="flex-1 truncate">{m.name}</span>
              <span className="text-muted-foreground text-xs">
                {ROLE_LABEL[m.role]}
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> 새 가족 만들기
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>새 가족 만들기</DialogTitle>
            <DialogDescription>
              내가 소유자가 되는 새 가족을 만듭니다.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form
              id="create-household-form"
              onSubmit={form.handleSubmit(onCreate)}
              noValidate
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>가족 이름</FormLabel>
                    <FormControl>
                      <Input placeholder="예: 우리집" autoFocus {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </form>
          </Form>
          <DialogFooter>
            <Button
              type="submit"
              form="create-household-form"
              disabled={form.formState.isSubmitting}
            >
              {form.formState.isSubmitting ? "만드는 중…" : "만들기"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
