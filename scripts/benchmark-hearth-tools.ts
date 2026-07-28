import {
  createGrepToolDefinition,
  createReadToolDefinition,
  generateDiffString,
  generateUnifiedPatch,
} from "@earendil-works/pi-coding-agent";
import {
  HearthEngine,
  type GrepMode,
  type ShellSpec,
  type WriteMode,
} from "@hearthdev/napi";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  createHearthEditDefinition,
  createHearthGrepDefinition,
  createHearthReadDefinition,
} from "../pi/extensions/hearth-tools/adapters";
import {
  HearthEngineGate,
  type PiToolSettings,
} from "../pi/extensions/hearth-tools/engine";

const DEFAULT_WARMUP_ITERATIONS = 8;
const DEFAULT_READ_ITERATIONS = 200;
const DEFAULT_GREP_ITERATIONS = 30;
const DEFAULT_EDIT_ITERATIONS = 60;
const DEFAULT_SYNTHETIC_FILES = 512;
const DEFAULT_SYNTHETIC_FILE_BYTES = 16 * 1024;
const SYNTHETIC_READ_BYTES = 8 * 1024 * 1024;
const RAW_GREP_MATCH_LIMIT = 100_000;
const EQUIVALENCE_DIAGNOSTIC_CHARACTERS = 1_000;
const SYNTHETIC_NEEDLE = "HEARTH_BENCHMARK_NEEDLE";
const SYNTHETIC_MATCH_EVERY_FILES = 8;
const MILLISECONDS_PER_NANOSECOND = 1 / 1_000_000;
const TOOL_CONTEXT = { model: undefined } as never;

interface BenchmarkOptions {
  warmupIterations: number;
  readIterations: number;
  grepIterations: number;
  editIterations: number;
  syntheticFiles: number;
  syntheticFileBytes: number;
  json: boolean;
}

interface Workload {
  name: "repository" | "synthetic";
  cwd: string;
  readPath: string;
  grepPath: string;
  grepPattern: string;
  grepGlob: string;
}

interface SampleStats {
  iterations: number;
  medianMs: number;
  meanMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

interface Comparison {
  dataset: string;
  tool: "read" | "grep" | "edit";
  layer: "end-to-end" | "raw";
  baseline: SampleStats;
  hearth: SampleStats;
  medianSpeedup: number;
}

interface ToolResultLike {
  content?: unknown;
  details?: unknown;
}

let benchmarkSink = 0;

const shell: ShellSpec = {
  program: "/bin/bash",
  args: ["-c"],
  transport: "arg" as ShellSpec["transport"],
};

const settings: PiToolSettings = {
  imageAutoResize: false,
  shell,
};

const usage = (): string => `Usage: bun run benchmark:hearth-tools -- [options]

Options:
  --warmup <n>               Warm-up calls per implementation (default: ${DEFAULT_WARMUP_ITERATIONS})
  --read-iterations <n>       Timed read calls per implementation (default: ${DEFAULT_READ_ITERATIONS})
  --grep-iterations <n>       Timed grep calls per implementation (default: ${DEFAULT_GREP_ITERATIONS})
  --edit-iterations <n>       Timed edit round trips per implementation (default: ${DEFAULT_EDIT_ITERATIONS})
  --synthetic-files <n>       Synthetic grep corpus file count (default: ${DEFAULT_SYNTHETIC_FILES})
  --synthetic-file-bytes <n>  Approximate bytes per synthetic grep file (default: ${DEFAULT_SYNTHETIC_FILE_BYTES})
  --json                     Emit machine-readable JSON only
  --help                     Show this help
`;

const positiveInteger = (value: string | undefined, option: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
};

const parseOptions = (argv: string[]): BenchmarkOptions => {
  const options: BenchmarkOptions = {
    warmupIterations: DEFAULT_WARMUP_ITERATIONS,
    readIterations: DEFAULT_READ_ITERATIONS,
    grepIterations: DEFAULT_GREP_ITERATIONS,
    editIterations: DEFAULT_EDIT_ITERATIONS,
    syntheticFiles: DEFAULT_SYNTHETIC_FILES,
    syntheticFileBytes: DEFAULT_SYNTHETIC_FILE_BYTES,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    const value = argv[index + 1];
    switch (argument) {
      case "--warmup": {
        options.warmupIterations = positiveInteger(value, argument);
        break;
      }
      case "--read-iterations": {
        options.readIterations = positiveInteger(value, argument);
        break;
      }
      case "--grep-iterations": {
        options.grepIterations = positiveInteger(value, argument);
        break;
      }
      case "--edit-iterations": {
        options.editIterations = positiveInteger(value, argument);
        break;
      }
      case "--synthetic-files": {
        options.syntheticFiles = positiveInteger(value, argument);
        break;
      }
      case "--synthetic-file-bytes": {
        options.syntheticFileBytes = positiveInteger(value, argument);
        break;
      }
      default: {
        throw new Error(`Unknown option: ${argument ?? "(missing)"}`);
      }
    }
    index += 1;
  }
  return options;
};

const consume = (value: unknown): void => {
  if (Buffer.isBuffer(value)) {
    benchmarkSink ^= value.length;
    return;
  }
  if (typeof value === "number") {
    benchmarkSink ^= value;
    return;
  }
  benchmarkSink ^= JSON.stringify(value).length;
};

const percentile = (sorted: number[], fraction: number): number => {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index] ?? 0;
};

