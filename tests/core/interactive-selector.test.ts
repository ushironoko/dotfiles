import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { MultiSelectOptions } from "@clack/prompts";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confirmMappingSelection,
  selectMappings,
  type SelectionPrompts,
} from "../../src/core/interactive-selector.js";
import type { FileMapping } from "../../src/types/config.js";
import { createLogger, type Logger } from "../../src/utils/logger.js";

const promptFixture = (
  values: string[] | symbol,
  answer: boolean | symbol = true,
) => {
  const selections: MultiSelectOptions<string>[] = [];
  const confirmations: string[] = [];
  const cancellations: (string | undefined)[] = [];
  const endings: (string | undefined)[] = [];
  const prompts: SelectionPrompts = {
    intro: mock(() => {}),
    isCancel: (value): value is symbol => typeof value === "symbol",
    outro: (message) => {
      endings.push(message);
    },
    cancel: (message) => {
      cancellations.push(message);
    },
    multiselect: async (options) => {
      selections.push(options);
      return values;
    },
    confirm: async (options) => {
      confirmations.push(options.message);
      return answer;
    },
  };
  return { prompts, selections, confirmations, cancellations, endings };
};

const loggerFixture = () => {
  const messages: unknown[][] = [];
  const logger: Logger = {
    ...createLogger(),
    info: (...args: unknown[]) => {
      messages.push(args);
    },
    success: mock(() => {}),
    action: mock(() => {}),
    setVerbose: mock(() => {}),
    setDryRun: mock(() => {}),
  };
  return { logger, messages };
};

const snapshotTree = (root: string): unknown[] => {
  const entries: unknown[] = [];
  const visit = (path: string, relative: string): void => {
    const stat = lstatSync(path);
    const state = {
      relative,
      mode: stat.mode & 0o7777,
      inode: stat.ino,
      modified: stat.mtimeMs,
      changed: stat.ctimeMs,
    };
    if (stat.isSymbolicLink())
      entries.push({ ...state, link: readlinkSync(path) });
    else if (stat.isDirectory()) {
      entries.push({ ...state, directory: true });
      for (const name of readdirSync(path).sort())
        visit(join(path, name), join(relative, name));
    } else
      entries.push({
        ...state,
        bytes: readFileSync(path).toString("hex"),
      });
  };
  visit(root, ".");
  return entries;
};

