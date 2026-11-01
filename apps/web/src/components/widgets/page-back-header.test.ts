import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { canGoBackInApp, noteInAppNavigation, resetInAppNavigations } from "@/lib/nav-history";
import { isTabRoot } from "@/lib/nav-tabs";

const navigation = vi.hoisted(() => ({
  path: "/cards",
  back: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.path,
  useRouter: () => ({ back: navigation.back, replace: navigation.replace }),
}));

import { PageBackHeader } from "./page-back-header";

function pressBack(backHref?: string) {
  const header = PageBackHeader({ title: "페이지", backHref }) as ReactElement<{
    children: ReactElement<{ onClick: () => void }>[];
  }>;
  header.props.children[0]!.props.onClick();
}

beforeEach(() => {
  resetInAppNavigations();
  vi.clearAllMocks();
  navigation.path = "/cards";
});

describe("page back keeps legacy pages inside the new hierarchy", () => {
  it("cold card entry replaces with assets instead of leaving the app", () => {
    noteInAppNavigation(navigation.path);
    pressBack();
    expect(navigation.replace).toHaveBeenCalledWith("/assets");
    expect(navigation.back).not.toHaveBeenCalled();
  });

  it("explicit backHref wins over inferred parent for a cold entry", () => {
    noteInAppNavigation(navigation.path);
    pressBack("/more");
    expect(navigation.replace).toHaveBeenCalledWith("/more");
  });

  it("an actual previous list still wins over an explicit fallback", () => {
    noteInAppNavigation("/todo");
    noteInAppNavigation(navigation.path);
    pressBack("/assets");
    expect(navigation.back).toHaveBeenCalledOnce();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("cold declines → todo → ledger never invents an earlier history entry", () => {
    navigation.path = "/declines";
    noteInAppNavigation(navigation.path);
    pressBack();
    expect(navigation.replace).toHaveBeenLastCalledWith("/todo");
    navigation.path = "/todo";
    noteInAppNavigation(navigation.path);
    expect(canGoBackInApp()).toBe(false);
    pressBack();
    expect(navigation.replace).toHaveBeenLastCalledWith("/transactions");
    noteInAppNavigation("/transactions");
    expect(canGoBackInApp()).toBe(false);
    expect(isTabRoot("/transactions")).toBe(true);
    expect(navigation.back).not.toHaveBeenCalled();
  });
});
