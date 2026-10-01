// SPECS-INDEX #874 服務人員端即時同步 —— 批次 2(#890 / #891 / #892 / #893 v1.1)的本機 Realtime 實測腳本。
//
// =========================================================================
// 為什麼要有這支(pgTAP 測不到的那一段)
// =========================================================================
//   pgTAP 只能證明「政策運算式算出來是對的」。但真正擋人的是 **Realtime 伺服器**:它在服務人員加入頻道時,
//   以那個人的 JWT 身分去查 realtime.messages 的 RLS 政策,查不到就回 CHANNEL_ERROR。如果本機的
//   Realtime 根本不檢查政策(例如設定成公開),pgTAP 全綠也沒有意義。
//   ⇒ 這支腳本用**真的 supabase-js + 真的 WebSocket** 連本機 Realtime,實際試:
//      自己的頻道能不能加入、別人的頻道會不會被拒、資料庫發的訊號收不收得到、能不能偽造訊號給別人。
//
// =========================================================================
// 只連本機(絕對不會打正式庫)
// =========================================================================
//   網址與金鑰一律取自 `npx supabase status -o env`(本機 Docker 的示範金鑰),不讀 `.env`;
//   網址主機不是 127.0.0.1 / localhost、或含 supabase.co ⇒ 直接中止。
//   建資料用 `docker exec supabase_db_<project_id> psql`(本機容器),最後全部刪掉(只刪本次亂數產生的 id)。
//
// 用法(在 秒約/ 底下,先 `npx supabase start`):
//     node scripts/req874-realtime-authz-probe.mjs                 # 預期批次 2 migration 已套用(預設)
//     node scripts/req874-realtime-authz-probe.mjs --expect=nopolicy # 預期還沒有任何 SELECT 政策(全部被拒)
//   任何一項跟預期不同 ⇒ 結束碼 1。
//
// 用語:一律「服務人員」。
// =========================================================================

import { execFileSync, execSync } from "node:child_process";
import { randomUUID, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const EXPECT = (process.argv.find((a) => a.startsWith("--expect=")) ?? "--expect=policy").slice(9);
if (!["policy", "nopolicy"].includes(EXPECT))
  throw new Error(`--expect 只能是 policy 或 nopolicy(收到 ${EXPECT})`);

// ---------- 本機目標 ----------
function readLocalTarget() {
  const out = execSync("npx supabase status -o env", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const env = {};
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
    if (m) env[m[1]] = m[2];
  }
  const url = env.API_URL;
  if (!url || /supabase\.co/i.test(url)) throw new Error(`[probe] 目標網址不是本機(${url})⇒ 中止`);
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host))
    throw new Error(`[probe] 目標主機 ${host} 不是本機 ⇒ 中止`);
  const anonKey = env.PUBLISHABLE_KEY || env.ANON_KEY;
  const serviceKey = env.SERVICE_ROLE_KEY;
  if (!anonKey || !serviceKey) throw new Error("[probe] 拿不到本機金鑰,先 npx supabase start");
  return { url, anonKey, serviceKey };
}

const projectId = readFileSync("supabase/config.toml", "utf8").match(
  /^project_id\s*=\s*"([^"]+)"/m,
)?.[1];
if (!projectId) throw new Error("[probe] 讀不到 supabase/config.toml 的 project_id");
const DB_CONTAINER = `supabase_db_${projectId}`;

function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-At"],
    {
      input: sql,
      encoding: "utf8",
    },
  ).trim();
}

const { url, anonKey, serviceKey } = readLocalTarget();
const svc = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------- 小工具 ----------
const topicOf = (staffId) => `staff:${staffId}:schedule`;
const phone = () => `09${String(randomInt(0, 1e8)).padStart(8, "0")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PASSWORD = `Probe-${randomUUID()}`;

async function newUser(label) {
  const email = `req874-probe-${label}-${randomUUID().slice(0, 8)}@test.local`;
  const { data, error } = await svc.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(`建使用者 ${label} 失敗:${error.message}`);
  return { id: data.user.id, email };
}

async function signedInClient(email) {
  const c = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  if (email) {
    const { data, error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
    if (error) throw new Error(`登入 ${email} 失敗:${error.message}`);
    c.__token = data.session.access_token;
  }
  return c;
}

/** 以 client 身分加入私有頻道,回傳最終狀態(SUBSCRIBED / CHANNEL_ERROR / TIMED_OUT / CLOSED / TIMEOUT)與收到的訊號。 */
function join(client, topic, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const received = [];
    const ch = client.channel(topic, { config: { private: true } });
    ch.on("broadcast", { event: "schedule_changed" }, (m) => received.push(m));
    let done = false;
    const finish = (status, err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status, err: err?.message, channel: ch, received });
    };
    const timer = setTimeout(() => finish("TIMEOUT"), timeoutMs);
    ch.subscribe((status, err) => {
      if (["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status))
        finish(status, err);
    });
  });
}

const results = [];
function check(label, actual, expected, detail) {
  const pass = actual === expected;
  results.push({ label, actual, expected, pass });
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${label}  → 實際 ${actual}${pass ? "" : `(預期 ${expected})`}${detail ? `  [${detail}]` : ""}`,
  );
}

