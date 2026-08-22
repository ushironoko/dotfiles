import { describe, expect, test } from "bun:test";
import {
  initTheme,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  createHearthBashDefinition,
  createHearthEditDefinition,
  createHearthFindDefinition,
  createHearthGrepDefinition,
  createHearthReadDefinition,
  createHearthWriteDefinition,
} from "../../pi/extensions/hearth-tools/adapters";
import type { PiToolSettings } from "../../pi/extensions/hearth-tools/engine";
import {
  stripForegroundAnsi,
  withStatusTitle,
} from "../../pi/extensions/hearth-tools/status-title";

initTheme("dark", false);

const ansiByColor = {
  success: 32,
  error: 31,
  toolTitle: 36,
  toolDiffAdded: 92,
} as const;

const theme = {
  getFgAnsi(color: string) {
    const code = ansiByColor[color as keyof typeof ansiByColor] ?? 37;
    return `\x1b[${code}m`;
  },
  fg(color: string, text: string) {
    const code = ansiByColor[color as keyof typeof ansiByColor] ?? 37;
    return `\x1b[${code}m${text}\x1b[39m`;
  },
  bg(_color: string, text: string) {
    return `\x1b[40m${text}\x1b[49m`;
  },
  bold(text: string) {
    return `\x1b[1m${text}\x1b[22m`;
  },
} as Theme;

class MutableTitle implements Component {
  invalidations = 0;
  renders = 0;
  text = "";

  render(width: number): string[] {
    this.renders += 1;
    return [truncateToWidth(this.text, width, "")];
  }

  invalidate(): void {
    this.invalidations += 1;
  }
}

const schema = Type.Object({ label: Type.String() });

const createDefinition = () => {
  let reusedInner = false;
  let currentTitle: MutableTitle | undefined;
  const resultRenderer = () => new MutableTitle();
  const definition: ToolDefinition<typeof schema> = {
    name: "test",
    label: "test",
    description: "test status title",
    parameters: schema,
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
    renderCall(args, renderTheme, context) {
      const title =
        context.lastComponent instanceof MutableTitle
          ? context.lastComponent
          : new MutableTitle();
      reusedInner = context.lastComponent === title;
      currentTitle = title;
      title.text = renderTheme.fg("toolTitle", renderTheme.bold(args.label));
      return title;
    },
    renderResult: resultRenderer,
  };
  return {
    decorated: withStatusTitle(definition),
    resultRenderer,
    reusedInner: () => reusedInner,
    innerInvalidations: () => currentTitle?.invalidations,
    innerRenders: () => currentTitle?.renders,
  };
};

type RenderContext = Parameters<
  NonNullable<ReturnType<typeof createDefinition>["decorated"]["renderCall"]>
>[2];

const renderContext = (
  overrides: Partial<RenderContext> = {},
): RenderContext => ({
  args: { label: "read file.ts" },
  toolCallId: "tool-1",
  invalidate() {},
  lastComponent: undefined,
  state: undefined,
  cwd: "/workspace",
  executionStarted: true,
  argsComplete: true,
  isPartial: true,
  expanded: false,
  showImages: true,
  isError: false,
  ...overrides,
});

