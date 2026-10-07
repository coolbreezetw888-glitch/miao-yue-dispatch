// SPECS-INDEX #998 第 11 批 I:句中「目前開啟 / 目前關閉」狀態字(開綠、關紅、粗體)。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { OnOffStateText } from "./OnOffStateText";

afterEach(() => cleanup());

describe("OnOffStateText(#998 第 11 批 I)", () => {
  it("開 ⇒ 預設文字「目前開啟」、綠色粗體語意 token、data-state=on", () => {
    render(<OnOffStateText on testId="s" />);
    const el = screen.getByTestId("s");
    expect(el.tagName).toBe("SPAN");
    expect(el.textContent).toBe("目前開啟");
    expect(el).toHaveAttribute("data-state", "on");
    expect(el.className).toContain("text-success-strong");
    expect(el.className).toContain("font-semibold");
    expect(el.className).not.toContain("text-destructive-strong");
  });

  it("關 ⇒ 預設文字「目前關閉」、紅色粗體語意 token、data-state=off", () => {
    render(<OnOffStateText on={false} testId="s" />);
    const el = screen.getByTestId("s");
    expect(el.textContent).toBe("目前關閉");
    expect(el).toHaveAttribute("data-state", "off");
    expect(el.className).toContain("text-destructive-strong");
    expect(el.className).toContain("font-semibold");
    expect(el.className).not.toContain("text-success-strong");
  });

  it("可以換文字(料錢成本管理頁用「目前已開啟 / 目前已關閉」)", () => {
    const { rerender } = render(
      <OnOffStateText on onText="目前已開啟" offText="目前已關閉" testId="s" />,
    );
    expect(screen.getByTestId("s").textContent).toBe("目前已開啟");
    rerender(<OnOffStateText on={false} onText="目前已開啟" offText="目前已關閉" testId="s" />);
    expect(screen.getByTestId("s").textContent).toBe("目前已關閉");
  });

  it("沒有寫死色碼(只用語意 token):class 不含 #、rgb、emerald、red-、green-", () => {
    for (const on of [true, false]) {
      render(<OnOffStateText on={on} testId={`s-${on}`} />);
      const cls = screen.getByTestId(`s-${on}`).className;
      expect(cls).not.toMatch(
        /#|rgb|emerald|red-|green-|text-success\b(?!-)|text-destructive\b(?!-)/,
      );
    }
  });
});
