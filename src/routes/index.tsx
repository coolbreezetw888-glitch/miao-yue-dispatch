import { Link } from "react-router-dom";
import {
  AlertCircle,
  ArrowRight,
  BadgeCheck,
  Banknote,
  Building2,
  CalendarDays,
  CalendarRange,
  Check,
  ClipboardList,
  CreditCard,
  Gift,
  Home,
  Mail,
  MessageCircle,
  MessagesSquare,
  Puzzle,
  Smartphone,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { Reveal } from "@/components/Reveal";
import { SectionHeading } from "@/components/SectionHeading";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

const navLinks = [
  { href: "#功能特色", label: "功能特色" },
  { href: "#方案定價", label: "方案定價" },
  { href: "#適用產業", label: "適用產業" },
  { href: "#常見問題", label: "常見問題" },
];

const features = [
  {
    icon: Sparkles,
    title: "智慧建單",
    desc: "輸入文字訊息自動解析並填好預約內容，人工確認送出即可。",
  },
  {
    icon: CalendarDays,
    title: "跨店共用行事曆",
    desc: "同一服務人員在多商家的行程共用，自動避開時段衝突。",
  },
  {
    icon: MessagesSquare,
    title: "LINE 通知整合",
    desc: "預約狀態變化自動發送 LINE 通知給客戶與師傅。",
  },
  {
    icon: Banknote,
    title: "彈性計薪",
    desc: "按件計酬與月薪制並存，系統自動算薪、自動算請假扣款。",
  },
  {
    icon: CalendarRange,
    title: "排班排休管理",
    desc: "整天休／時段休皆可設定，月休天數自動核算出勤門檻。",
  },
  {
    icon: Gift,
    title: "會員與紅利系統",
    desc: "會員分級、紅利點數、推薦獎勵、生日贈點一次管理。",
  },
  {
    icon: Puzzle,
    title: "產業模組化",
    desc: "新增商家時選擇到店服務或到府派工模組，自動套用一組建議功能開關。",
  },
  {
    icon: CreditCard,
    title: "多元支付整合",
    desc: "現場支付、銀行匯款、LINE Pay、街口、信用卡，依商家需求開啟。",
  },
  {
    icon: Smartphone,
    title: "師傅端行動排程介面",
    desc: "手機瀏覽器即可查看訂單、回報完工、確認排休，不需另外下載 App。",
  },
];

const beforeItems = [
  "訊息散落難追蹤",
  "跨店排程常撞期",
  "抽成薪資靠人工對帳",
  "排休記錄零散",
  "會員資料沒系統化留存",
];

const afterItems = [
  "智慧建單自動解析",
  "行事曆跨店共用，自動避開衝突",
  "按件計酬／月薪雙軌自動算薪",
  "排休時段化＋月休天數自動核算",
  "會員紅利／推薦系統整合",
];

const steps = [
  "客戶或客服建單",
  "系統智慧解析並指派師傅",
  "師傅接單、到場、完工回報",
  "系統自動核算抽成與薪資",
];

const faqs = [
  {
    q: "收費怎麼算？",
    a: "依商家數與服務人員數計費，基礎版 $99/月起，進階版為每間商家 $399/月加每位服務人員 $199/月。用多少算多少，隨時可調整。",
  },
  {
    q: "需要綁約嗎？",
    a: "不需要。以月為單位訂閱，隨時可以停用，資料在停用後仍保留一段時間供您匯出。",
  },
  {
    q: "師傅端要下載 App 嗎？",
    a: "不用。師傅端是響應式網頁，用手機瀏覽器開啟連結就能看訂單、回報完工與確認排休。",
  },
  {
    q: "LINE 通知怎麼設定？",
    a: "在後台綁定您的 LINE 官方帳號後，選擇要在哪些狀態（建單、確認、提醒、完工）發送通知即可，範本可自訂。",
  },
  {
    q: "適合多小的團隊使用？",
    a: "一人工作室也適用。基礎版含 1 間商家與最多 3 位服務人員，團隊變大再升級即可。",
  },
  {
    q: "資料安全嗎？",
    a: "全站採加密傳輸，帳號權限分級，商家只看得到自己的訂單與客戶資料，並有定期備份。",
  },
  {
    q: "大概多久能上線？",
    a: "多數商家在半天內即可完成設定。選好產業模組、建立服務項目與人員，就能開始接單。",
  },
  {
    q: "哪些產業適用？",
    a: "到店服務如美業、美髮、按摩、整骨；到府派工如冷氣維修、防水工程、水電等，都能用同一套系統。",
  },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-background font-sans antialiased">
      <Header />
      <main>
        <Hero />
        <Showcase />
        <Comparison />
        <Positioning />
        <Features />
        <Workflow />
        <StaffMobile />
        <Pricing />
        <Industries />
        <Advantages />
        <Onboarding />
        <Faq />
        <Contact />
      </main>
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-border/70 bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
        <a href="#top" className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-brand-foreground">
            秒
          </span>
          <span className="text-lg font-bold tracking-tight text-foreground">秒約</span>
        </a>
        <nav className="hidden items-center gap-8 md:flex">
          {navLinks.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-primary"
            >
              {l.label}
            </a>
          ))}
        </nav>
        <Button asChild variant="brand" size="default">
          <Link to="/signin">登入 / Sign in</Link>
        </Button>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section id="top" className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-40 h-[480px] bg-[radial-gradient(60%_60%_at_50%_40%,var(--brand-soft),transparent_70%)]"
      />
      <div className="relative mx-auto max-w-4xl px-5 py-24 text-center sm:py-32">
        <Reveal>
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-4 py-1.5 text-xs font-medium text-muted-foreground">
            <BadgeCheck className="size-4 text-cta" />
            到店服務 × 到府派工，一套系統通用
          </span>
        </Reveal>
        <Reveal delay={80}>
          <h1 className="mt-7 text-4xl leading-tight font-extrabold tracking-tight text-foreground sm:text-6xl">
            秒約，派工排程
            <span className="text-primary">一次搞定</span>
          </h1>
        </Reveal>
        <Reveal delay={160}>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            客戶預約、師傅排程、帳務結算，一套系統全部串起來——到店服務、到府派工都適用。
          </p>
        </Reveal>
        <Reveal delay={240}>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <Button asChild variant="cta" size="xl">
              <Link to="/signin">
                立即登入 <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="xl">
              <a href="#功能特色">看看功能</a>
            </Button>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

