---
name: output-learn
description: Claude Codeセッションの技術的学びを抽出し、learnリポジトリにマークダウンとして保存・pushするスキル。
---

# Output Learn

Claude Codeセッション中の技術的学びを体系化し、`ushironoko/learn`リポジトリに保存する。

## 出力先

```
/Users/ushironoko/ghq/github.com/ushironoko/learn/src/<category>/<topic-slug>.md
```

## 実行フロー

5フェーズで動作する：

### Phase 1: セッション分析

会話履歴から技術的学びを抽出する。

抽出対象：

- **新知識**: 新たに学んだ概念、API、ライブラリの使い方
- **設計判断**: アーキテクチャ選定、パターン適用の理由
- **トラブルシュート**: エラー解決の過程と解決策
- **ベストプラクティス**: 効率的な実装方法、推奨パターン
- **コード例**: 再利用可能なスニペット、実装パターン

学びが見つからない場合は、セッションが技術的内容でないことをユーザーに通知して終了。

### Phase 2: カテゴリ決定

キーワードから候補カテゴリを自動検出し、AskUserQuestionでユーザー確認を行う。

カテゴリ例：

| カテゴリ         | 対象                           |
| ---------------- | ------------------------------ |
| `typescript`     | TypeScript言語機能、型システム |
| `bun`            | Bun runtime、API               |
| `testing`        | テスト手法、Vitest、Jest       |
| `git`            | Git操作、ワークフロー          |
| `cli`            | CLI開発、コマンドライン        |
| `architecture`   | 設計パターン、アーキテクチャ   |
| `library/<name>` | 特定ライブラリの使い方         |
| `devops`         | CI/CD、インフラ                |
| `performance`    | パフォーマンス最適化           |

```
AskUserQuestionで確認：
- 検出されたカテゴリ候補を提示
- カスタムカテゴリの入力も許可
```

### Phase 3: マークダウン生成

以下のテンプレートに基づいてマークダウンを生成する。

ファイル名: `<topic-slug>.md`（小文字ケバブケース）

**テンプレート:**

````markdown
# <タイトル>

## 概要

<学びの概要を1-2文で>

## 背景・きっかけ

<どのような状況でこの学びを得たか>

## 学んだこと

### <サブトピック>

<詳細な説明>

```<language>
// コード例
```

## ポイント

- <重要ポイント1>
- <重要ポイント2>

## 参考

- [リンクテキスト](URL)
````

### Phase 4: ユーザー確認

生成したマークダウンのプレビューを表示し、ユーザー確認を行う。

確認内容：

1. **プレビュー表示**: 生成したマークダウン全文を表示
2. **重複チェック**: 同名ファイルが存在する場合は警告

```
AskUserQuestionで確認：
- 承認して保存
- 内容を修正（修正点を指示）
- ファイル名を変更
- キャンセル
```

同名ファイルが存在する場合の選択肢：

```
AskUserQuestionで確認：
- 上書き
- 別名で保存（サフィックス追加）
- 既存ファイルに追記
- キャンセル
```

### Phase 5: 保存・Push

承認後、以下の手順でファイルを保存しPushする。

```bash
# 1. learnリポジトリの存在確認
LEARN_REPO="/Users/ushironoko/ghq/github.com/ushironoko/learn"

if [ ! -d "$LEARN_REPO" ]; then
  echo "learnリポジトリが見つかりません"
  echo "ghq get ushironoko/learn を実行してください"
  exit 1
fi

# 2. カテゴリディレクトリ作成（必要時）
mkdir -p "$LEARN_REPO/src/<category>"

# 3. ファイル作成
# Writeツールでマークダウンを書き込む

# 4. Git操作
cd "$LEARN_REPO"
git add "src/<category>/<topic-slug>.md"
git commit -m "Add: <タイトル>"
git push origin main
```

## エラーハンドリング

| 状況                         | 対応                                                     |
| ---------------------------- | -------------------------------------------------------- |
| learnリポジトリ未クローン    | `ghq get ushironoko/learn`の実行を提案                   |
| 技術的学びが抽出できない     | セッションが技術的内容でないことを通知して終了           |
| Git push失敗                 | エラー内容を表示し、手動対応（認証、ネットワーク）を提案 |
| 同名ファイル存在             | 上書き/別名/追記の選択をAskUserQuestionで確認            |
| カテゴリディレクトリ作成失敗 | パーミッションエラーを報告                               |

## 使用例

```
> /output-learn

=== Phase 1: セッション分析 ===
会話履歴を分析中...

検出された学び:
1. c12の環境別設定オーバーライド機能
2. defuによるディープマージの挙動
3. Bunのテスト用一時ディレクトリ作成パターン

=== Phase 2: カテゴリ決定 ===
検出されたキーワード: c12, defu, Bun, テスト

推奨カテゴリ: library/c12

カテゴリを選択してください:
[1] library/c12 (推奨)
[2] typescript
[3] testing
[4] カスタム入力

> 1

=== Phase 3: マークダウン生成 ===
ファイル名: c12-environment-config-override.md

# c12の環境別設定オーバーライド

## 概要
c12を使用して環境ごとに異なる設定を適用する方法...

=== Phase 4: ユーザー確認 ===
[プレビュー表示]

操作を選択:
[1] 承認して保存
[2] 内容を修正
[3] キャンセル

> 1

=== Phase 5: 保存・Push ===
ファイル作成: /Users/ushironoko/.../learn/src/library/c12/c12-environment-config-override.md
git add完了
git commit完了: "Add: c12の環境別設定オーバーライド"
git push完了

✓ 学びをlearnリポジトリに保存しました
```

## 注意事項

- 会話履歴全体を分析するため、セッション後半での実行を推奨
- 複数の学びがある場合は、最も重要なものを1つ選んで出力
- コード例は必要最小限に絞り、説明を重視する
- 参考URLはセッション中に言及されたもののみ含める
