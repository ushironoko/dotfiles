# Gistdex Query Reference

このファイルは、gistdexでインデックスされたドキュメントを効率的にクエリするための参照ガイドです。

## インデックス済みファイル

- `typescript-migration-tools.md` - TypeScript移行ツールの調査結果
- `c12-migration-guide.md` - c12設定ローダーのマイグレーションガイド
- `defu-integration.md` - defuライブラリを使用したMCPサーバー設定マージの実装ガイド

## クエリパターン

### OXC (oxlint) 関連

#### 基本的な設定

```
oxlint configuration .oxlintrc.json
oxlint TypeScript rules
oxlint installation bun
```

#### パフォーマンス・速度

```
oxlint ESLint 50 100 times faster
oxlint performance benchmark
```

#### 型認識リンティング

```
oxlint type-aware oxlint-tsgolint
oxlint --type-aware preview
```

#### ルール設定

```
oxlint rules typescript no-explicit-any
oxlint categories correctness suspicious
oxlint ignorePatterns files
```

#### ESLintとの統合

```
eslint-plugin-oxlint migration
oxlint ESLint併用
```

### c12 Configuration Loader 関連

#### 基本概念

```
c12 configuration loader UnJS
c12 loadConfig TypeScript support
c12 smart configuration multiple formats
```

#### インストールとセットアップ

```
c12 bun add installation
c12 dotfiles.config.ts migration
c12 defineConfig helper function
```

#### 設定ファイル形式

```
c12 supported formats .ts .json .yaml .toml
c12 config file priority dotfiles.config
c12 package.json configuration loading
```

#### 環境別設定

```
c12 $development $production $test environment
c12 NODE_ENV environment overrides
c12 $env staging custom environments
```

#### API使用方法

```
c12 loadConfig options cwd name defaults
c12 watchConfig onWatch acceptHMR
c12 configuration merging defu deep merge
```

#### 高度な機能

```
c12 extends GitHub GitLab remote config
c12 configuration layers priority
c12 HMR hot module replacement watch
```

#### TypeScript統合

```
c12 TypeScript DotfilesConfig interface
c12 defineConfig type safety IntelliSense
c12 loadConfig generic types validation
```

#### マイグレーション

```
c12 migration JSON to TypeScript dotfiles
c12 createConfigManager async await
c12 dotfiles.json dotfiles.config.ts
```

### Gunshi CLI Framework 関連

#### 基本概念

```
Gunshi TypeScript CLI framework
Gunshi declarative configuration
Gunshi composable sub-commands
```

#### インストールとセットアップ

```
Gunshi bun installation
Gunshi package.json scripts
```

#### コマンド実装

```
Gunshi Command interface options
Gunshi sub-commands example
Gunshi globalOptions ctx.values
```

#### 型安全性

```
Gunshi type-safe argument parsing
Gunshi TypeScript interface Command
```

### defu Library 関連

#### 基本概念

```
defu UnJS recursive merge objects
defu assign default properties lightweight
defu object merging configuration
```

#### インストールとセットアップ

```
defu bun add installation
defu import usage basic example
```

#### API メソッド

```
defu createDefu custom merger
defuFn function handling defaults
defuArrayFn array function processing
```

#### 配列処理

```
defu array concatenation behavior
defu array merge limitations recursive
defu array objects lodash.merge comparison
```

#### MCPサーバーマージ実装

```
defu MCP server configuration merge
defu mcpServers duplicate prevention
defu createDefu custom merge strategy MCP
```

#### カスタムマージ戦略

```
defu createDefu customMerger function
defu merge strategy return true false
defu custom logic mcpServers array
```

#### セキュリティと型安全性

```
defu __proto__ constructor security
defu TypeScript type utility
defu object pollution prevention
```

#### パフォーマンスと比較

```
defu 2.3kB gzipped lightweight
defu vs lodash.merge performance
defu vs deepmerge comparison
```

#### 実装パターン

```
defu MCPMerger class integration
defu backup before merge
defu validation after merge
```

#### エラーハンドリング

```
defu error handling try catch
defu fallback merge failure
```

#### マイグレーション計画

```
defu migration phases implementation
defu MCPMerger update existing
defu test updates migration
```

### 統合例・実装パターン

#### プロジェクト構造

```
dotfiles project structure src commands core
TypeScript tsconfig.json Bun configuration
```

#### Dotfiles管理ツール

```
SymlinkManager createSymlink
ConfigManager DotfilesConfig
backup restore interactive
```

#### コア機能

```
FileMapping source target permissions
BackupConfig directory keepLast
SpecialHandler mergeFile Claude MCP
```

#### 実行設定

```
bin dotfiles.ts #!/usr/bin/env bun
package.json scripts dev test lint
```

### 特定のコード例

#### OXCの設定例

```
.oxlintrc.json plugins typescript import unicorn
```

#### Gunshiのコマンド例

```
installCommand dryRun verbose force
restoreCommand backup interactive partial
```

#### 型定義

```
DotfilesConfig interface mappings backup
FileMapping type file directory selective
```

### トラブルシューティング

#### エラー対処

```
Target exists force symlink
Invalid config validation error
```

#### パフォーマンス最適化

```
lazy async loading performance
CPU cores scale parallel
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

## 検索のヒント

- プロジェクト固有の情報: `project:dotfiles`を追加
- 技術カテゴリ: `category:research`を追加
- 具体的な実装例: `example`や`code`をクエリに含める
- トラブルシューティング: `error`や`issue`をクエリに含める
