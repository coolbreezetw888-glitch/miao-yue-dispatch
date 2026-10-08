// 客戶端第 2 批(C2-E04 / C2-C06):同意勾選框裡「會員政策」點開的小卡窗。
// 檢視型(只顯示商家自己打的會員政策,純文字),沒有任何欄位 ⇒ 不需要 dirty。
// 刻意獨立成一個檔案:勾選框所在的畫面有輸入欄位,放在一起會被 overlayDirtyWiringGuard 當成「有欄位的視窗」。

import {
  CardDialog,
  CardDialogClose,
  CardDialogContent,
  CardDialogFooter,
  CardDialogHeader,
  CardDialogTitle,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";

export function MemberPolicyDialog({
  open,
  onOpenChange,
  merchantName,
  content,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  merchantName: string;
  content: string;
}) {
  return (
    <CardDialog open={open} onOpenChange={onOpenChange}>
      <CardDialogContent aria-describedby={undefined} data-testid="member-policy-dialog">
        <CardDialogHeader>
          <CardDialogTitle>{`${merchantName}會員政策`}</CardDialogTitle>
        </CardDialogHeader>
        <p className="whitespace-pre-line break-words text-sm leading-relaxed text-foreground">
          {content}
        </p>
        <CardDialogFooter>
          <CardDialogClose asChild>
            <Button type="button" variant="primary" size="touch">
              我知道了
            </Button>
          </CardDialogClose>
        </CardDialogFooter>
      </CardDialogContent>
    </CardDialog>
  );
}