// ---------- Fixture ----------
const ids = {
  group1: randomUUID(),
  group2: randomUUID(),
  m1: randomUUID(),
  m2: randomUUID(),
  sA: randomUUID(),
  sB: randomUUID(),
  sE: randomUUID(),
};
const users = {};
let clients = [];

async function setup() {
  users.A = await newUser("staff-a");
  users.B = await newUser("staff-b");
  users.E = await newUser("staff-other-store");
  users.C = await newUser("plain-user");
  users.D = await newUser("merchant-admin");
  psql(`
    insert into groups (id) values ('${ids.group1}'), ('${ids.group2}');
    insert into merchants (id, group_id, name, industry_type) values
      ('${ids.m1}', '${ids.group1}', 'req874 probe 一店', 'in_store_beauty'),
      ('${ids.m2}', '${ids.group2}', 'req874 probe 別家店', 'in_store_beauty');
    insert into merchant_admins (merchant_id, user_id, display_name) values ('${ids.m1}', '${users.D.id}', 'probe 管理員');
    insert into merchant_staff (id, merchant_id, user_id, name, status, login_status, phone, no_time_slot_limit) values
      ('${ids.sA}', '${ids.m1}', '${users.A.id}', 'probe 服務人員A', 'active', 'active', '${phone()}', true),
      ('${ids.sB}', '${ids.m1}', '${users.B.id}', 'probe 服務人員B', 'active', 'active', '${phone()}', true),
      ('${ids.sE}', '${ids.m2}', '${users.E.id}', 'probe 別家服務人員', 'active', 'active', '${phone()}', true);
    select seed_default_staff_permissions(s) from unnest(array['${ids.sA}', '${ids.sB}', '${ids.sE}']::uuid[]) s;
  `);
}

async function teardown() {
  for (const c of clients) {
    try {
      await c.removeAllChannels();
    } catch {
      /* 已斷線 */
    }
  }
  try {
    psql(`
      delete from merchants where id in ('${ids.m1}', '${ids.m2}');
      delete from groups where id in ('${ids.group1}', '${ids.group2}');
      delete from realtime.messages where topic in ('${topicOf(ids.sA)}', '${topicOf(ids.sB)}', '${topicOf(ids.sE)}');
    `);
  } catch (e) {
    console.warn(`[probe] 清 fixture 失敗(本機資料,可 db reset):${e.message}`);
  }
  for (const u of Object.values(users)) {
    const { error } = await svc.auth.admin.deleteUser(u.id);
    if (error) console.warn(`[probe] 刪使用者 ${u.email} 失敗:${error.message}`);
  }
}

async function freshClient(email) {
  const c = await signedInClient(email);
  clients.push(c);
  return c;
}

/** 以資料庫(postgres,跟 trigger 同一條路)發一則訊號到某個頻道。 */
function dbSend(staffId) {
  psql(
    `select realtime.send(jsonb_build_object('v', 1, 'reason', 'schedule_changed'), 'schedule_changed', '${topicOf(staffId)}', true);`,
  );
}

