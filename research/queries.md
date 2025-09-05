# Gistdex Query Patterns

このファイルは、インデックス済みの研究ドキュメントに対する効果的なクエリパターンをまとめたものです。

## インデックス済みファイル
- `typescript-migration-tools.md` - TypeScript移行ツールの調査結果

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
import { query } from '@mcp/gistdex';

// OXCの設定について調べる
const oxcConfig = await query({
  query: "oxlint configuration .oxlintrc.json TypeScript",
  k: 5,
  rerank: true
});

// Gunshiのサブコマンド実装を調べる
const gunshiSubcommands = await query({
  query: "Gunshi sub-commands Command interface",
  k: 3,
  hybrid: true
});

// 特定の実装パターンを探す
const symlinkImpl = await query({
  query: "SymlinkManager createSymlink dryRun force",
  full: true
});
```

## メタデータフィルタリング

インデックス時に付与したメタデータでフィルタリング：

```typescript
// 特定のツールに関する情報のみ
await query({
  query: "configuration",
  type: "file",
  metadata: { tools: "oxc" }
});

// 研究ドキュメントのみ
await query({
  query: "TypeScript",
  type: "file", 
  metadata: { type: "research" }
});
```

## 効果的なクエリのコツ

1. **具体的なキーワードを使う**: "oxlint" より "oxlint .oxlintrc.json plugins"
2. **コンテキストを含める**: "Command" より "Gunshi Command interface TypeScript"
3. **ハイブリッド検索を活用**: セマンティック検索とキーワード検索の組み合わせ
4. **リランキングを有効に**: より関連性の高い結果を上位に
5. **適切なk値**: 必要な情報量に応じて結果数を調整（デフォルト: 5）