const summarize = (samples: number[]): SampleStats => {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  return {
    iterations: sorted.length,
    medianMs: median,
    meanMs: sorted.reduce((total, value) => total + value, 0) / sorted.length,
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
  };
};

const measure = async (operation: () => Promise<unknown>): Promise<number> => {
  const started = Bun.nanoseconds();
  const value = await operation();
  const elapsed = (Bun.nanoseconds() - started) * MILLISECONDS_PER_NANOSECOND;
  consume(value);
  return elapsed;
};

const compare = async (
  dataset: string,
  tool: Comparison["tool"],
  layer: Comparison["layer"],
  baselineOperation: () => Promise<unknown>,
  hearthOperation: () => Promise<unknown>,
  warmupIterations: number,
  iterations: number,
): Promise<Comparison> => {
  for (let index = 0; index < warmupIterations; index += 1) {
    consume(await baselineOperation());
    consume(await hearthOperation());
  }

  const baselineSamples: number[] = [];
  const hearthSamples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    if (index % 2 === 0) {
      baselineSamples.push(await measure(baselineOperation));
      hearthSamples.push(await measure(hearthOperation));
    } else {
      hearthSamples.push(await measure(hearthOperation));
      baselineSamples.push(await measure(baselineOperation));
    }
  }
  const baseline = summarize(baselineSamples);
  const hearth = summarize(hearthSamples);
  return {
    dataset,
    tool,
    layer,
    baseline,
    hearth,
    medianSpeedup: baseline.medianMs / hearth.medianMs,
  };
};

const canonicalizeGrepResult = (result: ToolResultLike): ToolResultLike => ({
  ...result,
  content: Array.isArray(result.content)
    ? result.content.map((block) => {
        if (
          block === null ||
          typeof block !== "object" ||
          !("type" in block) ||
          block.type !== "text" ||
          !("text" in block) ||
          typeof block.text !== "string"
        ) {
          return block;
        }
        return {
          ...block,
          text: block.text.split("\n").sort().join("\n"),
        };
      })
    : result.content,
});

const assertEquivalent = (
  label: string,
  baseline: unknown,
  hearth: unknown,
): void => {
  const baselineJson = JSON.stringify(baseline);
  const hearthJson = JSON.stringify(hearth);
  if (baselineJson !== hearthJson) {
    throw new Error(
      `${label} output mismatch between baseline and Hearth\nbaseline=${baselineJson.slice(0, EQUIVALENCE_DIAGNOSTIC_CHARACTERS)}\nhearth=${hearthJson.slice(0, EQUIVALENCE_DIAGNOSTIC_CHARACTERS)}`,
    );
  }
};

const createEngine = (cwd: string): HearthEngine =>
  new HearthEngine({
    cwd,
    trustCache: true,
    warmShell: false,
    enableOptimizer: true,
    shell,
  });