// ---------- 主流程 ----------
async function main() {
  console.log(`[probe] 目標 ${url}(本機),預期模式:${EXPECT}`);
  await setup();
  const ok = EXPECT === "policy" ? "SUBSCRIBED" : "CHANNEL_ERROR";

  // R1 服務人員 A 加入自己的頻道
  const ca1 = await freshClient(users.A.email);
  const a1 = await join(ca1, topicOf(ids.sA));
  check("R1 服務人員 A 加入自己的頻道", a1.status, ok, a1.err);

  // R2 A 改 id 去訂同店服務人員 B 的頻道
  const r2 = await join(await freshClient(users.A.email), topicOf(ids.sB));
  check("R2 服務人員 A 訂同店 B 的頻道", r2.status, "CHANNEL_ERROR", r2.err);
  // R3 A 訂別家店服務人員的頻道
  check(
    "R3 服務人員 A 訂別家店服務人員的頻道",
    (await join(await freshClient(users.A.email), topicOf(ids.sE))).status,
    "CHANNEL_ERROR",
  );
  // R4 一般登入者(沒有任何服務人員身分,例如客戶)訂 A 的頻道
  check(
    "R4 一般登入者(非服務人員)訂 A 的頻道",
    (await join(await freshClient(users.C.email), topicOf(ids.sA))).status,
    "CHANNEL_ERROR",
  );
  // R5 該店商家管理員訂 A 的頻道(管理員不需要這條鈴聲)
  check(
    "R5 同店商家管理員訂 A 的頻道",
    (await join(await freshClient(users.D.email), topicOf(ids.sA))).status,
    "CHANNEL_ERROR",
  );
  // R6 未登入(只有 publishable key)訂 A 的頻道
  check(
    "R6 未登入者訂 A 的頻道",
    (await join(await freshClient(null), topicOf(ids.sA))).status,
    "CHANNEL_ERROR",
  );
  // R7 亂打的頻道名
  check(
    "R7 A 訂形狀不對的頻道 staff:not-a-uuid:schedule",
    (await join(await freshClient(users.A.email), "staff:not-a-uuid:schedule")).status,
    "CHANNEL_ERROR",
  );
  // R8 A 用大寫 UUID 訂自己的頻道:#890 只認小寫(資料庫與前端都只產生小寫),大寫是一個永遠沒訊號的頻道 ⇒ 拒絕
  const upper = await join(
    await freshClient(users.A.email),
    `staff:${ids.sA.toUpperCase()}:schedule`,
  );
  check("R8 A 用大寫 UUID 的頻道名訂自己的頻道(只認小寫)", upper.status, "CHANNEL_ERROR");

  if (EXPECT === "policy") {
    // R9 資料庫發的訊號:A 收得到;B 自己的頻道收不到 A 的訊號
    const b1 = await join(await freshClient(users.B.email), topicOf(ids.sB));
    check("R9 前提:B 加入自己的頻道", b1.status, "SUBSCRIBED");
    dbSend(ids.sA);
    await sleep(3000);
    check("R9 資料庫(postgres)對 A 的頻道發 1 則 → A 收到 1 則", a1.received.length, 1);
    check("R9 對照:B 沒收到 A 的訊號", b1.received.length, 0);
    check(
      "R9 收到的 payload 只有 {id, reason, v}",
      a1.received[0] ? Object.keys(a1.received[0].payload).sort().join(",") : "(沒收到)",
      "id,reason,v",
    );

    // R10 偽造:A 用 WebSocket 在自己已加入的頻道 send(沒有 INSERT 政策 ⇒ 另一個 A 分頁收不到)
    const a2 = await join(await freshClient(users.A.email), topicOf(ids.sA));
    check("R10 前提:A 的第二個分頁也加入自己的頻道", a2.status, "SUBSCRIBED");
    const wsSend = await a1.channel.send({
      type: "broadcast",
      event: "schedule_changed",
      payload: { forged: "ws" },
    });
    await sleep(3000);
    check(
      `R10 🔴 #892 A 透過 WebSocket 發訊號(回傳 ${wsSend})→ A 的另一個分頁收到 0 則`,
      a2.received.length,
      0,
    );

    // R11 偽造:A 用 HTTP 廣播 API 對 B 的私有頻道發(不需要先加入頻道的那條路)
    const before = b1.received.length;
    const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${ca1.__token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          {
            topic: topicOf(ids.sB),
            event: "schedule_changed",
            payload: { forged: "http" },
            private: true,
          },
        ],
      }),
    });
    await sleep(3000);
    check(
      `R11 🔴 #892 A 透過 HTTP 廣播 API 對 B 的私有頻道發(HTTP ${res.status})→ B 收到 0 則`,
      b1.received.length - before,
      0,
    );

    // R12 行事曆檢視關掉 → 重新加入被拒;打開 → 又可以
    psql(
      `update merchant_staff_permissions set granted = false where staff_id = '${ids.sA}' and section_key = 'staff_calendar_view';`,
    );
    check(
      "R12 A 的行事曆檢視被關掉 → 重新加入自己的頻道",
      (await join(await freshClient(users.A.email), topicOf(ids.sA))).status,
      "CHANNEL_ERROR",
    );
    psql(
      `update merchant_staff_permissions set granted = true where staff_id = '${ids.sA}' and section_key = 'staff_calendar_view';`,
    );
    check(
      "R12 對照:打開後重新加入",
      (await join(await freshClient(users.A.email), topicOf(ids.sA))).status,
      "SUBSCRIBED",
    );

    // R13 被停用(status = removed)→ 被拒
    psql(`update merchant_staff set status = 'removed' where id = '${ids.sA}';`);
    check(
      "R13 A 被停用(status = removed)→ 加入自己的頻道",
      (await join(await freshClient(users.A.email), topicOf(ids.sA))).status,
      "CHANNEL_ERROR",
    );
    psql(`update merchant_staff set status = 'active' where id = '${ids.sA}';`);

    // R14 尚未完成登入(login_status = invited)→ 被拒
    psql(`update merchant_staff set login_status = 'invited' where id = '${ids.sA}';`);
    check(
      "R14 A 的 login_status = invited → 加入自己的頻道",
      (await join(await freshClient(users.A.email), topicOf(ids.sA))).status,
      "CHANNEL_ERROR",
    );
    psql(`update merchant_staff set login_status = 'active' where id = '${ids.sA}';`);
  }
}

try {
  await main();
} catch (e) {
  console.error(`[probe] 中途出錯:${e.stack ?? e}`);
  results.push({ label: "腳本執行", pass: false });
} finally {
  await teardown();
}
const failed = results.filter((r) => !r.pass);
console.log(
  `\n[probe] ${results.length - failed.length}/${results.length} 符合預期(模式 ${EXPECT})`,
);
process.exit(failed.length ? 1 : 0);
