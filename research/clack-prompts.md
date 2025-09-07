# @clack/prompts ドキュメント

## 概要

@clack/promptsは、美しくミニマルなコマンドライン対話型インターフェースを構築するためのTypeScript/JavaScriptライブラリです。@clack/coreの機能をラップし、事前にスタイル設定された使いやすいAPIを提供します。

### 特徴

- 🤏 他のオプションより80%小さいサイズ
- 💎 美しくミニマルなUI
- ✅ シンプルなAPI
- 🧱 text、confirm、select、multiselect、spinnerコンポーネントを標準搭載
- 🎨 事前にスタイル設定済み
- 🚀 TypeScript対応

## インストール

```bash
# npm
npm install @clack/prompts

# yarn
yarn add @clack/prompts

# pnpm
pnpm add @clack/prompts

# bun
bun add @clack/prompts
```

## 基本概念

### セッション管理

プロンプトセッションの開始と終了を明確に示すための`intro`と`outro`関数：

```typescript
import { intro, outro } from "@clack/prompts";

intro(`create-my-app`);
// プロンプトやその他の処理
outro(`You're all set!`);
```

### キャンセル処理

ユーザーがCTRL+Cでキャンセルした場合の処理は、`isCancel`関数でガード：

```typescript
import { isCancel, cancel, text } from "@clack/prompts";

const value = await text({
  message: "What is the meaning of life?",
});

if (isCancel(value)) {
  cancel("Operation cancelled.");
  process.exit(0);
}
```

## コンポーネント詳細

### Text

単一行のテキスト入力を受け付けるコンポーネント：

```typescript
import { text } from "@clack/prompts";

const meaning = await text({
  message: "What is the meaning of life?",
  placeholder: "Not sure",
  initialValue: "42",
  validate(value) {
    if (value.length === 0) return `Value is required!`;
  },
});
```

#### オプション

- `message` (string, required): プロンプトメッセージ
- `placeholder` (string, optional): プレースホルダーテキスト
- `initialValue` (string, optional): 初期値
- `validate` (function, optional): バリデーション関数。エラーメッセージを返すとバリデーションエラー

### Confirm

Yes/No（真偽値）の回答を受け付けるコンポーネント：

```typescript
import { confirm } from "@clack/prompts";

const shouldContinue = await confirm({
  message: "Do you want to continue?",
});
```

#### オプション

- `message` (string, required): 確認メッセージ
- `initialValue` (boolean, optional): 初期選択状態

### Select

複数の選択肢から1つを選択するコンポーネント：

```typescript
import { select } from "@clack/prompts";

const projectType = await select({
  message: "Pick a project type.",
  options: [
    { value: "ts", label: "TypeScript" },
    { value: "js", label: "JavaScript" },
    { value: "coffee", label: "CoffeeScript", hint: "oh no" },
  ],
});
```

#### オプション

- `message` (string, required): 選択プロンプトメッセージ
- `options` (array, required): 選択肢の配列
  - `value`: 選択時に返される値
  - `label`: 表示されるラベル
  - `hint` (optional): 補足説明
- `initialValue` (any, optional): 初期選択値

### MultiSelect

複数の選択肢から複数を選択できるコンポーネント：

```typescript
import { multiselect } from "@clack/prompts";

const additionalTools = await multiselect({
  message: "Select additional tools.",
  options: [
    { value: "eslint", label: "ESLint", hint: "recommended" },
    { value: "prettier", label: "Prettier" },
    { value: "gh-action", label: "GitHub Action" },
  ],
  required: false,
});
```

#### オプション

- `message` (string, required): 選択プロンプトメッセージ
- `options` (array, required): 選択肢の配列
  - `value`: 選択時に返される値
  - `label`: 表示されるラベル
  - `hint` (optional): 補足説明
- `required` (boolean, optional): 最低1つの選択を必須にするか
- `initialValues` (array, optional): 初期選択値の配列

### Spinner

長時間実行される処理を表示するコンポーネント：

```typescript
import { spinner } from "@clack/prompts";

const s = spinner();
s.start("Installing via npm");
// インストール処理など
s.stop("Installed via npm");
```

#### メソッド

- `start(message)`: スピナーを開始
- `stop(message)`: スピナーを停止して完了メッセージを表示
- `message(message)`: スピナーのメッセージを更新

## 高度な機能

### Grouping（グループ化）

関連するプロンプトをグループ化して管理：

```typescript
import * as p from "@clack/prompts";

const group = await p.group(
  {
    name: () => p.text({ message: "What is your name?" }),
    age: () => p.text({ message: "What is your age?" }),
    color: ({ results }) =>
      p.multiselect({
        message: `What is your favorite color ${results.name}?`,
        options: [
          { value: "red", label: "Red" },
          { value: "green", label: "Green" },
          { value: "blue", label: "Blue" },
        ],
      }),
  },
  {
    // グループ全体のキャンセルコールバック
    onCancel: ({ results }) => {
      p.cancel("Operation cancelled.");
      process.exit(0);
    },
  },
);

console.log(group.name, group.age, group.color);
```

#### 特徴

- プロンプト間で結果を参照可能（`results`パラメータ）
- 統一されたキャンセル処理
- 型安全な結果の取得

### Tasks（タスク実行）

複数のタスクをスピナー付きで実行：

```typescript
import * as p from "@clack/prompts";

await p.tasks([
  {
    title: "Installing via npm",
    task: async (message) => {
      // インストール処理
      return "Installed via npm";
    },
  },
  {
    title: "Setting up configuration",
    task: async (message) => {
      // 設定処理
      return "Configuration complete";
    },
  },
]);
```

### ログ機能

様々なレベルのログメッセージを出力：

```typescript
import { log } from "@clack/prompts";

