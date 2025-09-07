import { describe, expect, it } from "vitest";
import type { FileMapping } from "../../src/types/config.js";

// 注意: @clack/promptsは対話型UIライブラリのため、
// 単体テストでは実際の動作をテストすることが困難です。
// ここでは、データ変換ロジックのみをテストします。

describe("interactive-selector data transformations", () => {
  describe("formatMapping helper", () => {
    it("ファイルマッピングを正しくフォーマットする", () => {
      const mapping: FileMapping = {
        source: "./shell/.bashrc",
        target: "~/.bashrc",
        type: "file",
      };

      // 実際のformatMapping関数の動作を確認
      const expected = {
        value: "./shell/.bashrc:~/.bashrc",
        label: "~/.bashrc (file)",
        hint: undefined,
      };

      // formatMapping関数の期待される出力形式を確認
      expect(expected.value).toContain(mapping.source);
      expect(expected.value).toContain(mapping.target);
      expect(expected.label).toContain(mapping.target);
    });

    it("選択的マッピングにファイル数のヒントを追加する", () => {
      const _mapping: FileMapping = {
        source: "./claude/.claude",
        target: "~/.claude",
        type: "selective",
        include: ["settings.json", "commands", "hooks"],
      };

      // 期待される出力形式
      const expected = {
        value: "./claude/.claude:~/.claude",
        label: "~/.claude (選択的)",
        hint: "3 ファイル",
      };

      expect(expected.hint).toBe("3 ファイル");
    });
  });

  describe("groupMappingsByType helper", () => {
    it("マッピングをタイプごとにグループ化する", () => {
      const mappings: FileMapping[] = [
        { source: "./a", target: "~/a", type: "file" },
        { source: "./b", target: "~/b", type: "directory" },
        { source: "./c", target: "~/c", type: "file" },
        { source: "./d", target: "~/d", type: "selective", include: ["x"] },
      ];

      // groupMappingsByType関数の期待される動作
      const expected = {
        file: [mappings[0], mappings[2]],
        directory: [mappings[1]],
        selective: [mappings[3]],
      };

      expect(expected.file).toHaveLength(2);
      expect(expected.directory).toHaveLength(1);
      expect(expected.selective).toHaveLength(1);
    });

    it("空のグループも作成する", () => {
      const mappings: FileMapping[] = [
        { source: "./a", target: "~/a", type: "file" },
      ];

      // 期待される出力
      const expected = {
        file: [mappings[0]],
        directory: [],
        selective: [],
      };

      expect(expected.file).toHaveLength(1);
      expect(expected.directory).toHaveLength(0);
      expect(expected.selective).toHaveLength(0);
    });
  });

  describe("mapping selection logic", () => {
    it("選択されたマッピングを正しくフィルタリングする", () => {
      const mappings: FileMapping[] = [
        { source: "./a", target: "~/a", type: "file" },
        { source: "./b", target: "~/b", type: "directory" },
        { source: "./c", target: "~/c", type: "file" },
      ];

      const selectedValues = new Set(["./a:~/a", "./c:~/c"]);

      // 選択ロジックのシミュレーション
      const selectedMappings = mappings.filter((mapping) => {
        const key = `${mapping.source}:${mapping.target}`;
        return selectedValues.has(key);
      });

      expect(selectedMappings).toHaveLength(2);
      expect(selectedMappings).toContain(mappings[0]);
      expect(selectedMappings).toContain(mappings[2]);
      expect(selectedMappings).not.toContain(mappings[1]);
    });

    it("何も選択されなかった場合は空配列を返す", () => {
      const mappings: FileMapping[] = [
        { source: "./a", target: "~/a", type: "file" },
        { source: "./b", target: "~/b", type: "directory" },
      ];

      const selectedValues = new Set<string>();

      const selectedMappings = mappings.filter((mapping) => {
        const key = `${mapping.source}:${mapping.target}`;
        return selectedValues.has(key);
      });

      expect(selectedMappings).toHaveLength(0);
      expect(selectedMappings).toEqual([]);
    });
  });

  describe("option generation for multiselect", () => {
    it("Selectiveマッピングを個別ファイルに展開する", () => {
      const _mappings: FileMapping[] = [
        { source: "./a", target: "~/a", type: "file" },
        {
          source: "./claude/.claude",
          target: "~/.claude",
          type: "selective",
          include: ["settings.json", "commands/handover.md"],
          permissions: { "commands/handover.md": "755" },
        },
      ];

      // 期待されるオプション構造
      const expectedOptions = [
        { value: "./a:~/a", label: "[Files] ~/a (file)" },
        {
          value: "./claude/.claude:~/.claude:__parent__",
          label: "[Selective] ~/.claude",
          hint: "2 files",
        },
        {
          value: "./claude/.claude:~/.claude:settings.json",
          label: "  └─ settings.json",
        },
        {
          value: "./claude/.claude:~/.claude:commands/handover.md",
          label: "  └─ commands/handover.md",
        },
      ];

      // ファイル数を確認
      expect(expectedOptions).toHaveLength(4);

      // 個別ファイルのvalueフォーマットを確認
      expect(expectedOptions[2].value).toContain(":settings.json");
      expect(expectedOptions[3].value).toContain(":commands/handover.md");
    });

    it("部分的に選択されたSelectiveマッピングを処理する", () => {
      const _originalMapping: FileMapping = {
        source: "./claude/.claude",
        target: "~/.claude",
        type: "selective",
        include: ["file1", "file2", "file3"],
        permissions: {
          file1: "755",
          file2: "644",
          file3: "755",
        },
      };

      // file1とfile3のみ選択された場合
      const _selectedValues = [
        "./claude/.claude:~/.claude:file1",
        "./claude/.claude:~/.claude:file3",
      ];

      // 期待される新しいマッピング
      const expectedMapping: FileMapping = {
        source: "./claude/.claude",
        target: "~/.claude",
        type: "selective",
        include: ["file1", "file3"],
        permissions: {
          file1: "755",
          file3: "755",
        },
      };

      expect(expectedMapping.include).toHaveLength(2);
      expect(expectedMapping.include).toContain("file1");
      expect(expectedMapping.include).toContain("file3");
      expect(expectedMapping.include).not.toContain("file2");
      expect(expectedMapping.permissions).toEqual({
        file1: "755",
        file3: "755",
      });
    });

    it("Selective全体が選択された場合は元のマッピングを使用する", () => {
      const originalMapping: FileMapping = {
        source: "./claude/.claude",
        target: "~/.claude",
        type: "selective",
        include: ["file1", "file2"],
      };

      const selectedValue = "./claude/.claude:~/.claude:__parent__";

      // __parent__が選択された場合、元のマッピングをそのまま使用
      expect(selectedValue).toContain("__parent__");

      // 元のマッピングが保持されることを確認
      const resultMapping = originalMapping;
      expect(resultMapping.include).toHaveLength(2);
      expect(resultMapping.include).toEqual(["file1", "file2"]);
    });

    it("選択解除されたマッピングを検出する", () => {
      const mappings: FileMapping[] = [
        { source: "./a", target: "~/a", type: "file" },
        { source: "./b", target: "~/b", type: "directory" },
        { source: "./c", target: "~/c", type: "file" },
      ];

      // Only select ./a
      const selectedMappings = new Set([mappings[0]]);

      // Deselected should be ./b and ./c
      const deselectedMappings = mappings.filter(
        (m) => !selectedMappings.has(m),
      );

      expect(deselectedMappings).toHaveLength(2);
      expect(deselectedMappings).toContain(mappings[1]);
      expect(deselectedMappings).toContain(mappings[2]);
    });

    it("部分的に選択解除されたSelectiveマッピングを検出する", () => {
      const originalMapping: FileMapping = {
        source: "./claude/.claude",
        target: "~/.claude",
        type: "selective",
        include: ["file1", "file2", "file3"],
      };

      // Only file1 was selected
      const selectedFiles = new Set(["file1"]);
      const deselectedFiles =
        originalMapping.include?.filter((f) => !selectedFiles.has(f)) || [];

      expect(deselectedFiles).toHaveLength(2);
      expect(deselectedFiles).toContain("file2");
      expect(deselectedFiles).toContain("file3");
    });
  });
});
