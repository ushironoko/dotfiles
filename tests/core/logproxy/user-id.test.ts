import { describe, it, expect } from "bun:test";
import { parseUserId, shortHash } from "../../../src/core/logproxy/user-id";

// 注意: 実 user_id は account_uuid/device_id を含むため fixture 化しない。
// ここでは構造的に同型の「合成」値のみを使う。
const SESSION = "6b1e0000-0000-4000-8000-000000000001";
const ACCOUNT = "a0c40000-0000-4000-8000-000000000002";
const PARENT = "c1de0000-0000-4000-8000-000000000003";

const b64url = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj)).toString("base64url");
const b64 = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj)).toString("base64");

describe("parseUserId — tier1: base64(JSON) 復号", () => {
  it("base64url(JSON) から session/account/parent を復号する", () => {
    const uid = b64url({
      device_id: "dev-x",
      account_uuid: ACCOUNT,
      session_id: SESSION,
      parent_session_id: PARENT,
    });
    expect(parseUserId(uid)).toEqual({
      session_id: SESSION,
      parent_session_id: PARENT,
      account_uuid: ACCOUNT,
    });
  });

  it("素の JSON 文字列（base64でない）からも復号する", () => {
    const uid = JSON.stringify({
      device_id: "d",
      account_uuid: ACCOUNT,
      session_id: SESSION,
      parent_session_id: PARENT,
    });
    expect(parseUserId(uid)).toEqual({
      session_id: SESSION,
      parent_session_id: PARENT,
      account_uuid: ACCOUNT,
    });
  });

  it("padding 付きの標準 base64 も復号する", () => {
    const uid = b64({ session_id: SESSION, account_uuid: ACCOUNT });
    expect(parseUserId(uid)).toEqual({
      session_id: SESSION,
      account_uuid: ACCOUNT,
    });
  });

  it("parent が無ければ parent_session_id は省く", () => {
    const uid = b64url({ session_id: SESSION, account_uuid: ACCOUNT });
    const parsed = parseUserId(uid);
    expect(parsed.session_id).toBe(SESSION);
    expect(parsed.parent_session_id).toBeUndefined();
  });
});

describe("parseUserId — tier2: ラベル付き文字列", () => {
  it("account/session ラベルを取り違えず抽出する", () => {
    const uid = `user_deadbeef_account_${ACCOUNT}_session_${SESSION}`;
    expect(parseUserId(uid)).toEqual({
      session_id: SESSION,
      account_uuid: ACCOUNT,
    });
  });

  it("parent_session_ を session_ と混同しない", () => {
    const uid = `user_x_account_${ACCOUNT}_parent_session_${PARENT}_session_${SESSION}`;
    expect(parseUserId(uid)).toEqual({
      session_id: SESSION,
      parent_session_id: PARENT,
      account_uuid: ACCOUNT,
    });
  });
});

describe("parseUserId — tier3: フォールバック（取り違え回避）", () => {
  it("素の UUID 単体は session とみなさず unknown + raw_user_id_hash", () => {
    const parsed = parseUserId(ACCOUNT); // ラベルも JSON でもない裸 UUID
    expect(parsed.session_id).toBe("unknown");
    expect(parsed.raw_user_id_hash).toBe(shortHash(ACCOUNT));
    expect(parsed.account_uuid).toBeUndefined();
  });

  it("空文字は unknown", () => {
    const parsed = parseUserId("");
    expect(parsed.session_id).toBe("unknown");
  });

  it("ゴミ文字列でも throw せず unknown + hash", () => {
    const parsed = parseUserId("!!!not-base64-not-labeled!!!");
    expect(parsed.session_id).toBe("unknown");
    expect(parsed.raw_user_id_hash).toBeTruthy();
  });

  it("base64 が JSON でも session_id を欠くなら採用しない", () => {
    const uid = b64url({ foo: "bar" });
    expect(parseUserId(uid).session_id).toBe("unknown");
  });
});
