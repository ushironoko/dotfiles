# Gistdex Query Patterns

このファイルは、インデックス済みの研究ドキュメントに対する効果的なクエリパターンをまとめたものです。

## インデックス済みファイル

- `typescript-migration-tools.md` - TypeScript移行ツールの調査結果
- `c12-migration-guide.md` - c12設定ローダーのマイグレーションガイド
- `defu-integration.md` - defuライブラリを使用したMCPサーバー設定マージの実装ガイド
- `consola-migration.md` - consolaログライブラリへの移行ガイド

## クエリパターン

### OXC (oxlint) 関連

#### 基本的な設定

```
query: "oxlint configuration .oxlintrc.json"
query: "oxlint TypeScript rules"
query: "oxlint installation bun"
```

#### パフォーマンス・速度

```
query: "oxlint ESLint 50 100 times faster"
query: "oxlint performance benchmark"
```

#### 型認識リンティング

```
query: "oxlint type-aware oxlint-tsgolint"
query: "oxlint --type-aware preview"
```

#### ルール設定

```
query: "oxlint rules typescript no-explicit-any"
query: "oxlint categories correctness suspicious"
query: "oxlint ignorePatterns files"
```

#### ESLintとの統合

```
query: "eslint-plugin-oxlint migration"
query: "oxlint ESLint併用"
```

### c12 Configuration Loader 関連

#### 基本概念

```
query: "c12 configuration loader UnJS"
query: "c12 loadConfig TypeScript support"
query: "c12 smart configuration multiple formats"
```

#### インストールとセットアップ

```
query: "c12 bun add installation"
query: "c12 dotfiles.config.ts migration"
query: "c12 defineConfig helper function"
```

#### 設定ファイル形式

```
query: "c12 supported formats .ts .json .yaml .toml"
query: "c12 config file priority dotfiles.config"
query: "c12 package.json configuration loading"
```

#### 環境別設定

```
query: "c12 $development $production $test environment"
query: "c12 NODE_ENV environment overrides"
query: "c12 $env staging custom environments"
```

#### API使用方法

```
query: "c12 loadConfig options cwd name defaults"
query: "c12 watchConfig onWatch acceptHMR"
query: "c12 configuration merging defu deep merge"
```

#### 高度な機能

```
query: "c12 extends GitHub GitLab remote config"
query: "c12 configuration layers priority"
query: "c12 HMR hot module replacement watch"
```

#### TypeScript統合

```
query: "c12 TypeScript DotfilesConfig interface"
query: "c12 defineConfig type safety IntelliSense"
query: "c12 loadConfig generic types validation"
```

#### マイグレーション

```
query: "c12 migration JSON to TypeScript dotfiles"
query: "c12 createConfigManager async await"
query: "c12 dotfiles.json dotfiles.config.ts"
```

### Gunshi CLI Framework 関連

#### 基本概念

```
query: "Gunshi TypeScript CLI framework"
query: "Gunshi declarative configuration"
query: "Gunshi composable sub-commands"
```

#### インストールとセットアップ

```
query: "Gunshi bun installation"
query: "Gunshi package.json scripts"
```

#### コマンド実装

```
query: "Gunshi Command interface options"
query: "Gunshi sub-commands example"
query: "Gunshi globalOptions ctx.values"
```

#### 型安全性

```
query: "Gunshi type-safe argument parsing"
query: "Gunshi TypeScript interface Command"
```

### defu Library 関連

#### 基本概念

```
query: "defu UnJS recursive merge objects"
query: "defu assign default properties lightweight"
query: "defu object merging configuration"
```

#### インストールとセットアップ

```
query: "defu bun add installation"
query: "defu import usage basic example"
```

#### API メソッド

```
query: "defu createDefu custom merger"
query: "defuFn function handling defaults"
query: "defuArrayFn array function processing"
```

#### 配列処理

```
query: "defu array concatenation behavior"
query: "defu array merge limitations recursive"
query: "defu array objects lodash.merge comparison"
```

#### MCPサーバーマージ実装

```
query: "defu MCP server configuration merge"
query: "defu mcpServers duplicate prevention"
query: "defu createDefu custom merge strategy MCP"
```

#### カスタムマージ戦略

```
query: "defu createDefu customMerger function"
query: "defu merge strategy return true false"
query: "defu custom logic mcpServers array"
```

#### セキュリティと型安全性

```
query: "defu __proto__ constructor security"
query: "defu TypeScript type utility"
query: "defu object pollution prevention"
```

#### パフォーマンスと比較

```
query: "defu 2.3kB gzipped lightweight"
query: "defu vs lodash.merge performance"
query: "defu vs deepmerge comparison"
```

#### 実装パターン

```
query: "defu MCPMerger class integration"
query: "defu backup before merge"
query: "defu validation after merge"
```

#### エラーハンドリング

```
query: "defu error handling try catch"
query: "defu fallback merge failure"
```

#### マイグレーション計画

```
query: "defu migration phases implementation"
query: "defu MCPMerger update existing"
query: "defu test updates migration"
```

### Consola Logger 関連

#### 基本概念

```
query: "consola elegant console wrapper UnJS"
query: "consola fancy output fallback minimal"
query: "consola pluggable reporters custom"
```

#### インストールとセットアップ