const rawRipgrep = async (rg: string, workload: Workload): Promise<number> => {
  const process = Bun.spawn(
    [
      rg,
      "--json",
      "--line-number",
      "--color=never",
      "--hidden",
      "--glob",
      workload.grepGlob,
      "--",
      workload.grepPattern,
      workload.grepPath,
    ],
    {
      cwd: workload.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(`rg exited ${exitCode}: ${stderr.trim()}`);
  }
  let matches = 0;
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const event = JSON.parse(line) as { type?: unknown };
    if (event.type === "match") matches += 1;
  }
  return matches;
};

const createSyntheticWorkload = async (
  options: BenchmarkOptions,
): Promise<{ root: string; workload: Workload }> => {
  const root = await mkdtemp(join(tmpdir(), "hearth-tools-benchmark-"));
  const corpus = join(root, "grep-corpus");
  await mkdir(corpus);

  const fillerLine = `${"0123456789abcdef".repeat(16)}\n`;
  const filler = fillerLine.repeat(
    Math.max(1, Math.ceil(options.syntheticFileBytes / fillerLine.length)),
  );
  await Promise.all(
    Array.from({ length: options.syntheticFiles }, async (_value, index) => {
      const prefix =
        index % SYNTHETIC_MATCH_EVERY_FILES === 0
          ? `${SYNTHETIC_NEEDLE} file=${index}\n`
          : `ordinary file=${index}\n`;
      await writeFile(
        join(corpus, `file-${index.toString().padStart(4, "0")}.txt`),
        `${prefix}${filler}`,
      );
    }),
  );

  const readUnit = "abcdefghijklmnopqrstuvwxyz0123456789\n";
  const readContent = readUnit.repeat(
    Math.ceil(SYNTHETIC_READ_BYTES / readUnit.length),
  );
  await writeFile(join(root, "read-target.txt"), readContent);

  return {
    root,
    workload: {
      name: "synthetic",
      cwd: root,
      readPath: "read-target.txt",
      grepPath: "grep-corpus",
      grepPattern: SYNTHETIC_NEEDLE,
      grepGlob: "*.txt",
    },
  };
};

const benchmarkWorkload = async (
  workload: Workload,
  options: BenchmarkOptions,
  rg: string,
): Promise<Comparison[]> => {
  const engine = createEngine(workload.cwd);
  const productionGate = new HearthEngineGate();
  const builtinRead = createReadToolDefinition(workload.cwd);
  const hearthRead = createHearthReadDefinition(
    workload.cwd,
    engine,
    settings,
    productionGate,
  );
  const builtinGrep = createGrepToolDefinition(workload.cwd);
  const hearthGrep = createHearthGrepDefinition(
    workload.cwd,
    engine,
    productionGate,
  );
  const grepInput = {
    pattern: workload.grepPattern,
    path: workload.grepPath,
    glob: workload.grepGlob,
    limit: RAW_GREP_MATCH_LIMIT,
  };

  const builtinReadOperation = (): Promise<ToolResultLike> =>
    builtinRead.execute(
      `${workload.name}-builtin-read`,
      { path: workload.readPath },
      undefined,
      undefined,
      TOOL_CONTEXT,
    );
  const hearthReadOperation = (): Promise<ToolResultLike> =>
    hearthRead.execute(
      `${workload.name}-hearth-read`,
      { path: workload.readPath },
      undefined,
      undefined,
      TOOL_CONTEXT,
    );
  const builtinGrepOperation = (): Promise<ToolResultLike> =>
    builtinGrep.execute(
      `${workload.name}-builtin-grep`,
      grepInput,
      undefined,
      undefined,
      TOOL_CONTEXT,
    );
  const hearthGrepOperation = (): Promise<ToolResultLike> =>
    hearthGrep.execute(
      `${workload.name}-hearth-grep`,
      grepInput,
      undefined,
      undefined,
      TOOL_CONTEXT,
    );
  const rawFsReadOperation = (): Promise<Buffer> =>
    readFile(resolve(workload.cwd, workload.readPath));
  const rawHearthReadOperation = (): Promise<Buffer> =>
    engine.readBytesAsync({ path: workload.readPath });
  const rawRgOperation = (): Promise<number> => rawRipgrep(rg, workload);
  const rawHearthGrepOperation = async (): Promise<number> => {
    const result = await engine.grepAsync({
      pattern: workload.grepPattern,
      path: workload.grepPath,
      mode: "content" as GrepMode,
      globs: [workload.grepGlob],
      maxTotalCount: RAW_GREP_MATCH_LIMIT,
      hidden: true,
      respectGitignore: true,
    });
    return result.totalMatches;
  };

  assertEquivalent(
    `${workload.name} end-to-end read`,
    await builtinReadOperation(),
    await hearthReadOperation(),
  );
  assertEquivalent(
    `${workload.name} end-to-end grep`,
    canonicalizeGrepResult(await builtinGrepOperation()),
    canonicalizeGrepResult(await hearthGrepOperation()),
  );
  const rawBaselineBytes = await rawFsReadOperation();
  const rawHearthBytes = await rawHearthReadOperation();
  if (!rawBaselineBytes.equals(rawHearthBytes)) {
    throw new Error(`${workload.name} raw read bytes differ`);
  }
  assertEquivalent(
    `${workload.name} raw grep match count`,
    await rawRgOperation(),
    await rawHearthGrepOperation(),
  );

  return [
    await compare(
      workload.name,
      "read",
      "end-to-end",
      builtinReadOperation,
      hearthReadOperation,
      options.warmupIterations,
      options.readIterations,
    ),
    await compare(
      workload.name,
      "read",
      "raw",
      rawFsReadOperation,
      rawHearthReadOperation,
      options.warmupIterations,
      options.readIterations,
    ),
    await compare(
      workload.name,
      "grep",
      "end-to-end",
      builtinGrepOperation,
      hearthGrepOperation,
      options.warmupIterations,
      options.grepIterations,
    ),
    await compare(
      workload.name,
      "grep",
      "raw",
      rawRgOperation,
      rawHearthGrepOperation,
      options.warmupIterations,
      options.grepIterations,
    ),
  ];
};

