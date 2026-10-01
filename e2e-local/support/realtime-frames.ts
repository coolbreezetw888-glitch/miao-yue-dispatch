// SPECS-INDEX #874 本機 e2e:把瀏覽器 WebSocket 收發的 Realtime frame 解成 { topic, event, payload }。
//
// supabase-js 2.116(realtime-js vsn 2.0.0)的兩種 frame:
//   ・文字 frame:JSON 陣列 `[join_ref, ref, topic, event, payload]`(phx_join / phx_reply / phx_leave / heartbeat …)。
//   ・二進位 frame:伺服器推給客戶端的 broadcast(kind = 4 userBroadcast),格式照抄
//     node_modules/@supabase/realtime-js/dist/main/lib/serializer.js 的 _decodeUserBroadcast。
// 解不出來的 frame 回 null(只記原文,用來做「整包原文搜不到客戶資料」的檢查)。
//
// 純函式、沒有 Playwright 依賴 ⇒ realtime-frames.test.ts 用 Vitest 鎖住。

export interface RealtimeFrame {
  topic: string;
  event: string;
  /** 文字 frame 的第 5 欄;二進位 broadcast 是 `{ type: 'broadcast', event, payload }`。 */
  payload: unknown;
  joinRef: string | null;
  ref: string | null;
}

const KIND_USER_BROADCAST = 4;
const JSON_ENCODING = 1;
const HEADER_LENGTH = 1;

function toUint8(raw: string | Uint8Array): Uint8Array | null {
  if (typeof raw === "string") return null;
  return raw;
}

/** 整個 frame 的原文(二進位 frame 用 UTF-8 解),給「原文搜字串」用。 */
export function frameText(raw: string | Uint8Array): string {
  if (typeof raw === "string") return raw;
  return new TextDecoder().decode(raw);
}

export function decodeRealtimeFrame(raw: string | Uint8Array): RealtimeFrame | null {
  const bytes = toUint8(raw);
  if (!bytes) {
    try {
      const parsed = JSON.parse(raw as string) as unknown;
      if (!Array.isArray(parsed) || parsed.length < 5) return null;
      const [joinRef, ref, topic, event, payload] = parsed as [
        string | null,
        string | null,
        string,
        string,
        unknown,
      ];
      if (typeof topic !== "string" || typeof event !== "string") return null;
      return { topic, event, payload, joinRef: joinRef ?? null, ref: ref ?? null };
    } catch {
      return null;
    }
  }
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint8(0) !== KIND_USER_BROADCAST) return null;
    const topicSize = view.getUint8(1);
    const userEventSize = view.getUint8(2);
    const metadataSize = view.getUint8(3);
    const payloadEncoding = view.getUint8(4);
    const decoder = new TextDecoder();
    let offset = HEADER_LENGTH + 4;
    const topic = decoder.decode(bytes.slice(offset, offset + topicSize));
    offset += topicSize;
    const userEvent = decoder.decode(bytes.slice(offset, offset + userEventSize));
    offset += userEventSize;
    offset += metadataSize;
    const body = bytes.slice(offset);
    const inner = payloadEncoding === JSON_ENCODING ? JSON.parse(decoder.decode(body)) : body;
    return {
      topic,
      event: "broadcast",
      payload: { type: "broadcast", event: userEvent, payload: inner },
      joinRef: null,
      ref: null,
    };
  } catch {
    return null;
  }
}

/** Realtime 在 WebSocket 上的 topic 會加 `realtime:` 前綴。 */
export function wireTopic(topic: string): string {
  return `realtime:${topic}`;
}

/** 這個 frame 是不是「對某個頻道送來的 schedule_changed broadcast」;是的話回傳內層 payload。 */
export function scheduleBroadcastPayload(frame: RealtimeFrame | null, topic: string): unknown {
  if (!frame || frame.topic !== wireTopic(topic) || frame.event !== "broadcast") return undefined;
  const envelope = frame.payload as { event?: unknown; payload?: unknown } | null;
  if (!envelope || envelope.event !== "schedule_changed") return undefined;
  return envelope.payload;
}
