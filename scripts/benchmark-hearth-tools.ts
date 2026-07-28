import {
  createGrepToolDefinition,
  createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { HearthEngine, type GrepMode, type ShellSpec } from "@hearthdev/napi";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
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
  dataset: Workload["name"];
  tool: "read" | "grep";
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
  workload: Workload,
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
    dataset: workload.name,
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
      workload,
      "read",
      "end-to-end",
      builtinReadOperation,
      hearthReadOperation,
      options.warmupIterations,
      options.readIterations,
    ),
    await compare(
      workload,
      "read",
      "raw",
      rawFsReadOperation,
      rawHearthReadOperation,
      options.warmupIterations,
      options.readIterations,
    ),
    await compare(
      workload,
      "grep",
      "end-to-end",
      builtinGrepOperation,
      hearthGrepOperation,
      options.warmupIterations,
      options.grepIterations,
    ),
    await compare(
      workload,
      "grep",
      "raw",
      rawRgOperation,
      rawHearthGrepOperation,
      options.warmupIterations,
      options.grepIterations,
    ),
  ];
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
      `Warm-up: ${options.warmupIterations}; read iterations: ${options.readIterations}; grep iterations: ${options.grepIterations}; trustCache: true\n`,
    );
    printTable(comparisons);
    console.log(
      "\nMedian speedup is baseline median / Hearth median. Setup, corpus generation, and equivalence checks are outside timed regions.",
    );
  } finally {
    await rm(synthetic.root, { recursive: true, force: true });
  }
};

await main();