// ---------------------------------------------------------------------------
// edit benchmark: the current pi-orchestrated adapter vs the native editBatch
// proxy — the decision gate for hearth#3's API additions. The candidate uses
// ONLY the already-published @hearthdev/napi API: `editBatchAsync` with
// `skipDiff` + `returnContent` does the matching and mutation natively, a
// cached pre-read stands in for the gated `returnOriginalContent`, and the
// persisted bytes are reconstructed from `content + hadBom + crlf`. Full
// ToolResult parity (diff, patch, firstChangedLine, message, disk bytes) with
// the baseline is enforced before anything is timed.

interface EditReplacementInput {
  oldText: string;
  newText: string;
}

interface EditFixture {
  name: string;
  fileName: string;
  seedContent: string;
  forward: EditReplacementInput[];
  /** Absent: parity-only fixture, checked for equivalence but never timed. */
  reverse?: EditReplacementInput[];
  iterations?: (options: BenchmarkOptions) => number;
}

/** pi's stripBom, verbatim (dist/core/tools/edit-diff.js). */
const stripBomLikePi = (content: string): { bom: string; text: string } =>
  content.startsWith("﻿")
    ? { bom: "﻿", text: content.slice(1) }
    : { bom: "", text: content };

/** pi's normalizeToLF, verbatim (dist/core/tools/edit-diff.js). */
const normalizeToLFLikePi = (text: string): string =>
  text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

/**
 * The persisted bytes, rebuilt from what editBatch already returns. This is
 * the exact inverse of Hearth's write path (edit.rs: BOM re-attached, LF
 * restored to CRLF only when the source was CRLF), so `returnPersistedContent`
 * would be redundant — proven per fixture below by comparing against the disk.
 */
const reconstructPersisted = (
  content: string,
  hadBom: boolean,
  crlf: boolean,
): string =>
  (hadBom ? "﻿" : "") + (crlf ? content.replace(/\n/g, "\r\n") : content);

const editSourceLine = (index: number): string =>
  `const value_${index} = compute(${index}) + "alpha beta gamma";`;

const buildEditSeed = (lines: number): string =>
  `${Array.from({ length: lines }, (_value, index) => editSourceLine(index)).join("\n")}\n`;