describe("interactive-selector public selection", () => {
  let root: string;
  let file: FileMapping;
  let directory: FileMapping;
  let regular: FileMapping;
  let selective: FileMapping;
  let log: ReturnType<typeof loggerFixture>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dotfiles-selector-"));
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(source);
    mkdirSync(target);
    writeFileSync(join(source, "file"), "managed source\n");
    chmodSync(join(source, "file"), 0o640);
    mkdirSync(join(source, "directory"));
    writeFileSync(join(source, "directory", "config"), "directory source\n");
    file = {
      source: join(source, "file"),
      target: join(target, "file"),
      type: "file",
      permissions: "640",
      backup: false,
    };
    directory = {
      source: join(source, "directory"),
      target: join(target, "directory"),
      type: "directory",
    };
    regular = {
      source: join(source, "file"),
      target: join(target, "regular"),
      type: "file",
    };
    symlinkSync(file.source, file.target);
    symlinkSync(directory.source, directory.target);
    writeFileSync(regular.target, "user-owned regular file\n");
    chmodSync(regular.target, 0o600);
    mkdirSync(join(source, "selective", "commands"), { recursive: true });
    mkdirSync(join(target, "selective"));
    writeFileSync(
      join(source, "selective", "settings.json"),
      '{"managed":true}\n',
    );
    writeFileSync(
      join(source, "selective", "commands", "run.sh"),
      "echo fixture\n",
    );
    writeFileSync(
      join(source, "selective", "plain"),
      "unconfigured permission\n",
    );
    chmodSync(join(source, "selective", "commands", "run.sh"), 0o750);
    selective = {
      source: join(source, "selective"),
      target: join(target, "selective"),
      type: "selective",
      include: ["settings.json", "commands", "plain"],
      permissions: { "settings.json": "600", commands: "750" },
      backup: false,
    };
    symlinkSync(
      join(selective.source, "settings.json"),
      join(selective.target, "settings.json"),
    );
    symlinkSync(
      join(selective.source, "commands"),
      join(selective.target, "commands"),
    );
    writeFileSync(join(selective.target, "plain"), "existing regular child\n");
    chmodSync(join(selective.target, "plain"), 0o640);
    writeFileSync(join(selective.target, "sibling"), "unrelated sibling\n");
    mkdirSync(join(selective.target, "sibling-directory"));
    writeFileSync(
      join(selective.target, "sibling-directory", "keep"),
      "nested sibling\n",
    );
    log = loggerFixture();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const value = (mapping: FileMapping, child?: string): string =>
    child === undefined
      ? `${mapping.source}:${mapping.target}`
      : `${mapping.source}:${mapping.target}:${child}`;

  const run = async (
    mappings: FileMapping[],
    ui: ReturnType<typeof promptFixture>,
  ) => {
    const before = snapshotTree(root);
    const originalMappings = structuredClone(mappings);
    const result = await selectMappings(mappings, log.logger, ui.prompts);
    expect(snapshotTree(root)).toEqual(before);
    expect(mappings).toEqual(originalMappings);
    expect(ui.selections).toHaveLength(1);
    expect(ui.selections[0].required).toBe(false);
    return result;
  };

  it("ファイルマッピングを正しくフォーマットする", async () => {
    const ui = promptFixture([value(file)]);
    const result = await run([file], ui);
    expect(ui.selections[0].options).toEqual([
      {
        value: value(file),
        label: `[Files] ${file.target} (file)`,
        hint: undefined,
      },
    ]);
    expect(ui.selections[0].initialValues).toEqual([value(file)]);
    expect(result).toEqual({ selected: [file], deselected: [] });
    expect(ui.endings).toEqual(["1 items selected, 0 items deselected"]);
  });

  it("選択的マッピングにファイル数のヒントを追加する", async () => {
    const ui = promptFixture([
      value(selective, "settings.json"),
      value(selective, "commands"),
      value(selective, "plain"),
    ]);
    const result = await run([selective], ui);
    if (result === undefined)
      throw new Error("Selection unexpectedly cancelled");
    expect(await confirmMappingSelection(result, log.logger, ui.prompts)).toBe(
      true,
    );
    expect(log.messages).toEqual([
      ["Items to install:"],
      ["  Selective: 1"],
      [`    + ${selective.target} (3 files)`],
    ]);
    expect(ui.confirmations).toEqual(["Apply these changes?"]);
    const rejected = promptFixture([], false);
    expect(
      await confirmMappingSelection(result, log.logger, rejected.prompts),
    ).toBe(false);
    const cancelled = promptFixture([], Symbol("cancel"));
    expect(
      await confirmMappingSelection(result, log.logger, cancelled.prompts),
    ).toBe(false);
    expect(cancelled.cancellations).toEqual(["Operation cancelled"]);
  });

  it("マッピングをタイプごとにグループ化する", async () => {
    const ui = promptFixture([value(file)]);
    await run([selective, directory, regular, file], ui);
    expect(
      ui.selections[0].options.map((option) => ({
        value: option.value,
        label: option.label,
      })),
    ).toEqual([
      { value: value(regular), label: `[Files] ${regular.target} (file)` },
      { value: value(file), label: `${file.target} (file)` },
      {
        value: value(directory),
        label: `[Directories] ${directory.target} (directory)`,
      },
      {
        value: value(selective, "settings.json"),
        label: `[Selective] ${selective.target}\n  └─ settings.json`,
      },
      { value: value(selective, "commands"), label: "  └─ commands" },
      { value: value(selective, "plain"), label: "  └─ plain" },
    ]);
    expect(ui.selections[0].initialValues).toEqual([
      value(file),
      value(directory),
      value(selective, "settings.json"),
      value(selective, "commands"),
    ]);
  });

  it("空のグループも作成する", async () => {
    const ui = promptFixture([value(file)]);
    await run([file], ui);
    expect(ui.selections[0].options.map((option) => option.label)).toEqual([
      `[Files] ${file.target} (file)`,
    ]);
    const empty = promptFixture([]);
    expect(await run([], empty)).toEqual({ selected: [], deselected: [] });
    expect(empty.selections[0].options).toEqual([]);
    expect(empty.selections[0].initialValues).toEqual([]);
    expect(empty.confirmations).toEqual(["Nothing selected. Continue anyway?"]);
  });

  it("選択されたマッピングを正しくフィルタリングする", async () => {
    const ui = promptFixture([value(file), value(regular)]);
    expect(await run([file, directory, regular], ui)).toEqual({
      selected: [file, regular],
      deselected: [directory],
    });
    expect(ui.selections[0].initialValues).toEqual([
      value(file),
      value(directory),
    ]);
  });

  it("何も選択されなかった場合は空配列を返す", async () => {
    const mappings = [file, regular, selective];
    const ui = promptFixture([]);
    expect(await run(mappings, ui)).toEqual({
      selected: [],
      deselected: [
        file,
        { ...selective, include: ["settings.json", "commands"] },
      ],
    });
    expect(ui.confirmations).toEqual(["Nothing selected. Continue anyway?"]);
    expect(ui.endings).toEqual([]);
    const rejected = promptFixture([], false);
    expect(await run(mappings, rejected)).toBeUndefined();
    expect(rejected.cancellations).toEqual(["Operation cancelled"]);
    const cancelled = promptFixture(Symbol("cancel"));
    expect(await run(mappings, cancelled)).toBeUndefined();
    expect(cancelled.confirmations).toEqual([]);
    expect(cancelled.cancellations).toEqual(["Operation cancelled"]);
    const cancelledEmpty = promptFixture([], Symbol("cancel"));
    expect(await run(mappings, cancelledEmpty)).toBeUndefined();
    expect(cancelledEmpty.cancellations).toEqual(["Operation cancelled"]);
  });

  it("Selectiveマッピングを個別ファイルに展開する", async () => {
    const ui = promptFixture([value(selective, "settings.json")]);
    await run([selective], ui);
    expect(
      ui.selections[0].options.map(({ value, label }) => ({ value, label })),
    ).toEqual([
      {
        value: value(selective, "settings.json"),
        label: `[Selective] ${selective.target}\n  └─ settings.json`,
      },
      {
        value: value(selective, "commands"),
        label: "  └─ commands",
      },
      {
        value: value(selective, "plain"),
        label: "  └─ plain",
      },
    ]);
    expect(ui.selections[0].initialValues).toEqual([
      value(selective, "settings.json"),
      value(selective, "commands"),
    ]);
  });

  it("部分的に選択されたSelectiveマッピングを処理する", async () => {
    const ui = promptFixture([
      value(selective, "commands"),
      value(selective, "plain"),
    ]);
    expect(await run([selective], ui)).toEqual({
      selected: [
        {
          ...selective,
          include: ["commands", "plain"],
          permissions: { commands: "750" },
        },
      ],
      deselected: [{ ...selective, include: ["settings.json"] }],
    });
    const unconfigured = promptFixture([value(selective, "plain")]);
    const result = await run([selective], unconfigured);
    expect(result?.selected).toEqual([
      { ...selective, include: ["plain"], permissions: {} },
    ]);
    const uniform: FileMapping = { ...selective, permissions: "700" };
    const uniformUi = promptFixture([value(uniform, "commands")]);
    const uniformResult = await run([uniform], uniformUi);
    expect(uniformResult?.selected).toEqual([
      { ...uniform, include: ["commands"], permissions: "700" },
    ]);
  });

  it("Selective全体が選択された場合は元のマッピングを使用する", async () => {
    const ui = promptFixture([
      value(selective, "settings.json"),
      value(selective, "commands"),
      value(selective, "plain"),
    ]);
    expect(await run([selective], ui)).toEqual({
      selected: [selective],
      deselected: [],
    });
    expect(ui.selections[0].options.map((option) => option.value)).toEqual([
      value(selective, "settings.json"),
      value(selective, "commands"),
      value(selective, "plain"),
    ]);
    expect(ui.endings).toEqual(["1 items selected, 0 items deselected"]);
  });

  it("選択解除されたマッピングを検出する", async () => {
    const ui = promptFixture([value(regular)]);
    expect(await run([file, directory, regular], ui)).toEqual({
      selected: [regular],
      deselected: [file, directory],
    });
    expect(ui.selections[0].initialValues).toEqual([
      value(file),
      value(directory),
    ]);
    expect(ui.endings).toEqual(["1 items selected, 2 items deselected"]);
  });

  it("部分的に選択解除されたSelectiveマッピングを検出する", async () => {
    const ui = promptFixture([value(selective, "settings.json")]);
    const result = await run([selective], ui);
    expect(result).toEqual({
      selected: [
        {
          ...selective,
          include: ["settings.json"],
          permissions: { "settings.json": "600" },
        },
      ],
      deselected: [{ ...selective, include: ["commands"] }],
    });
    if (result === undefined)
      throw new Error("Selection unexpectedly cancelled");
    expect(await confirmMappingSelection(result, log.logger, ui.prompts)).toBe(
      true,
    );
    expect(log.messages).toEqual([
      ["Items to install:"],
      ["  Selective: 1"],
      [`    + ${selective.target} (1 files)`],
      ["Items to remove:"],
      ["  Selective: 1"],
      [`    - ${selective.target} (1 files)`],
    ]);
  });
});
