// realtime-frames.ts 的單元測試:本機 e2e 的 E1 / E9 / E10 / E12 都靠它解 WebSocket frame,
// 解錯會讓「有收到 / 沒收到」的斷言失去意義,所以先用 Vitest 鎖住兩種格式。
import { describe, expect, it } from "vitest";

import {
  decodeRealtimeFrame,
  frameText,
  scheduleBroadcastPayload,
  wireTopic,
} from "./realtime-frames";

const TOPIC = "staff:3f2a1b8c-4d5e-6f70-8192-a3b4c5d6e7f8:schedule";

/** 照 realtime-js serializer 的 userBroadcast(kind 4)格式手工組一個二進位 frame。 */
function binaryBroadcast(topic: string, event: string, payload: unknown, meta = ""): Uint8Array {
  const enc = new TextEncoder();
  const t = enc.encode(topic);
  const e = enc.encode(event);
  const m = enc.encode(meta);
  const p = enc.encode(JSON.stringify(payload));
  const out = new Uint8Array(5 + t.length + e.length + m.length + p.length);
  out.set([4, t.length, e.length, m.length, 1], 0);
  out.set(t, 5);
  out.set(e, 5 + t.length);
  out.set(m, 5 + t.length + e.length);
  out.set(p, 5 + t.length + e.length + m.length);
  return out;
}

describe("decodeRealtimeFrame", () => {
  it("文字 frame(phx_reply)", () => {
    const raw = JSON.stringify(["1", "1", wireTopic(TOPIC), "phx_reply", { status: "ok" }]);
    expect(decodeRealtimeFrame(raw)).toEqual({
      topic: `realtime:${TOPIC}`,
      event: "phx_reply",
      payload: { status: "ok" },
      joinRef: "1",
      ref: "1",
    });
  });

  it("二進位 broadcast(kind 4)", () => {
    const payload = { v: 1, reason: "schedule_changed", id: "x" };
    const frame = decodeRealtimeFrame(
      binaryBroadcast(wireTopic(TOPIC), "schedule_changed", payload, '{"a":1}'),
    );
    expect(frame?.event).toBe("broadcast");
    expect(scheduleBroadcastPayload(frame, TOPIC)).toEqual(payload);
    expect(scheduleBroadcastPayload(frame, "staff:other:schedule")).toBeUndefined();
  });

  it("解不出來的回 null", () => {
    expect(decodeRealtimeFrame("not json")).toBeNull();
    expect(decodeRealtimeFrame(JSON.stringify({ a: 1 }))).toBeNull();
    expect(decodeRealtimeFrame(new Uint8Array([9, 0, 0]))).toBeNull();
  });

  it("frameText:二進位 frame 用 UTF-8 解,中文字串搜得到", () => {
    const bin = binaryBroadcast(wireTopic(TOPIC), "x", { name: "王小明" });
    expect(frameText(bin)).toContain("王小明");
    expect(frameText("abc")).toBe("abc");
  });
});