const mockOrders = [
  { time: "09:30", name: "王小姐", item: "頭皮深層護理", staff: "阿哲", status: "已完成" },
  { time: "11:00", name: "陳先生", item: "冷氣保養 × 2 台", staff: "俊良", status: "已確認" },
  { time: "14:15", name: "林小姐", item: "肩頸舒壓 60 分", staff: "怡君", status: "已確認" },
  { time: "16:00", name: "黃先生", item: "浴室防水估價", staff: "待指派", status: "待確認" },
];

function statusClass(status: string) {
  if (status === "已完成") return "bg-cta-soft text-cta";
  if (status === "已確認") return "bg-brand-soft text-accent-foreground";
  return "bg-warn/15 text-warn";
}

function Showcase() {
  return (
    <section className="bg-surface py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-5">
        <SectionHeading
          eyebrow="Real-time"
          title="今天的單，所有人同一個畫面"
          subtitle="客服建單、師傅接單、客戶收到 LINE 通知，狀態即時同步，不必再互相追問。"
        />
        <Reveal className="mt-12">
          <div className="mx-auto max-w-3xl overflow-hidden rounded-2xl border border-border bg-card shadow-xl shadow-primary/5">
            <div className="flex items-center justify-between border-b border-border bg-surface px-5 py-3">
              <div className="flex items-center gap-2">
                <span className="size-2.5 rounded-full bg-destructive/50" />
                <span className="size-2.5 rounded-full bg-warn/60" />
                <span className="size-2.5 rounded-full bg-cta/60" />
              </div>
              <p className="text-xs font-medium text-muted-foreground">今日訂單 · 3 月 12 日</p>
            </div>
            <ul className="divide-y divide-border">
              {mockOrders.map((o) => (
                <li
                  key={o.time}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 text-sm"
                >
                  <span className="w-14 font-semibold tabular-nums text-foreground">{o.time}</span>
                  <span className="font-medium text-foreground">{o.name}</span>
                  <span className="text-muted-foreground">{o.item}</span>
                  <span className="ml-auto text-xs text-muted-foreground">師傅：{o.staff}</span>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusClass(o.status)}`}
                  >
                    {o.status}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-2 border-t border-border bg-surface px-5 py-3 text-xs text-muted-foreground">
              <MessageCircle className="size-4 text-cta" />
              LINE 通知已於 08:12 發送給 4 位客戶與 3 位師傅
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Comparison() {
  return (
    <section className="py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-5">
        <SectionHeading
          eyebrow="Before / After"
          title="導入前 vs. 導入後"
          subtitle="同樣的團隊、同樣的單量，差別在於資訊有沒有被系統接住。"
        />
        <div className="mt-14 grid gap-6 md:grid-cols-2">
          <Reveal>
            <div className="h-full rounded-2xl border border-border bg-surface p-7">
              <h3 className="flex items-center gap-2 text-lg font-bold text-foreground">
                <AlertCircle className="size-5 text-destructive" /> 導入前
              </h3>
              <ul className="mt-6 space-y-4">
                {beforeItems.map((t) => (
                  <li key={t} className="flex items-start gap-3 text-sm text-muted-foreground">
                    <X className="mt-0.5 size-4 shrink-0 text-destructive" />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <div className="h-full rounded-2xl border border-cta/30 bg-cta-soft/50 p-7">
              <h3 className="flex items-center gap-2 text-lg font-bold text-foreground">
                <BadgeCheck className="size-5 text-cta" /> 導入後
              </h3>
              <ul className="mt-6 space-y-4">
                {afterItems.map((t) => (
                  <li key={t} className="flex items-start gap-3 text-sm text-foreground">
                    <Check className="mt-0.5 size-4 shrink-0 text-cta" />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function Positioning() {
  return (
    <section className="bg-surface py-20">
      <div className="mx-auto max-w-3xl px-5 text-center">
        <Reveal>
          <p className="text-lg leading-loose font-medium text-foreground sm:text-xl">
            秒約是為到店服務與到府派工業者打造的派工預約系統，提供商家後台、師傅端排程介面、客戶自助預約頁，一套系統涵蓋接單到結算全流程。
          </p>
        </Reveal>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section id="功能特色" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-5">
        <SectionHeading
          eyebrow="Features"
          title="核心功能"
          subtitle="從建單到結算，每個環節都有對應的自動化。"
        />
        <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f, i) => (
            <Reveal key={f.title} delay={(i % 3) * 90}>
              <div className="group h-full rounded-2xl border border-border bg-card p-7 transition-all hover:-translate-y-1 hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5">
                <span className="flex size-11 items-center justify-center rounded-xl bg-brand-soft text-primary">
                  <f.icon className="size-5" />
                </span>
                <h3 className="mt-5 text-base font-bold text-foreground">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.desc}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Workflow() {
  return (
    <section className="bg-surface py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-5">
        <SectionHeading eyebrow="Workflow" title="一張單的完整流程" />
        <div className="mt-14 grid gap-4 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] md:items-center">
          {steps.map((s, i) => (
            <div key={s} className="contents">
              <Reveal delay={i * 90}>
                <div className="h-full rounded-2xl border border-border bg-card p-6 text-center">
                  <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-brand text-sm font-bold text-brand-foreground">
                    {i + 1}
                  </span>
                  <p className="mt-4 text-sm font-semibold text-foreground">{s}</p>
                </div>
              </Reveal>
              {i < steps.length - 1 ? (
                <div className="flex justify-center text-primary/50" aria-hidden>
                  <ArrowRight className="size-5 rotate-90 md:rotate-0" />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function StaffMobile() {
  return (
    <section className="py-20 sm:py-28">
      <div className="mx-auto grid max-w-6xl items-center gap-14 px-5 lg:grid-cols-2">
        <Reveal>
          <div>
            <p className="text-sm font-semibold tracking-widest text-primary uppercase">
              Staff interface
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
              師傅端，用手機瀏覽器就能開
            </h2>
            <p className="mt-5 text-base leading-relaxed text-muted-foreground">
              師傅端是響應式網頁介面，透過手機瀏覽器開啟即可使用，不是需要安裝的原生 App，
              也不需要通過任何商店審核或更新。
            </p>
            <ul className="mt-7 space-y-3">
              {["我的訂單列表", "當日排程", "完工回報按鈕", "我的帳務摘要"].map((t) => (
                <li key={t} className="flex items-center gap-3 text-sm font-medium text-foreground">
                  <Check className="size-4 text-cta" />
                  {t}
                </li>
              ))}
            </ul>
            <p className="mt-7 rounded-xl border border-border bg-surface px-5 py-4 text-sm text-muted-foreground">
              「師傅端不用下載 App，手機瀏覽器打開就能用」
            </p>
          </div>
        </Reveal>

        <Reveal delay={120}>
          <div className="mx-auto w-[300px] rounded-[2.5rem] border-8 border-foreground/85 bg-card shadow-2xl shadow-primary/10">
            <div className="mx-auto mt-3 h-1.5 w-16 rounded-full bg-foreground/20" />
            <div className="px-4 py-5">
              <p className="text-xs text-muted-foreground">阿哲師傅 · 今日</p>
              <h3 className="mt-1 text-base font-bold text-foreground">我的訂單</h3>
              <ul className="mt-4 space-y-3">
                {mockOrders.slice(0, 3).map((o) => (
                  <li key={o.time} className="rounded-xl border border-border bg-surface p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-foreground">{o.time}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusClass(o.status)}`}
                      >
                        {o.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {o.name} · {o.item}
                    </p>
                  </li>
                ))}
              </ul>
              <div className="mt-4 rounded-xl bg-brand-soft p-3">
                <p className="text-[11px] text-accent-foreground">本月帳務摘要</p>
                <p className="mt-1 text-lg font-bold text-foreground">
                  NT$ 48,200 <span className="text-xs font-medium text-muted-foreground">待結</span>
                </p>
              </div>
              <div className="mt-4 w-full rounded-xl bg-cta py-2.5 text-center text-sm font-semibold text-cta-foreground">
                回報完工
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Pricing() {
  return (
    <section id="方案定價" className="scroll-mt-20 bg-surface py-20 sm:py-28">
      <div className="mx-auto max-w-5xl px-5">
        <SectionHeading eyebrow="Pricing" title="方案定價" subtitle="從一人工作室到多分店團隊。" />
        <div className="mt-14 grid gap-6 md:grid-cols-2">
          <Reveal>
            <div className="h-full rounded-2xl border border-border bg-card p-8">
              <h3 className="text-lg font-bold text-foreground">基礎版</h3>
              <p className="mt-4 text-3xl font-extrabold text-foreground">$99/月起</p>
              <p className="mt-3 text-sm text-muted-foreground">含 1 間商家、最多 3 位服務人員</p>
              <Button asChild variant="outline" size="lg" className="mt-8 w-full">
                <Link to="/signup">建立帳號</Link>
              </Button>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <div className="relative h-full rounded-2xl border-2 border-primary bg-card p-8 shadow-lg shadow-primary/10">
              <span className="absolute -top-3 left-8 rounded-full bg-cta px-3 py-1 text-xs font-semibold text-cta-foreground">
                多店推薦
              </span>
              <h3 className="text-lg font-bold text-foreground">進階版</h3>
              <p className="mt-4 text-2xl font-extrabold text-foreground">
                每間商家 $399/月
                <span className="block text-lg">+ 每位服務人員 $199/月</span>
              </p>
              <p className="mt-3 text-sm text-muted-foreground">適合多分店、多師傅團隊</p>
              <Button asChild variant="cta" size="lg" className="mt-8 w-full">
                <Link to="/signup">建立帳號</Link>
              </Button>
            </div>
          </Reveal>
        </div>
        <p className="mt-8 text-center text-xs text-muted-foreground">
          （以上為暫定方案，正式定價待確認）
        </p>
      </div>
    </section>
  );
}

function Industries() {
  const items = [
    {
      icon: Building2,
      title: "到店服務",
      desc: "美業／美髮／按摩／整骨等，客戶到店預約，行事曆依設計師與床位自動排。",
    },
    {
      icon: Home,
      title: "到府派工",
      desc: "冷氣維修／防水工程／水電等，師傅到府服務，依區域與時段指派最適人選。",
    },
  ];
  return (
    <section id="適用產業" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-5xl px-5">
        <SectionHeading eyebrow="Use cases" title="適用產業" />
        <div className="mt-14 grid gap-6 md:grid-cols-2">
          {items.map((it, i) => (
            <Reveal key={it.title} delay={i * 120}>
              <div className="h-full rounded-2xl border border-border bg-card p-8">
                <span className="flex size-12 items-center justify-center rounded-xl bg-brand-soft text-primary">
                  <it.icon className="size-6" />
                </span>
                <h3 className="mt-5 text-xl font-bold text-foreground">{it.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{it.desc}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Advantages() {
  const items = [
    { icon: ClipboardList, title: "少漏單" },
    { icon: CalendarDays, title: "跨店不撞期" },
    { icon: Banknote, title: "薪資自動算" },
    { icon: Gift, title: "會員留得住" },
  ];
  return (
    <section className="bg-surface py-16">
      <div className="mx-auto grid max-w-5xl gap-4 px-5 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((it, i) => (
          <Reveal key={it.title} delay={i * 80}>
            <div className="flex h-full flex-col items-center gap-3 rounded-2xl border border-border bg-card px-5 py-7 text-center">
              <it.icon className="size-6 text-cta" />
              <p className="text-base font-bold text-foreground">{it.title}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function Onboarding() {
  const items = ["選擇產業模組", "設定服務項目與人員", "開始接單"];
  return (
    <section className="py-20 sm:py-28">
      <div className="mx-auto max-w-5xl px-5">
        <SectionHeading eyebrow="Onboarding" title="三步驟就能開始" />
        <div className="mt-14 grid gap-6 md:grid-cols-3">
          {items.map((t, i) => (
            <Reveal key={t} delay={i * 100}>
              <div className="h-full rounded-2xl border border-border bg-card p-7 text-center">
                <p className="text-3xl font-extrabold text-primary/25">{i + 1}</p>
                <p className="mt-2 text-base font-semibold text-foreground">
                  {i + 1}. {t}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Faq() {
  return (
    <section id="常見問題" className="scroll-mt-20 bg-surface py-20 sm:py-28">
      <div className="mx-auto max-w-3xl px-5">
        <SectionHeading eyebrow="FAQ" title="常見問題" />
        <Reveal className="mt-12">
          <Accordion type="single" collapsible className="w-full">
            {faqs.map((f, i) => (
              <AccordionItem key={f.q} value={`item-${i}`}>
                <AccordionTrigger className="text-left text-base font-semibold text-foreground">
                  {f.q}
                </AccordionTrigger>
                <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
                  {f.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </Reveal>
      </div>
    </section>
  );
}

function Contact() {
  const [industry, setIndustry] = useState("");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    toast.success("已收到您的需求", { description: "這是示意表單，正式版會將內容寄送給我們。" });
  }

  return (
    <section className="py-20 sm:py-28">
      <div className="mx-auto max-w-5xl px-5">
        <SectionHeading
          eyebrow="Contact"
          title="想了解更多？"
          subtitle="留下需求，我們會盡快與您聯繫並安排導入說明。"
        />

        <Reveal className="mt-10">
          <div className="mx-auto flex max-w-xl flex-col gap-3 sm:flex-row sm:justify-center">
            <span className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card px-5 py-3 text-sm font-medium text-foreground">
              <MessageCircle className="size-4 text-cta" /> LINE 官方帳號：line@example
            </span>
            <span className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card px-5 py-3 text-sm font-medium text-foreground">
              <Mail className="size-4 text-primary" /> hello@miaoyue.app
            </span>
          </div>
        </Reveal>

        <Reveal delay={100} className="mt-10">
          <form
            onSubmit={onSubmit}
            className="mx-auto grid max-w-2xl gap-5 rounded-2xl border border-border bg-card p-7 sm:grid-cols-2"
          >
            <div className="sm:col-span-2">
              <Label htmlFor="industry">產業類型</Label>
              <Select value={industry} onValueChange={setIndustry}>
                <SelectTrigger id="industry" className="mt-2 w-full">
                  <SelectValue placeholder="請選擇" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="in-store">到店服務</SelectItem>
                  <SelectItem value="on-site">到府派工</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="company">公司名稱</Label>
              <Input id="company" className="mt-2" placeholder="秒約美學工作室" />
            </div>
            <div>
              <Label htmlFor="branches">分店數量</Label>
              <Input id="branches" type="number" min={0} className="mt-2" placeholder="2" />
            </div>
            <div>
              <Label htmlFor="staff">師傅人數</Label>
              <Input id="staff" type="number" min={0} className="mt-2" placeholder="6" />
            </div>
            <div>
              <Label htmlFor="phone">聯絡電話</Label>
              <Input id="phone" className="mt-2" placeholder="0912-345-678" />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="line">LINE ID</Label>
              <Input id="line" className="mt-2" placeholder="@miaoyue" />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="notes">需求說明</Label>
              <Textarea
                id="notes"
                rows={4}
                className="mt-2"
                placeholder="想解決的問題、目前使用的工具⋯⋯"
              />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" variant="cta" size="lg" className="w-full">
                送出需求
              </Button>
            </div>
          </form>
        </Reveal>
      </div>
    </section>
  );
}

function Footer() {
  const cols = [
    { title: "產品", links: ["功能特色", "方案定價", "適用產業"] },
    { title: "支援", links: ["常見問題", "導入說明", "系統狀態"] },
    { title: "聯絡", links: ["LINE 官方帳號", "hello@miaoyue.app"] },
  ];
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-brand-foreground">
              秒
            </span>
            <span className="text-lg font-bold text-foreground">秒約</span>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            到店服務與到府派工的預約派工系統。
          </p>
        </div>
        {cols.map((c) => (
          <div key={c.title}>
            <h4 className="text-sm font-bold text-foreground">{c.title}</h4>
            <ul className="mt-4 space-y-3">
              {c.links.map((l) => (
                <li key={l}>
                  <a
                    href="#top"
                    className="text-sm text-muted-foreground transition-colors hover:text-primary"
                  >
                    {l}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-5 py-6 text-xs text-muted-foreground sm:flex-row">
          <p>© 2026 秒約</p>
          <div className="flex items-center gap-5">
            <Link to="/terms" className="transition-colors hover:text-primary">
              服務條款
            </Link>
            <Link to="/privacy" className="transition-colors hover:text-primary">
              隱私政策
            </Link>
            <span className="inline-flex items-center gap-1">
              <Wrench className="size-3" /> v1
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
