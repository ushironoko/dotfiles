# Gistdex Query Patterns

このファイルは、インデックス済みの研究ドキュメントに対する効果的なクエリパターンをまとめたものです。

## インデックス済みファイル

- `typescript-migration-tools.md` - TypeScript移行ツールの調査結果
- `c12-migration-guide.md` - c12設定ローダーのマイグレーションガイド

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