const buildEditPairs = (
  lines: number,
  count: number,
): { forward: EditReplacementInput[]; reverse: EditReplacementInput[] } => {
  const forward: EditReplacementInput[] = [];
  const reverse: EditReplacementInput[] = [];
  for (let index = 0; index < count; index += 1) {
    const line = Math.floor((lines * (index + 1)) / (count + 1));
    const oldText = editSourceLine(line);
    const newText = `const value_${line} = edited(${line}) + "delta";`;
    forward.push({ oldText, newText });
    reverse.push({ oldText: newText, newText: oldText });
  }
  return { forward, reverse };
};

const createEditFixtures = (): EditFixture[] => {
  const fixtures: EditFixture[] = [];
  for (const size of [
    { label: "2k", lines: 2_000 },
    { label: "20k", lines: 20_000 },
  ]) {
    for (const editCount of [1, 8]) {
      const pairs = buildEditPairs(size.lines, editCount);
      fixtures.push({
        name: `edit-${size.label}-${editCount}`,
        fileName: `edit-${size.label}-${editCount}.ts`,
        seedContent: buildEditSeed(size.lines),
        forward: pairs.forward,
        reverse: pairs.reverse,
        ...(size.lines >= 20_000
          ? {
              iterations: (options: BenchmarkOptions) =>
                Math.max(10, Math.floor(options.editIterations / 2)),
            }
          : {}),
      });
    }
  }
  // Normalized-fallback reference: the target uses straight quotes while the
  // file has smart quotes, so the forward leg matches only through the fuzzy
  // pass (pi's in JS, Hearth's faithful port of it natively).
  const fuzzyLines = buildEditSeed(2_000).split("\n");
  fuzzyLines[1_000] = "const label_1000 = “fancy quote”;";
  fixtures.push({
    name: "edit-2k-fuzzy",
    fileName: "edit-fuzzy.ts",
    seedContent: fuzzyLines.join("\n"),
    forward: [
      {
        oldText: 'const label_1000 = "fancy quote";',
        newText: 'const label_1000 = "plain";',
      },
    ],
    reverse: [
      {
        oldText: 'const label_1000 = "plain";',
        newText: "const label_1000 = “fancy quote”;",
      },
    ],
  });
  // Parity-only pi edge cases — exactly the ones hearth#3 calls out. Never
  // timed; they exist so the equivalence the gate rests on is proven where
  // reconstruction is hardest.
  fixtures.push(
    {
      name: "parity-final-line-deletion",
      fileName: "parity-final-line.txt",
      seedContent: "alpha\nbeta\ngamma\n",
      forward: [{ oldText: "\ngamma\n", newText: "\n" }],
    },
    {
      name: "parity-no-trailing-newline",
      fileName: "parity-no-newline.txt",
      seedContent: "alpha\nbeta",
      forward: [{ oldText: "beta", newText: "BETA" }],
    },
    {
      name: "parity-empty-result",
      fileName: "parity-empty.txt",
      seedContent: "only line\n",
      forward: [{ oldText: "only line\n", newText: "" }],
    },
    {
      name: "parity-crlf",
      fileName: "parity-crlf.txt",
      seedContent: "one\r\ntwo\r\nthree\r\n",
      forward: [{ oldText: "two", newText: "TWO" }],
    },
    {
      name: "parity-bom",
      fileName: "parity-bom.txt",
      seedContent: "﻿alpha\nbeta\n",
      forward: [{ oldText: "alpha", newText: "ALPHA" }],
    },
    {
      name: "parity-bom-crlf",
      fileName: "parity-bom-crlf.txt",
      seedContent: "﻿one\r\ntwo\r\n",
      forward: [{ oldText: "two", newText: "TWO" }],
    },
    {
      name: "parity-lone-cr",
      fileName: "parity-lone-cr.txt",
      seedContent: "one\rtwo\rthree\r",
      forward: [{ oldText: "two", newText: "TWO" }],
    },
  );
  return fixtures;
};

