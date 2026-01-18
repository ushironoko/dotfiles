# Claude Code ログ分析・自己改善Skill生成機能

## 概要

Claude Codeの操作ログを分析し、パターン検出・効率性評価を行い、最適化されたSkillを自動生成する機能。

## アーキテクチャ

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   log-parser.ts │────▶│  log-analyzer.ts │────▶│ analyze コマンド │
│  (既存: 抽出)    │     │  (新規: 集計)     │     │  (新規: CLI)     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                │
                                ▼
                        ┌─────────────────────────────────────┐
                        │         /skill-generator            │
                        │  (統合Agent: 分析→提案→承認→生成)    │
                        └─────────────────────────────────────┘
```

### 統合フロー（/skill-generator）

```
1. 分析フェーズ
   └─ dotfiles analyze --format json を内部実行
   └─ パターン検出・効率性評価

2. レポートフェーズ
   └─ 分析結果をユーザーに提示
   └─ Skill化候補を特定

3. プランフェーズ
   └─ 生成するSkillの内容をプランとして作成
   └─ ユーザーに承認を要求

4. 生成フェーズ（承認後）
   └─ SKILL.mdを生成・保存
```

## 実装ファイル

### 1. 型定義 (`src/types/analysis.ts`) - 新規

```typescript
// メトリクス・パターン・推奨事項の型定義
export interface SessionMetrics { ... }
export interface OperationPattern { ... }
export interface Recommendation { ... }
```

### 2. log-parser.ts 拡張 - 既存ファイル修正

追加する関数:

- `parseToolResults()` - tool_result抽出（エラー情報含む）
- `getSessionTimeRange()` - セッション時間範囲取得
- `countUserMessages()` - ユーザーメッセージ数カウント

### 3. log-analyzer.ts (`src/core/log-analyzer.ts`) - 新規

```typescript
export const calculateSessionMetrics = (sessionPath, toolUsages, toolResults) => { ... }
export const evaluateEfficiency = (toolUsages, toolResults) => { ... }
export const aggregateAnalysis = (sessions) => { ... }
```

### 4. pattern-detector.ts (`src/core/pattern-detector.ts`) - 新規

```typescript
// N-gramベースのパターン検出
export const detectPatterns = (toolUsages, options) => { ... }
```

### 5. analyze コマンド (`src/commands/analyze.ts`) - 新規

```bash
dotfiles analyze                    # 直近7日間の分析
dotfiles analyze --session <id>     # 特定セッション
dotfiles analyze --format json      # JSON出力（Agent用）
dotfiles analyze --format markdown  # Markdownレポート
```

### 6. 統合Agent (`~/.claude/agents/skill-generator.md`) - 新規

エンドツーエンドでログ分析からSkill生成までを行う統合Agent。

**処理フロー:**

1. **分析フェーズ**
   - `dotfiles analyze --format json` を内部実行
   - パターン認識・品質評価を実施
   - Skill化候補を特定

2. **レポートフェーズ**
   - 分析結果をユーザーに提示
   - 検出されたパターン、効率性指標、改善ポイントを報告

3. **プランフェーズ**
   - Skill化候補ごとにプランを作成
   - Skill名、説明、主要ステップ、期待効果を提示
   - ユーザーに承認を要求（AskUserQuestion使用）

4. **生成フェーズ**（承認後）
   - SKILL.mdを生成
   - `~/.claude/skills/<name>/SKILL.md` に保存
   - 生成結果を報告

**出力:** `~/.claude/skills/<name>/SKILL.md`

### 7. スラッシュコマンド - 新規

- `~/.claude/commands/skill-generator.md` - 統合フロー実行

## 主要メトリクス

| 指標         | 説明                           |
| ------------ | ------------------------------ |
| エラー率     | errorCount / totalToolCalls    |
| 手戻り率     | 同一ファイルへの連続Edit回数   |
| パターン頻度 | 特定ツールシーケンスの出現回数 |
| 効率性スコア | 目的達成までの平均手数         |

## 実装フェーズ

### Phase 1: 基盤整備

1. `src/types/analysis.ts` - 型定義
2. `log-parser.ts` 拡張 - parseToolResults, getSessionTimeRange

### Phase 2: コア分析機能

3. `src/core/log-analyzer.ts` - メトリクス計算
4. `src/core/pattern-detector.ts` - パターン検出

### Phase 3: CLI統合

5. `src/commands/analyze.ts` - analyzeコマンド
6. `src/index.ts` - コマンド追加

### Phase 4: Agent定義

7. `~/.claude/agents/skill-generator.md` - 統合Agent
8. `~/.claude/commands/skill-generator.md` - スラッシュコマンド

## 修正対象ファイル

| ファイル                                | 操作                |
| --------------------------------------- | ------------------- |
| `src/types/analysis.ts`                 | 新規作成            |
| `src/core/log-parser.ts`                | 関数追加            |
| `src/core/log-analyzer.ts`              | 新規作成            |
| `src/core/pattern-detector.ts`          | 新規作成            |
| `src/commands/analyze.ts`               | 新規作成            |
| `src/index.ts`                          | analyzeコマンド追加 |
| `~/.claude/agents/skill-generator.md`   | 新規作成            |
| `~/.claude/commands/skill-generator.md` | 新規作成            |

## テスト

### 単体テスト

```bash
bun test tests/core/log-analyzer.test.ts
bun test tests/core/pattern-detector.test.ts
```

### 統合テスト

```bash
# CLIコマンド動作確認
bun run src/index.ts analyze --help
bun run src/index.ts analyze --format json

# 統合Agent動作確認
/skill-generator
```

## 検証方法

1. `dotfiles analyze` でレポートが出力されること
2. `--format json` でAgent用JSONが出力されること
3. `/skill-generator` で統合Agentが起動すること
4. 分析結果がユーザーに提示されること
5. Skill化候補のプランが提示され、承認を求められること
6. 承認後、SKILL.mdが `~/.claude/skills/<name>/` に生成されること
7. 生成されたSkillがClaude Codeで認識されること（`/help` で確認）
