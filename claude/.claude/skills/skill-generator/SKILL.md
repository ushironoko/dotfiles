---
name: skill-generator
description: Claude Codeのログ分析からSkillを自動生成するスキル。操作パターンを検出し、繰り返し作業をSkill化して自動化を支援する。
---

# Skill Generator

Claude Codeの操作ログを分析し、繰り返しパターンからSkillを自動生成する。

## 前提条件

- dotfilesがインストール済み
- `dotfiles analyze` コマンドが利用可能

## 実行フロー

4フェーズで動作する：

### Phase 1: 分析フェーズ

ログを分析しパターンを検出する。

```bash
# 分析コマンドの実行（JSON形式で出力）
bun run /Users/ushironoko/ghq/github.com/ushironoko/dotfiles/src/index.ts analyze --format json --days 7
```

JSON出力から以下を抽出：

- `skillCandidates`: Skill化の候補
- `patterns`: 検出されたパターン
- `efficiency`: 効率性評価
- `summary`: サマリー情報

### Phase 2: レポートフェーズ

分析結果をユーザーに報告する。

報告内容：

1. **効率性スコア**: 全体的なスコアと問題点
2. **頻出パターン**: よく使われるツールシーケンス（例: Glob -> Read -> Edit）
3. **エラー傾向**: エラー率と改善ポイント
4. **Skill候補**: 自動化できる可能性のあるパターン

### Phase 3: プランフェーズ

各Skill候補についてプランを作成し、ユーザーに承認を求める。

プランに含める情報：

| 項目         | 内容                       |
| ------------ | -------------------------- |
| Skill名      | 簡潔で分かりやすい名前     |
| 説明         | 何を自動化するか           |
| トリガー条件 | どのような状況で使用するか |
| ステップ     | 実行される処理の流れ       |
| 期待効果     | 時間短縮、エラー削減など   |

**重要**: AskUserQuestionを使用して承認を求める。

```
承認オプション:
- すべてのSkillを生成
- 選択したSkillのみ生成
- キャンセル
```

### Phase 4: 生成フェーズ

承認されたSkillについてSKILL.mdを生成する。

1. `~/.claude/skills/<skill-name>/` ディレクトリを作成
2. `SKILL.md` ファイルを生成

## SKILL.md テンプレート

生成するSKILL.mdのフォーマット：

```markdown
---
name: <skill-name>
description: <簡潔な説明>
---

# <Skill Name>

<詳細な説明>

## When to Use

<使用すべき状況の説明>

## Instructions

### Step 1: <ステップ名>

<具体的な指示>

### Step 2: <ステップ名>

<具体的な指示>

## Expected Outcome

<期待される結果>

## Notes

- <注意事項>
```

## 出力先

生成されたSkillは以下に保存：

```
~/.claude/skills/<skill-name>/SKILL.md
```

シンボリックリンクの場合、実際のファイルは：

```
/Users/ushironoko/ghq/github.com/ushironoko/dotfiles/claude/.claude/skills/<skill-name>/SKILL.md
```

## エラーハンドリング

| 状況                   | 対応                               |
| ---------------------- | ---------------------------------- |
| 分析結果が空           | セッションが見つからないことを通知 |
| Skill候補がない        | 十分なパターンがないことを説明     |
| ファイル書き込みエラー | エラー内容を報告し手動対応を提案   |

## 検証

生成後、以下を確認：

1. SKILL.mdが正しい場所に作成されたか
2. ファイル内容が正しくフォーマットされているか
3. Claude Codeで認識されているか（`/help` で確認を促す）

## 使用例

```
> /skill-generator

分析中...

=== Claude Code Log Analysis ===
期間: 2025-01-11 - 2025-01-18
セッション数: 15

効率性スコア: 85/100
- エラー率: 5.2%
- リトライ率: 8.1%

検出されたパターン:
1. Glob -> Read -> Edit (12回)
2. Grep -> Read -> Edit (8回)

Skill候補:
1. auto-glob-read: ファイル検索後に読み込み
2. auto-grep-edit: コード検索後に編集

どのSkillを生成しますか？
[1] すべて生成
[2] 選択して生成
[3] キャンセル
```