const benchmarkEdits = async (
  options: BenchmarkOptions,
): Promise<Comparison[]> => {
  const root = await mkdtemp(join(tmpdir(), "hearth-edit-benchmark-"));
  try {
    const engine = createEngine(root);
    const gate = new HearthEngineGate();
    const baselineDefinition = createHearthEditDefinition(root, engine, gate);

    let lastNative:
      | { content?: string; hadBom: boolean; crlf: boolean }
      | undefined;

    const nativeEditOnce = async (
      relativePath: string,
      edits: EditReplacementInput[],
    ): Promise<ToolResultLike> => {
      const absolutePath = resolve(root, relativePath);
      // Stand-in for the gated returnOriginalContent: a warm-cache pre-read.
      // The real API would hand this back from inside the mutation lock.
      const rawBytes = await engine.readBytesAsync({ path: absolutePath });
      const rawContent = rawBytes.toString("utf8");
      const result = await engine.editBatchAsync({
        path: absolutePath,
        edits,
        skipDiff: true,
        returnContent: true,
        mode: "inPlace" as WriteMode,
        followSymlinks: true,
      });
      lastNative = result;
      // pi always diffs normalized-original against normalized-new
      // (applyEditsToNormalizedContent returns baseContent = normalizedContent
      // even on the fuzzy path), so the canonical pair is derivable without
      // any new API surface.
      const baseContent = normalizeToLFLikePi(stripBomLikePi(rawContent).text);
      const newContent = result.content ?? "";
      const diffResult = generateDiffString(baseContent, newContent);
      const patch = generateUnifiedPatch(relativePath, baseContent, newContent);
      return {
        content: [
          {
            type: "text",
            text: `Successfully replaced ${edits.length} block(s) in ${relativePath}.`,
          },
        ],
        details: {
          diff: diffResult.diff,
          patch,
          firstChangedLine: diffResult.firstChangedLine,
        },
      };
    };

    const comparisons: Comparison[] = [];
    for (const fixture of createEditFixtures()) {
      const absolutePath = join(root, fixture.fileName);
      const seedBytes = Buffer.from(fixture.seedContent, "utf8");
      const seed = async (): Promise<void> => {
        await writeFile(absolutePath, fixture.seedContent);
        engine.invalidatePath(absolutePath);
      };
      const baselineOnce = (
        edits: EditReplacementInput[],
      ): Promise<ToolResultLike> =>
        baselineDefinition.execute(
          `edit-baseline-${fixture.name}`,
          { path: fixture.fileName, edits },
          undefined,
          undefined,
          TOOL_CONTEXT,
        );
      const candidateOnce = (
        edits: EditReplacementInput[],
      ): Promise<ToolResultLike> =>
        gate.shared(() => nativeEditOnce(fixture.fileName, edits));

      // Parity gate on the forward leg: identical ToolResult, identical disk
      // bytes, and the content+hadBom+crlf reconstruction matching the disk.
      await seed();
      const baselineResult = await baselineOnce(fixture.forward);
      const baselineBytes = await readFile(absolutePath);
      await seed();
      const candidateResult = await candidateOnce(fixture.forward);
      const candidateBytes = await readFile(absolutePath);
      assertEquivalent(
        `${fixture.name} tool result`,
        baselineResult,
        candidateResult,
      );
      if (!baselineBytes.equals(candidateBytes)) {
        throw new Error(
          `${fixture.name}: persisted bytes differ between the baseline and the native path`,
        );
      }
      const reconstructed = Buffer.from(
        reconstructPersisted(
          lastNative?.content ?? "",
          lastNative?.hadBom ?? false,
          lastNative?.crlf ?? false,
        ),
        "utf8",
      );
      if (!reconstructed.equals(candidateBytes)) {
        throw new Error(
          `${fixture.name}: content+hadBom+crlf reconstruction does not match the persisted bytes`,
        );
      }

      const { reverse } = fixture;
      if (!reverse) continue;

      // Reverse-leg parity: the A→B→A round trip must restore the seed
      // exactly, for both contenders, with equivalent ToolResults.
      await seed();
      await baselineOnce(fixture.forward);
      const baselineReverseResult = await baselineOnce(reverse);
      const baselineRestored = await readFile(absolutePath);
      await seed();
      await candidateOnce(fixture.forward);
      const candidateReverseResult = await candidateOnce(reverse);
      const candidateRestored = await readFile(absolutePath);
      assertEquivalent(
        `${fixture.name} reverse tool result`,
        baselineReverseResult,
        candidateReverseResult,
      );
      if (
        !baselineRestored.equals(seedBytes) ||
        !candidateRestored.equals(seedBytes)
      ) {
        throw new Error(
          `${fixture.name}: the A→B→A round trip did not restore the seed content`,
        );
      }

      // Timed region: each sample is one full A→B→A round trip, so state
      // resets inside the measurement and both contenders do identical work.
      // `compare` already alternates measurement order per iteration.
      await seed();
      const baselineRoundTrip = async (): Promise<unknown> => {
        const forward = await baselineOnce(fixture.forward);
        const back = await baselineOnce(reverse);
        return [forward, back];
      };
      const candidateRoundTrip = async (): Promise<unknown> => {
        const forward = await candidateOnce(fixture.forward);
        const back = await candidateOnce(reverse);
        return [forward, back];
      };
      comparisons.push(
        await compare(
          fixture.name,
          "edit",
          "end-to-end",
          baselineRoundTrip,
          candidateRoundTrip,
          options.warmupIterations,
          fixture.iterations?.(options) ?? options.editIterations,
        ),
      );
    }
    return comparisons;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const formatMs = (value: number): string => value.toFixed(3);
const formatSpeedup = (value: number): string => `${value.toFixed(2)}x`;

const printTable = (comparisons: Comparison[]): void => {
  console.log(
    "| Dataset | Tool | Layer | Baseline median | Hearth median | Speedup | Baseline mean | Hearth mean | Baseline p95 | Hearth p95 |",
  );
  console.log("|---|---|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const comparison of comparisons) {
    console.log(
      `| ${comparison.dataset} | ${comparison.tool} | ${comparison.layer} | ${formatMs(comparison.baseline.medianMs)} ms | ${formatMs(comparison.hearth.medianMs)} ms | ${formatSpeedup(comparison.medianSpeedup)} | ${formatMs(comparison.baseline.meanMs)} ms | ${formatMs(comparison.hearth.meanMs)} ms | ${formatMs(comparison.baseline.p95Ms)} ms | ${formatMs(comparison.hearth.p95Ms)} ms |`,
    );
  }
};

const main = async (): Promise<void> => {
  const options = parseOptions(process.argv.slice(2));
  const rg = Bun.which("rg");
  if (rg === null) throw new Error("rg is required for the baseline benchmark");

  const repositoryRoot = resolve(import.meta.dir, "..");
  const repositoryWorkload: Workload = {
    name: "repository",
    cwd: repositoryRoot,
    readPath: "bun.lock",
    grepPath: "pi/extensions/hearth-tools",
    grepPattern: "createHearth",
    grepGlob: "*.ts",
  };
  const synthetic = await createSyntheticWorkload(options);
  try {
    const comparisons = [
      ...(await benchmarkWorkload(repositoryWorkload, options, rg)),
      ...(await benchmarkWorkload(synthetic.workload, options, rg)),
      ...(await benchmarkEdits(options)),
    ];
    const report = {
      environment: {
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model ?? "unknown",
        bun: Bun.version,
        rg,
        trustCache: true,
      },
      options,
      comparisons,
      sink: benchmarkSink,
    };
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log("# Hearth tool benchmark\n");
    console.log(
      `Environment: ${report.environment.cpu}; ${report.environment.platform}/${report.environment.arch}; Bun ${report.environment.bun}`,
    );
    console.log(
      `Warm-up: ${options.warmupIterations}; read iterations: ${options.readIterations}; grep iterations: ${options.grepIterations}; edit round trips: ${options.editIterations}; trustCache: true\n`,
    );
    printTable(comparisons);
    console.log(
      "\nMedian speedup is baseline median / Hearth median. Setup, corpus generation, and equivalence checks are outside timed regions.",
    );
    console.log(
      "Edit rows are the hearth#3 gate: baseline = current pi-orchestrated adapter, Hearth = native editBatchAsync proxy (skipDiff + returnContent + reconstruction); each sample is one A→B→A round trip with ToolResult parity enforced beforehand.",
    );
  } finally {
    await rm(synthetic.root, { recursive: true, force: true });
  }
};

await main();