describe("Hearth tool status title", () => {
  test("keeps pending titles unchanged, then reuses and colors successful titles", () => {
    const setup = createDefinition();
    const { renderCall } = setup.decorated;
    if (renderCall === undefined) throw new Error("missing call renderer");
    const pending = renderCall(
      { label: "read file.ts" },
      theme,
      renderContext(),
    );

    expect(pending.render(80)[0]).toBe(
      "\x1b[36m\x1b[1mread file.ts\x1b[22m\x1b[39m",
    );

    const success = renderCall(
      { label: "read file.ts" },
      theme,
      renderContext({ lastComponent: pending, isPartial: false }),
    );

    expect(success).toBe(pending);
    expect(setup.reusedInner()).toBe(true);
    expect(success.render(80)[0]).toBe(
      "\x1b[32m✓ \x1b[1mread file.ts\x1b[22m\x1b[39m",
    );
    expect(setup.innerRenders()).toBe(3);
    success.render(80);
    expect(setup.innerRenders()).toBe(3);
    expect(setup.decorated.renderResult).toBe(setup.resultRenderer);
  });

  test("uses the error color and keeps rendered lines within width", () => {
    const setup = createDefinition();
    const { renderCall } = setup.decorated;
    if (renderCall === undefined) throw new Error("missing call renderer");
    const failed = renderCall(
      { label: "a deliberately long title" },
      theme,
      renderContext({
        args: { label: "a deliberately long title" },
        isPartial: false,
        isError: true,
      }),
    );
    const [line] = failed.render(13);

    expect(line).toStartWith("\x1b[31m✗ ");
    expect(visibleWidth(line)).toBeLessThanOrEqual(13);
    const [narrowLine] = failed.render(1);
    expect(narrowLine).not.toContain("✗");
    expect(visibleWidth(narrowLine)).toBeLessThanOrEqual(1);
  });

  test("colors wrapped title rows but preserves preview and diff rows", () => {
    const definition: ToolDefinition<typeof schema> = {
      name: "preview",
      label: "preview",
      description: "status title with semantic preview",
      parameters: schema,
      async execute() {
        return {
          content: [{ type: "text", text: "ok" }],
          details: undefined,
        };
      },
      renderCall(_args, renderTheme) {
        return {
          render: (width) => {
            const titleRows =
              width <= 8
                ? [
                    renderTheme.fg("toolTitle", "edit"),
                    "",
                    renderTheme.fg("toolTitle", "file.ts"),
                  ]
                : [
                    renderTheme.fg("toolTitle", "edit"),
                    renderTheme.fg("toolTitle", "file.ts"),
                  ];
            return [
              ...titleRows,
              "",
              truncateToWidth(
                renderTheme.fg(
                  "toolDiffAdded",
                  "+const kept = true;".padEnd(width),
                ),
                width,
                "",
              ),
            ];
          },
          invalidate() {},
        };
      },
    };
    const decorated = withStatusTitle(definition);
    const { renderCall } = decorated;
    if (renderCall === undefined) throw new Error("missing call renderer");
    const component = renderCall(
      { label: "edit file.ts" },
      theme,
      renderContext({ isPartial: false }),
    );
    const lines = component.render(80);

    expect(lines[0]).toBe("\x1b[32m✓ edit\x1b[39m");
    expect(lines[1]).toBe("\x1b[32m  file.ts\x1b[39m");
    expect(lines[2]).toBe("");
    expect(lines[3]).toStartWith("\x1b[92m+const kept = true;");
    expect(visibleWidth(lines[3])).toBe(80);

    const narrowLines = component.render(8);
    expect(narrowLines[0]).toBe("\x1b[36medit\x1b[39m");
    expect(narrowLines[2]).toBe("\x1b[36mfile.ts\x1b[39m");
    expect(narrowLines.join("")).not.toContain("✓");
    expect(narrowLines.every((line) => visibleWidth(line) <= 8)).toBe(true);
  });

  test("forwards invalidation to the inherited renderer component", () => {
    const setup = createDefinition();
    const { renderCall } = setup.decorated;
    if (renderCall === undefined) throw new Error("missing call renderer");
    const title = renderCall(
      { label: "read file.ts" },
      theme,
      renderContext({ isPartial: false }),
    );
    title.invalidate();
    expect(setup.innerInvalidations()).toBe(1);

    const next = renderCall(
      { label: "read file.ts" },
      theme,
      renderContext({ lastComponent: title, isPartial: false }),
    );
    expect(next).toBe(title);
    expect(setup.reusedInner()).toBe(true);
  });

  test("removes standalone and combined foreground SGR parameters", () => {
    expect(
      stripForegroundAnsi(
        "\x1b[1m\x1b[38;2;1;2;3mtrue\x1b[39m \x1b[38;5;42m256\x1b[39m \x1b[94mbright\x1b[39m\x1b[22m",
      ),
    ).toBe("\x1b[1mtrue 256 bright\x1b[22m");
    expect(
      stripForegroundAnsi(
        "\x1b[1;38;2;1;2;3mcombined\x1b[0;4mreset",
        "\x1b[32m",
      ),
    ).toBe("\x1b[1mcombined\x1b[0;4m\x1b[32mreset");
    expect(stripForegroundAnsi("\x1b[48;2;30;40;50;38;5;42;1mbackground")).toBe(
      "\x1b[48;2;30;40;50;1mbackground",
    );
  });

  test("decorates every Hearth-owned built-in tool definition", () => {
    const engine = {} as never;
    const gate = {
      shared: (operation: () => Promise<unknown>) => operation(),
      exclusive: (operation: () => Promise<unknown>) => operation(),
    } as never;
    const settings: PiToolSettings = {
      shellPath: "/bin/bash",
      shellCommandPrefix: undefined,
      imageAutoResize: false,
      shell: {
        program: "/bin/bash",
        args: ["-lc"],
        transport: "arg",
      } as PiToolSettings["shell"],
    };
    const definitions = [
      [
        createHearthReadDefinition("/workspace", engine, settings, gate),
        { path: "file.ts" },
        "read",
      ],
      [
        createHearthWriteDefinition("/workspace", engine, gate),
        { path: "file.ts", content: "" },
        "write",
      ],
      [
        createHearthEditDefinition("/workspace", engine, gate),
        { path: "file.ts", edits: [{ oldText: "a", newText: "b" }] },
        "edit",
      ],
      [
        createHearthBashDefinition("/workspace", engine, settings, { gate }),
        { command: "echo first\n\necho second" },
        "$ echo first",
      ],
      [
        createHearthGrepDefinition("/workspace", engine, gate),
        { pattern: "needle", path: "." },
        "grep",
      ],
      [
        createHearthFindDefinition("/workspace", engine, gate),
        { pattern: "*.ts", path: "." },
        "find",
      ],
    ] as const;

    for (const [definition, args, titleFragment] of definitions) {
      const renderCall = definition.renderCall as NonNullable<
        ToolDefinition["renderCall"]
      >;
      const rendered = renderCall(args, theme, {
        ...renderContext({ state: {}, isPartial: false }),
        args,
      } as never).render(120);
      const titleIndex = rendered.findIndex((line) =>
        line.includes(titleFragment),
      );
      expect(titleIndex).toBeGreaterThanOrEqual(0);
      expect(rendered[titleIndex]).toStartWith("\x1b[32m✓ ");
      if (definition.name === "edit") {
        expect(titleIndex).toBeGreaterThan(0);
        expect(rendered[0]).not.toContain("✓");
        expect(visibleWidth(rendered[0])).toBe(120);
      }
      if (definition.name === "bash") {
        const continuation = rendered.find((line) =>
          line.includes("echo second"),
        );
        expect(continuation).toStartWith("\x1b[32m");
        expect(continuation).not.toContain("✓");
      }
    }
  });
});
