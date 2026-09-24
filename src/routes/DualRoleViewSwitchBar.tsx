// 雙重身分(同時是這間商家的管理員/客服 **和** 服務人員)的檢視切換條。
//
// 為什麼要有這條橫幅(2026-09-24 線上故障的直接修正):
//   原本這個切換只存在於商家切換器(MerchantSwitcher)下拉選單的最下面一個選項。實機上使用者
//   根本沒找到它 —— 他要先點開左上角的商家切換器、往下滑到分隔線底下,才看得到「切換服務人員端」。
//   對一位「只是想看自己班表的師傅」來說,這完全不是他會想到要去點的地方。
//   結果就是:他登入後看到商家端的底部選單,而他身為客服又沒有被開任何客服權限,「功能」頁只剩
//   「目前沒有開放給你的功能,請聯絡商家管理員開通權限。」—— 整個 App 對他而言等於壞掉。
//
// 所以改成常駐在頂端列正下方的一整條橫幅:一定會被看到、不用點開任何東西、而且用一句話說明
// 「你現在在哪一端」。原本下拉選單裡的那個選項保留不動(有人可能已經習慣了,兩個入口指向同一個
// 動作,不會互相衝突)。
//
// 只有 isDualRoleEligible 為 true 時才渲染(見 appLayoutLogic.ts 的 shouldShowStaffViewSwitch):
//   ・純服務人員不需要 —— 他沒有商家端可以切過去。
//   ・純管理員/純客服不需要 —— 他沒有服務人員身分。
//   ・雙重身分但切到「沒有他的服務人員身分的那間商家」時也不需要 —— 那裡沒有東西可以切過去。

import { ArrowLeftRight } from "lucide-react";

import { Button } from "@/components/ui/button";

interface DualRoleViewSwitchBarProps {
  /** 目前顯示的是服務人員端還是商家端,決定說明文字與按鈕文字的方向。 */
  isStaffView: boolean;
  onToggle: () => void;
}

export function DualRoleViewSwitchBar({ isStaffView, onToggle }: DualRoleViewSwitchBarProps) {
  return (
    // flex-wrap 是刻意的:窄螢幕(320px)上說明文字跟按鈕會自動換成兩行,不會把整個頁面撐出
    // 橫向捲軸(e2e/mobile-overflow.spec.ts 有在檢查這件事)。
    <div data-testid="dual-role-view-switch" className="border-b border-brand/30 bg-brand-soft/60">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-5 py-2">
        <p className="min-w-0 text-xs text-foreground">
          {isStaffView ? (
            <>
              你目前在<span className="font-semibold">服務人員端</span>
              ,看到的是你自己的個人資料、行事曆與薪資。
            </>
          ) : (
            <>
              你目前在<span className="font-semibold">商家端</span>
              。你同時也是這間商家的服務人員,可以切換過去看自己的班表與薪資。
            </>
          )}
        </p>
        <Button
          type="button"
          size="sm"
          variant={isStaffView ? "outline" : "default"}
          className="shrink-0"
          onClick={onToggle}
        >
          <ArrowLeftRight className="mr-1.5 h-3.5 w-3.5" />
          {isStaffView ? "切換到商家端" : "切換到服務人員端"}
        </Button>
      </div>
    </div>
  );
}