log.info("Info!");
log.success("Success!");
log.step("Step!");
log.warn("Warn!");
log.error("Error!");
log.message("Hello, World", { symbol: color.cyan("~") });
```

#### ログレベル

- `info`: 情報メッセージ（青色のアイコン）
- `success`: 成功メッセージ（緑色のチェックマーク）
- `step`: ステップ表示（緑色の矢印）
- `warn`: 警告メッセージ（黄色の警告アイコン）
- `error`: エラーメッセージ（赤色のエラーアイコン）
- `message`: カスタムシンボル付きメッセージ

### Stream（ストリーミング）

動的なメッセージやLLMの出力などをストリーミング表示：

```typescript
import { stream } from "@clack/prompts";

// ジェネレータ関数を使用
stream.info(
  (function* () {
    yield "Loading...";
    yield "Processing...";
    yield "Complete!";
  })(),
);

// 非同期イテレータも対応
stream.message(
  (async function* () {
    for (const chunk of await fetchStreamData()) {
      yield chunk;
    }
  })(),
);
```

## ベストプラクティス

### 1. エラーハンドリング

すべてのプロンプトでキャンセル処理を実装：

```typescript
const handleCancel = (value: any) => {
  if (isCancel(value)) {
    cancel("Operation cancelled");
    process.exit(0);
  }
  return value;
};

const name = handleCancel(await text({ message: "Name?" }));
```

### 2. バリデーション

入力値の検証を適切に実装：

```typescript
const email = await text({
  message: "Enter your email",
  validate: (value) => {
    if (!value.includes("@")) {
      return "Please enter a valid email";
    }
  },
});
```

### 3. グループ化の活用

関連するプロンプトはグループ化して管理：

```typescript
const config = await p.group({
  // 基本設定
  projectName: () => p.text({ message: "Project name?" }),
  description: () => p.text({ message: "Description?" }),

  // 詳細設定
  features: () =>
    p.multiselect({
      message: "Select features",
      options: featureOptions,
    }),
});
```

### 4. ユーザーフレンドリーなメッセージ

- 明確で簡潔なプロンプトメッセージ
- 適切なプレースホルダーやヒントの提供
- エラーメッセージは具体的に

### 5. 非同期処理の適切な管理

```typescript
const s = spinner();
try {
  s.start("Processing...");
  await longRunningTask();
  s.stop("Complete!");
} catch (error) {
  s.stop("Failed");
  log.error(error.message);
}
```

## 実装例

### CLIツールの実装例

```typescript
import * as p from "@clack/prompts";
import { setTimeout } from "node:timers/promises";

async function main() {
  p.intro(`Welcome to the CLI tool`);

  const project = await p.group(
    {
      name: () =>
        p.text({
          message: "What is your project name?",
          placeholder: "my-app",
          validate: (value) => {
            if (!value) return "Project name is required";
            if (!/^[a-z0-9-]+$/.test(value)) {
              return "Project name can only contain lowercase letters, numbers, and hyphens";
            }
          },
        }),

      framework: () =>
        p.select({
          message: "Select a framework",
          options: [
            { value: "react", label: "React" },
            { value: "vue", label: "Vue" },
            { value: "svelte", label: "Svelte" },
          ],
        }),

      features: () =>
        p.multiselect({
          message: "Select additional features",
          options: [
            { value: "typescript", label: "TypeScript", hint: "recommended" },
            { value: "eslint", label: "ESLint" },
            { value: "prettier", label: "Prettier" },
            { value: "testing", label: "Testing" },
          ],
          required: false,
        }),

      install: () =>
        p.confirm({
          message: "Install dependencies?",
        }),
    },
    {
      onCancel: () => {
        p.cancel("Operation cancelled");
        process.exit(0);
      },
    },
  );

  const s = p.spinner();
  s.start("Setting up project");
  await setTimeout(2000);
  s.stop("Project setup complete");

  if (project.install) {
    await p.tasks([
      {
        title: "Installing dependencies",
        task: async () => {
          await setTimeout(3000);
          return "Dependencies installed";
        },
      },
      {
        title: "Setting up configuration",
        task: async () => {
          await setTimeout(1000);
          return "Configuration complete";
        },
      },
    ]);
  }

  p.outro(`Your project ${project.name} is ready! 🎉`);
}

main().catch(console.error);
```

## 型定義

@clack/promptsは完全なTypeScript型定義を提供：

```typescript
import type {
  ConfirmOptions,
  TextOptions,
  SelectOptions,
} from "@clack/prompts";

// カスタムオプション型
interface CustomSelectOption {
  value: string;
  label: string;
  description?: string;
}

// ジェネリック型のサポート
const result = await select<string>({
  message: "Select an option",
  options: [
    { value: "a", label: "Option A" },
    { value: "b", label: "Option B" },
  ],
});
```

## パフォーマンス

- **サイズ**: 約2.3KB (gzipped)
- **依存関係**: 最小限（@clack/coreのみ）
- **起動時間**: 高速（遅延読み込み対応）

## トラブルシューティング

### よくある問題

1. **Windowsでの表示問題**
   - Windows Terminalの使用を推奨
   - Unicode文字の表示に問題がある場合は、フォント設定を確認

2. **Node.jsバージョン**
   - Node.js 14以上が必要
   - ESモジュールのサポートが必要

3. **TypeScriptエラー**
   - `tsconfig.json`で`moduleResolution: "node"`を設定
   - `esModuleInterop: true`を有効化

## 関連リソース

- [GitHub Repository](https://github.com/bombshell-dev/clack)
- [npm Package](https://www.npmjs.com/package/@clack/prompts)
- [@clack/core](https://www.npmjs.com/package/@clack/core) - 低レベルAPI
