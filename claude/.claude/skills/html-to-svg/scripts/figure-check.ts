#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs, stripVTControlCharacters } from "node:util";
import {
  collectFigures,
  judgeFigure,
  type Figure,
  type Finding,
} from "./figure-arrows.ts";

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    width: { type: "string", default: "760" },
    json: { type: "string" },
    "skip-vlmkit": { type: "boolean", default: false },
  },
});

const src = positionals[0] && resolve(positionals[0]);
if (!src || !(await Bun.file(src).exists())) {
  console.error(
    "usage: figure-check.ts <report.html> [--width 760] [--out dir] [--json summary.json] [--skip-vlmkit]",
  );
  process.exit(2);
}

const width = Number(opt.width);
const name = basename(src).replace(/\.html?$/, "");
const out = resolve(
  opt.out ?? join(process.env.TMPDIR ?? tmpdir(), "figure-check", name),
);
mkdirSync(out, { recursive: true });

const globalRoot = join(
  process.env.BUN_INSTALL ?? join(homedir(), ".bun"),
  "install",
  "global",
);
const { chromium } = createRequire(join(globalRoot, "package.json"))(
  "playwright",
);

interface Report {
  fail: string[];
  look: string[];
  sheets: string[];
}
const report: Report = { fail: [], look: [], sheets: [] };
const ok = (m: string) => console.log(`  ✓ ${m}`);
const ng = (m: string, fix?: string) => {
  report.fail.push(m);
  console.log(`  ✗ ${m}${fix ? `\n    → ${fix}` : ""}`);
};
const look = (m: string) => {
  report.look.push(m);
  console.log(`  △ ${m}`);
};

const FIX: Record<string, string> = {
  detached:
    "線の始点を from の箱の縁、終点を to の箱の縁に置く。data-edge の向きと線の描く向きを揃える",
  shared:
    "2 本の線の経路をずらす（別の辺から出入りさせる）か、箱の並びを変える",
  arrowhead:
    "先端の三角形を線の終点（to の箱の縁）に置き、to の方向を指す向きにする",
  through: "線を箱の外へ迂回させるか、箱の位置を変える",
  "over-label": "ラベルを線の外へ動かすか、線を迂回させる",
};

const composeSheet = async (
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  tiles: { title: string; png: Buffer; flagged: boolean }[],
  path: string,
) => {
  const page = await browser.newPage({
    viewport: { width: 1340, height: 100 },
    deviceScaleFactor: 1,
  });
  const html = tiles
    .map(
      (t) =>
        `<div style="background:#fff;padding:6px;width:420px;${t.flagged ? "outline:3px solid #d1242f" : ""}"><div>${t.title}</div><img src="data:image/png;base64,${t.png.toString("base64")}" style="width:420px;display:block"></div>`,
    )
    .join("");
  await page.setContent(
    `<body style="margin:0;padding:12px;background:#888;font:13px system-ui,'Hiragino Sans';display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start">${html}</body>`,
  );
  await page.screenshot({ path, fullPage: true });
  await page.close();
  report.sheets.push(path);
};

console.log(`figure-check ${basename(src)}`);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width, height: 900 },
  deviceScaleFactor: 2,
});
await page.goto(`file://${src}`, { waitUntil: "networkidle" });
const figures: Figure[] = await page.evaluate(collectFigures);

if (!figures.length)
  console.log(
    "  - no [data-figure] / <svg> with data-edge; arrow checks skipped",
  );

