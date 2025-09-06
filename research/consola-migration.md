# Consola Migration Research

## Overview

Consolaは、unjs organizationが開発している洗練されたコンソールラッパーライブラリです。現在のchalk + console.logベースの実装から、consolaへの移行により、以下の利点が得られます。

## Key Features

### 主要機能

- 👌 使いやすいAPI
- 💅 最小環境向けのフォールバック付きファンシー出力
- 🔌 プラガブルなレポーター
- 💻 一貫したCLI体験
- 🏷 タグサポート
- 🚏 console/stdout/stderrのリダイレクトと復元
- 🌐 ブラウザサポート
- ⏯ Pause/Resumeサポート
- 👻 モッキングサポート
- 👮‍♂️ ログスロットリングによるスパム防止
- ❯ clackを使った対話的プロンプトサポート

## Installation

```bash
# npm
npm i consola

# pnpm (推奨)
pnpm i consola

# bun
bun add consola
```

## Migration Map: Current Logger → Consola

### 現在の実装とconsolaの対応関係

| Current Implementation | Consola Equivalent | Notes |
|------------------------|-------------------|-------|
| `logger.error(message)` | `consola.error(message)` | 赤色のエラー出力 |
| `logger.warn(message)` | `consola.warn(message)` | 黄色の警告出力 |
| `logger.info(message)` | `consola.info(message)` | 緑色の情報出力 |
| `logger.debug(message)` | `consola.debug(message)` | グレーのデバッグ出力 |
| `logger.success(message)` | `consola.success(message)` | 太字緑色の成功メッセージ |
| `logger.action(actionName, detail)` | `consola.log(actionName, detail)` | カスタムフォーマットが必要 |
| `createLogger(verbose, dryRun)` | `createConsola({ level })` | オプション構造が異なる |
| `logger.setVerbose(boolean)` | `consola.level = 4` | レベルベースの制御 |
| `logger.setDryRun(boolean)` | カスタムレポーターで実装 | DRY RUNプレフィックスはレポーターで |

### Log Levelsマッピング

| Current LogLevel | Consola Level | Description |
|------------------|---------------|-------------|
| `LogLevel.ERROR` (0) | 0 | Fatal and Error |
| `LogLevel.WARN` (1) | 1 | Warnings |
| `LogLevel.INFO` (2) | 2-3 | Normal logs (2) / Info logs (3) |
| `LogLevel.DEBUG` (3) | 4 | Debug logs |

## Implementation Strategy

### 1. 基本的な移行パターン

```typescript
// Before (現在の実装)
import { createLogger } from "./utils/logger";
const logger = createLogger(verbose, dryRun);
logger.info("Message");

// After (consola)
import { createConsola } from "consola";
const consola = createConsola({
  level: verbose ? 4 : 3,
  // DRY RUNは別途カスタムレポーターで対応
});
consola.info("Message");
```

### 2. DRY RUNサポートの実装

consolaにはビルトインのDRY RUNサポートがないため、カスタムレポーターで実装：

```typescript
const createDryRunReporter = (isDryRun: boolean) => ({
  log: (logObj: any) => {
    if (isDryRun && logObj.level >= 2) {
      logObj.args[0] = `[DRY RUN] ${logObj.args[0]}`;
    }
    // デフォルトレポーターに委譲
  }
});
```

### 3. actionメソッドの再実装

```typescript
// 拡張メソッドとして実装
const withAction = (consola: Consola) => {
  return {
    ...consola,
    action: (actionName: string, detail: string) => {
      consola.log(chalk.cyan("→"), chalk.bold(actionName), detail);
    }
  };
};
```

## Advanced Features

### カスタムレポーター

```typescript
import { createConsola } from "consola";

const consola = createConsola({
  reporters: [
    {
      log: (logObj) => {
        // カスタムフォーマット処理
        console.log(JSON.stringify(logObj));
      },
    },
  ],
});
```

### タグ/スコープサポート

```typescript
const scopedConsola = consola.withTag("dotfiles");
scopedConsola.info("Installing symlinks"); // [dotfiles] Installing symlinks
```

### テスト時のモッキング

```typescript
// Vitest
consola.mockTypes(() => vi.fn());

// テスト内で
expect(consola.info).toHaveBeenCalledWith("expected message");
```

## Bundle Size Optimization

用途に応じて軽量ビルドを選択可能：

- `consola`: フル機能版（ファンシーレポーター含む）
- `consola/basic`: 基本機能のみ（80%サイズ削減）
- `consola/browser`: ブラウザ向け最適化
- `consola/core`: 最小コア機能のみ

## Migration Checklist

### Phase 1: 準備
- [x] 現在のlogger実装を分析
- [x] consolaドキュメントを調査
- [ ] 移行計画の作成

### Phase 2: 実装
- [ ] consolaパッケージをインストール
- [ ] Logger型定義の作成
- [ ] createLoggerファクトリー関数の置き換え
- [ ] DRY RUNカスタムレポーターの実装
- [ ] actionメソッドの互換実装

### Phase 3: 移行
- [ ] src/utils/logger.tsの更新
- [ ] 各コマンドファイルのインポート更新
- [ ] coreモジュールのlogger使用箇所更新
- [ ] テストファイルの更新

### Phase 4: 検証
- [ ] 既存テストがすべてパス
- [ ] 新しいログ出力の視覚的確認
- [ ] DRY RUNモードの動作確認
- [ ] verboseモードの動作確認

## Benefits of Migration

1. **より豊富な機能**: プロンプト、pause/resume、レポーターシステム
2. **標準化**: unjs ecosystemとの統合性向上
3. **保守性**: 活発にメンテナンスされているライブラリ
4. **テスタビリティ**: ビルトインのモッキングサポート
5. **拡張性**: プラガブルレポーターによる柔軟なカスタマイズ

## Potential Issues & Solutions

### Issue 1: TypeScript型定義
**Solution**: consolaは完全なTypeScriptサポートを提供。型定義は自動的に含まれる。

### Issue 2: 既存のLogger型との互換性
**Solution**: 既存のLogger型をconsolaインスタンスの型エイリアスとして定義。

### Issue 3: DRY RUNプレフィックス
**Solution**: カスタムレポーターまたはwithDefaultsでプレフィックス付きインスタンスを作成。

## References

- [Consola GitHub Repository](https://github.com/unjs/consola)
- [NPM Package](https://www.npmjs.com/package/consola)
- [Migration Examples](https://github.com/unjs/consola/tree/main/examples)