// SPECS-INDEX #946:點數異動紀錄「同一時間寫入的多筆」先後順序要固定、而且要對。
//
// 為什麼光靠 created_at 不夠:
//   get_member_point_history 依 created_at desc 排序,但 created_at 的預設值是 now() ——
//   Postgres 的 now() 是「整個交易開始的時間」,同一個交易裡寫進去的每一筆都會是**一模一樣**的時間
//   (例:取消已完成訂單時,「退回折抵 redeem_booking_refund」和「收回入帳 earn_booking_reversal」
//   在同一支函式裡寫入)。時間相同時資料庫回傳的先後沒有保證,畫面上就會亂跳。
//
// 為什麼不直接用 id 當第二排序:
//   id 是 gen_random_uuid()(亂數),排起來雖然「固定」,但跟實際寫入先後無關,可能把後寫的排在前面,
//   餘額欄就會看起來倒著跳。
//
// 為什麼不直接用 balance_after 當第二排序:
//   balance_after 是「這筆做完後的餘額」,大小跟先後沒有關係(先 +20 再 −50,第二筆的餘額反而比較小)。
//
// 這裡的做法(不改資料庫、不改 RPC,只在前端把「同一時間」那一小撮重排):
//   每一筆紀錄都滿足「做之前的餘額 = balance_after − points_delta」(寫入函式都鎖住會員列、照這個公式寫)。
//   所以同一時間的那幾筆,可以像接龍一樣接起來:上一筆的 balance_after 必須等於下一筆「做之前的餘額」,
//   而這一撮最早那筆「做之前的餘額」必須等於「已經排好的」較舊那一撮最新一筆的 balance_after(由舊往新處理)。
//   找得到唯一接法 ⇒ 就是真實寫入順序;接法不只一種時,依 id 字典序挑第一個合法接法(仍然固定);
//   接不起來(理論上不會發生)⇒ 退回依 id 字典序,至少保證每次結果一樣。
//
// 只重排「created_at 字串完全相同、而且在陣列中相鄰」的那幾筆;不同時間的紀錄完全照資料庫給的順序,
// 不重新比較時間字串(避免時區/小數位數格式差異造成新的錯排)。

/** 只需要這四個欄位;MemberPointHistoryEntry 符合這個形狀。 */
export interface PointHistoryOrderable {
  id: string;
  pointsDelta: number;
  balanceAfter: number;
  createdAt: string;
}

/** 同一時間的筆數超過這個數就不做接龍搜尋(避免組合爆炸),直接依 id 排。實務上同一交易最多 3~4 筆。 */
const MAX_CHAIN_GROUP = 8;

function compareId(a: PointHistoryOrderable, b: PointHistoryOrderable): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 把同一時間的一撮紀錄排成「舊 → 新」。
 * @param olderBalance 緊接在這一撮之前(較舊)那一筆的 balance_after;這一撮已是最舊的就給 null。
 */
function chainOldestFirst<T extends PointHistoryOrderable>(
  group: T[],
  olderBalance: number | null,
): T[] {
  const byId = [...group].sort(compareId);
  if (group.length <= 1 || group.length > MAX_CHAIN_GROUP) return byId;

  const used = new Array<boolean>(byId.length).fill(false);
  const path: T[] = [];

  function dfs(balance: number | null): boolean {
    if (path.length === byId.length) return true;
    for (let i = 0; i < byId.length; i += 1) {
      if (used[i]) continue;
      const row = byId[i]!;
      const before = row.balanceAfter - row.pointsDelta;
      if (balance !== null && before !== balance) continue;
      used[i] = true;
      path.push(row);
      if (dfs(row.balanceAfter)) return true;
      path.pop();
      used[i] = false;
    }
    return false;
  }

  return dfs(olderBalance) ? path : byId;
}

/**
 * 輸入:資料庫回傳的順序(created_at 新 → 舊)。輸出:同樣新 → 舊,但同一時間的那幾筆依真實寫入先後
 * 固定下來(最後寫入的排最上面)。不會改動傳入的陣列。
 *
 * 🔴 QA 打回(#946 第 2 輪):一定要**由舊往新**處理。每一撮的接龍起點(錨點),要用「已經排好的、
 *    緊接在下面那一撮的最新一筆」的 balance_after。不能直接拿資料庫回傳陣列裡緊接在下面的那一筆:
 *    下面那撮如果也是同一時間多筆,它在陣列裡的先後本來就不固定,錨點會變成其中任意一筆,
 *    上面這撮就跟著接錯或接不起來(例:同一位會員先後取消兩張已完成訂單)。
 *    最舊那一撮下面沒有紀錄 ⇒ 沒有錨點,任何一筆都可以當起點。
 */
export function stabilizePointHistoryOrder<T extends PointHistoryOrderable>(
  rows: readonly T[],
): T[] {
  // 1. 切成「同一時間、相鄰」的撮(陣列本身是新 → 舊)。
  const groups: T[][] = [];
  let i = 0;
  while (i < rows.length) {
    let j = i + 1;
    while (j < rows.length && rows[j]!.createdAt === rows[i]!.createdAt) j += 1;
    groups.push(rows.slice(i, j));
    i = j;
  }

  // 2. 由最舊那撮往新處理;錨點 = 已排好的較舊那撮裡最新一筆的 balance_after。
  const orderedGroups: T[][] = new Array<T[]>(groups.length);
  let anchor: number | null = null;
  for (let g = groups.length - 1; g >= 0; g -= 1) {
    const oldestFirst: T[] = chainOldestFirst(groups[g]!, anchor);
    orderedGroups[g] = oldestFirst;
    anchor = oldestFirst[oldestFirst.length - 1]!.balanceAfter;
  }

  // 3. 組回新 → 舊。
  const result: T[] = [];
  for (const oldestFirst of orderedGroups) {
    for (let k = oldestFirst.length - 1; k >= 0; k -= 1) result.push(oldestFirst[k]!);
  }
  return result;
}