for (const f of figures) {
  const { fail, look: looks } = judgeFigure(f);
  const tag = `figure ${f.index + 1}`;
  fail.forEach((x: Finding) => ng(`${tag}: ${x.kind}: ${x.msg}`, FIX[x.kind]));
  looks.forEach((x: Finding) => look(`${tag}: ${x.kind}: ${x.msg}`));
  if (!fail.length)
    ok(
      `${tag}: ${f.edges.length} edge(s), ${f.nodes.length} node(s), no arrow failures`,
    );

  const flagged = new Set(
    [...fail, ...looks.filter((x) => x.kind !== "cross")].flatMap(
      (x) => x.edges,
    ),
  );
  const target = page.locator(`[data-figure-index="${f.index}"]`);
  const tiles: { title: string; png: Buffer; flagged: boolean }[] = [];
  for (const [i, e] of f.edges.entries()) {
    await page.evaluate((k: number) => {
      for (const el of globalThis.document.querySelectorAll<SVGElement>(
        "[data-arrow-index]",
      )) {
        const on = el.getAttribute("data-arrow-index") === String(k);
        el.style.opacity = on ? "1" : "0.15";
        for (const s of [el, ...el.querySelectorAll<SVGElement>("*")]) {
          const filled =
            globalThis.getComputedStyle(s).fill !== "none" && s.tagName !== "g";
          s.style.stroke = on && !filled ? "#d1242f" : "";
          s.style.fill = on && filled ? "#d1242f" : "";
          s.style.strokeWidth = on && !filled ? "4" : "";
        }
      }
    }, i);
    tiles.push({
      title: `${i + 1}. ${e.from} → ${e.to}${flagged.has(i) ? "（要確認）" : ""}`,
      png: await target.screenshot(),
      flagged: flagged.has(i),
    });
  }
  await page.evaluate(() =>
    globalThis.document
      .querySelectorAll("[data-arrow-index], [data-arrow-index] *")
      .forEach((el) => el.removeAttribute("style")),
  );
  if (tiles.length)
    await composeSheet(
      browser,
      tiles,
      join(out, `${name}.figure${f.index + 1}.edges.png`),
    );
}
await browser.close();

const rendered = join(out, `${name}.png`);
const satoru = spawnSync(
  "satoru-render",
  [src, "-o", rendered, "-w", String(width), "--no-jsdom"],
  { encoding: "utf8" },
);
satoru.status === 0
  ? ok(`satoru render: ${rendered}`)
  : ng(
      `satoru render failed: ${(satoru.stderr || satoru.stdout).trim().split("\n").at(-1)}`,
    );
if (satoru.status === 0) report.sheets.unshift(rendered);

const gates = [
  ["check", "integrity", `file://${src}`, "--viewports", String(width)],
  [
    "check",
    "a11y",
    "contrast",
    `file://${src}`,
    "--output-dir",
    join(out, "a11y-contrast"),
  ],
];
if (opt["skip-vlmkit"]) console.log("  - vlmkit gates skipped");
else
  for (const gate of gates) {
    const r = spawnSync("vlmkit", [...gate, "--no-ledger"], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const text = stripVTControlCharacters(`${r.stdout}${r.stderr}`);
    const verdict =
      text.match(/verdict:.*$|\d+ contrast failure.*$/m)?.[0] ??
      text.trim().split("\n").at(-1) ??
      "";
    const label = `vlmkit ${gate.slice(0, gate[1] === "a11y" ? 3 : 2).join(" ")}`;
    if (r.error)
      ng(`${label}: not runnable (${r.error.message})`, "bun install -g @mizchi/vlmkit@0.23.0");
    else if (r.status === 0) ok(`${label}: ${verdict}`);
    else
      ng(
        `${label}: ${verdict}`,
        text
          .split("\n")
          .filter((x) => /^\s*(\[|✗)/.test(x))
          .slice(0, 4)
          .join(" / "),
      );
  }

console.log("");
report.sheets.forEach((s) => console.log(`  look at: ${s}`));
if (opt.json) writeFileSync(opt.json, JSON.stringify(report, null, 2));
console.log(
  report.fail.length
    ? `figure verdict: ${report.fail.length} FAILURE(S)`
    : "figure verdict: CLEAN (now look at the sheets)",
);
process.exit(report.fail.length ? 1 : 0);