```
query: "consola pnpm bun installation"
query: "consola createConsola options level"
query: "consola ESM CommonJS import"
```

#### ログメソッド

```
query: "consola error warn info debug success"
query: "consola log types preset styles"
query: "consola.box message display"
```

#### ログレベル

```
query: "consola log level 0 1 2 3 4 5"
query: "consola CONSOLA_LEVEL environment"
query: "consola verbose debug trace silent"
```

#### DRY RUNサポート

```
query: "consola DRY RUN custom reporter"
query: "consola withDefaults prefix"
query: "consola reporter log object modification"
```

#### プロンプト機能

```
query: "consola prompt text confirm select multiselect"
query: "consola prompt cancel strategy default undefined"
query: "consola clack interactive prompt"
```

#### カスタムレポーター

```
query: "consola custom reporter log interface"
query: "consola reporter JSON output"
query: "consola addReporter removeReporter setReporters"
```

#### タグ/スコープ

```
query: "consola withTag withScope scoped logger"
query: "consola tag prefix output format"
```

#### テスト統合

```
query: "consola mockTypes vitest jest"
query: "consola test mock calls expect"
query: "consola wrapAll restoreAll test"
```

#### バンドルサイズ最適化

```
query: "consola basic browser core build"
query: "consola 80% bundle size reduction"
query: "consola minimal reporter fallback"
```

#### 移行マッピング

```
query: "consola migration chalk console.log"
query: "consola createLogger verbose dryRun"
query: "consola Logger type compatibility"
```

#### actionメソッド互換実装

```
query: "consola action method cyan bold"
query: "consola withAction extension custom"
```

#### Pause/Resume機能

```
query: "consola pauseLogs resumeLogs enqueue"
query: "consola global pause resume"
```

#### stdout/stderr リダイレクト

```
query: "consola wrapConsole restoreConsole"
query: "consola wrapStd restoreStd stdout stderr"
```

### 統合例・実装パターン

#### プロジェクト構造

```
query: "dotfiles project structure src commands core"
query: "TypeScript tsconfig.json Bun configuration"
```

#### Dotfiles管理ツール

```
query: "SymlinkManager createSymlink"
query: "ConfigManager DotfilesConfig"
query: "backup restore interactive"
```

#### コア機能

```
query: "FileMapping source target permissions"
query: "BackupConfig directory keepLast"
query: "SpecialHandler mergeFile Claude MCP"
```

#### 実行設定

```
query: "bin dotfiles.ts #!/usr/bin/env bun"
query: "package.json scripts dev test lint"
```

### 特定のコード例

#### OXCの設定例

```
query: ".oxlintrc.json plugins typescript import unicorn"
```

#### Gunshiのコマンド例

```
query: "installCommand dryRun verbose force"
query: "restoreCommand backup interactive partial"
```

#### 型定義

```
query: "DotfilesConfig interface mappings backup"
query: "FileMapping type file directory selective"
```

### トラブルシューティング

#### エラー対処

```
query: "Target exists force symlink"
query: "Invalid config validation error"
```

#### パフォーマンス最適化

```
query: "lazy async loading performance"
query: "CPU cores scale parallel"
```

## 使用例

```typescript
// Gistdexでクエリを実行
import { query } from "@mcp/gistdex";

// OXCの設定について調べる
const oxcConfig = await query({
  query: "oxlint configuration .oxlintrc.json TypeScript",
  k: 5,
  rerank: true,
});

// c12の環境別設定について調べる
const c12EnvConfig = await query({
  query: "c12 $development $production environment overrides",
  k: 5,
  rerank: true,
});

// Gunshiのサブコマンド実装を調べる
const gunshiSubcommands = await query({
  query: "Gunshi sub-commands Command interface",
  k: 3,
  hybrid: true,
});

// c12マイグレーションの手順を調べる
const c12Migration = await query({
  query: "c12 migration dotfiles.json dotfiles.config.ts TypeScript",
  full: true,
});

// consolaへの移行手順を調べる
const consolaMigration = await query({
  query: "consola migration createLogger chalk DRY RUN",
  k: 5,
  rerank: true,
});

// consolaのカスタムレポーター実装を調べる
const consolaReporter = await query({
  query: "consola custom reporter DRY RUN prefix",
  full: true,
});

// 特定の実装パターンを探す
const symlinkImpl = await query({
  query: "SymlinkManager createSymlink dryRun force",
  full: true,
});
```

## メタデータフィルタリング

インデックス時に付与したメタデータでフィルタリング：

```typescript
// 特定のツールに関する情報のみ
await query({
  query: "configuration",
  type: "file",
  metadata: { tools: "oxc" },
});

// 研究ドキュメントのみ
await query({
  query: "TypeScript",
  type: "file",
  metadata: { type: "research" },
});
```

## 効果的なクエリのコツ

1. **具体的なキーワードを使う**: "oxlint" より "oxlint .oxlintrc.json plugins"
2. **コンテキストを含める**: "Command" より "Gunshi Command interface TypeScript"
3. **ハイブリッド検索を活用**: セマンティック検索とキーワード検索の組み合わせ
4. **リランキングを有効に**: より関連性の高い結果を上位に
5. **適切なk値**: 必要な情報量に応じて結果数を調整（デフォルト: 5）
