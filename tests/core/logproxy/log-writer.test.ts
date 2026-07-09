import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createLogWriter } from "../../../src/core/logproxy/log-writer";
import type {
  RequestRecord,
  ResponseRecord,
} from "../../../src/core/logproxy/types";
import { setupTestDirectory, cleanupTestDirectory } from "../../test-helpers";

let root: string;
let baseDir: string;

beforeEach(async () => {
  root = await setupTestDirectory("logproxy-writer");
  baseDir = join(root, "logs");
});
afterEach(async () => {
  await cleanupTestDirectory(root);
});

const mkReq = (
  session_id: string,
  extra?: Partial<RequestRecord>,
): RequestRecord => ({
  kind: "request",
  record_id: crypto.randomUUID(),
  ts: new Date().toISOString(),
  session_id,
  endpoint: "/v1/messages",
  body_sha256: "sha",
  params: {},
  stats: { num_tools: 0, num_messages: 0, system_chars: 0, approx_bytes: 0 },
  ...extra,
});

const readLines = async (sid: string): Promise<unknown[]> => {
  const content = await fs.readFile(join(baseDir, `${sid}.jsonl`), "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
};

describe("createLogWriter — 基本", () => {
  it("dir は 0700・file は 0600 で作られる", async () => {
    const w = createLogWriter({ baseDir });
    await w.writeRequest(mkReq("s1"));
    await w.close();
    const dstat = await fs.stat(baseDir);
    const fstat = await fs.stat(join(baseDir, "s1.jsonl"));
    expect(dstat.mode & 0o777).toBe(0o700);
    expect(fstat.mode & 0o777).toBe(0o600);
  });

  it("1レコードが有効な JSONL 1行として残る", async () => {
    const w = createLogWriter({ baseDir });
    const rec = mkReq("s1", { model: "claude-opus-4-8" });
    await w.writeRequest(rec);
    await w.close();
    const lines = (await readLines("s1")) as RequestRecord[];
    expect(lines.length).toBe(1);
    expect(lines[0].record_id).toBe(rec.record_id);
    expect(lines[0].model).toBe("claude-opus-4-8");
  });

  it("セッションごとに別ファイルへ分離される", async () => {
    const w = createLogWriter({ baseDir });
    await w.writeRequest(mkReq("s1"));
    await w.writeRequest(mkReq("s2"));
    await w.close();
    expect((await readLines("s1")).length).toBe(1);
    expect((await readLines("s2")).length).toBe(1);
  });

  it("request と response が record_id で相関できる", async () => {
    const w = createLogWriter({ baseDir });
    const req = mkReq("s1");
    const res: ResponseRecord = {
      kind: "response",
      record_id: req.record_id,
      ts: new Date().toISOString(),
      session_id: "s1",
      endpoint: "/v1/messages",
      status: 200,
      duration_ms: 5,
      aborted: false,
      stream: true,
      usage: { input_tokens: 1, output_tokens: 2 },
      stop_reason: "end_turn",
    };
    await w.writeRequest(req);
    await w.writeResponse(res);
    await w.close();
    const lines = (await readLines("s1")) as (RequestRecord | ResponseRecord)[];
    expect(lines.length).toBe(2);
    expect(lines[0].record_id).toBe(lines[1].record_id);
  });
});

describe("createLogWriter — 並行/堅牢性", () => {
  it("同一セッションへ multi-MB を並行書き込みしても混線せず行数=N", async () => {
    const w = createLogWriter({ baseDir });
    const N = 12;
    const big = "x".repeat(1_000_000); // ~1MB
    const ps = Array.from({ length: N }, (_, i) =>
      w.writeRequest(
        mkReq("s1", { messages: [{ role: "user", content: big + i }] }),
      ),
    );
    await Promise.all(ps);
    await w.close();
    const lines = await readLines("s1"); // 全行が JSON.parse 可能＝混線なし
    expect(lines.length).toBe(N);
  });

  it("複数セッション並行でもクロス混線しない", async () => {
    const w = createLogWriter({ baseDir });
    await Promise.all([
      ...Array.from({ length: 5 }, () => w.writeRequest(mkReq("a"))),
      ...Array.from({ length: 7 }, () => w.writeRequest(mkReq("b"))),
    ]);
    await w.close();
    expect((await readLines("a")).length).toBe(5);
    expect((await readLines("b")).length).toBe(7);
  });

  it("書込不能ディレクトリでも throw せず（fail-open）", async () => {
    const ro = join(root, "ro");
    await fs.mkdir(ro);
    await fs.chmod(ro, 0o500); // 所有者も配下に作成不可
    const w = createLogWriter({ baseDir: join(ro, "logs") });
    await expect(w.writeRequest(mkReq("s1"))).resolves.toBeUndefined();
    await w.close();
    await fs.chmod(ro, 0o700); // cleanup 可能に
  });

  it("bounded queue: 上限超過分は drop してカウントする", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // 書込を止めるインジェクション（disk hang を模擬）
    const w = createLogWriter({
      baseDir,
      maxQueue: 3,
      writeLine: async () => {
        await gate;
      },
    });
    const ps = Array.from({ length: 10 }, () => w.writeRequest(mkReq("s1")));
    // 3件は enqueue、7件は drop されるはず
    expect(w.droppedCount()).toBe(7);
    release();
    await Promise.all(ps);
    await w.close();
  });
});
