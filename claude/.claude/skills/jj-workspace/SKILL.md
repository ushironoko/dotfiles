---
name: jj-workspace
description: Jujutsu workspaceを使用した並行作業管理。実装開始時にworkspaceを作成し、完了時に削除する。
---

# Jujutsu Workspace Management (jwq)

軽微な修正以外の実装作業は、jj workspaceで作業ディレクトリを分離する。

## 0. 前提条件

- jjはmise管理によりインストール済み
- 参考: https://docs.jj-vcs.dev/latest/
- Colocatedモード: git互換を維持（git/jj両方使用可能）

## 1. Workspace 作成

### 1.1 既存workspace確認

```bash
jwq-list -g
```

### 1.2 新規ブランチ（bookmark）でworkspace作成（推奨）

```bash
# 新規ブランチ + workspace を作成
jwq-add -b feature/xxx

# 作成後、workspaceに移動
cd $(jwq-get feature-xxx)
```

### 1.3 依存関係インストール

```bash
# lock fileを検出してインストール
if [ -f "bun.lockb" ]; then
    bun install
elif [ -f "pnpm-lock.yaml" ]; then
    pnpm install
fi
```

## 2. 作業中

### 2.1 workspace内でコマンド実行

```bash
# cdなしでworkspace内でコマンド実行
jwq-exec feature-xxx -- bun test
jwq-exec feature-xxx -- bun run lint
jwq-exec feature-xxx -- bun run tsc
```

### 2.2 変更状態確認

```bash
jwq-status -g
```

### 2.3 変更の説明とコミット

```bash
# jjでの変更説明
jj describe -m "変更の説明"

# git pushでリモートにプッシュ
jj git push --branch feature/xxx
```

### 2.4 注意事項

- workspace内で作業を継続する
- jjコマンドとgitコマンドの両方が使用可能（colocated）
- 各Bashコマンドは workspace ディレクトリ内で実行する

## 3. 作業完了後

### 3.1 削除前確認

ユーザーに以下を確認する:

- 「workspace作業が完了しました。削除してよろしいですか？」

```bash
# 変更状態を確認
jwq-status -g
```

### 3.2 削除実行

```bash
# 元のリポジトリに移動してから削除
cd <original-repo-path>

# workspace + bookmark を削除（推奨）
jwq-remove -b feature-xxx

# workspace のみ削除（bookmarkは残す）
jwq-remove feature-xxx
```

### 3.3 強制削除（未コミット変更がある場合）

ユーザー確認必須:

```bash
jwq-remove -f feature-xxx
```

## 4. ハマりどころ・注意点

### 4.1 新規ブランチをリモートにpushする

新しいブックマーク（ブランチ）をリモートに初めてpushする際、トラッキング設定が必要:

```bash
# ブックマーク作成
jj bookmark create feat/xxx

# リモートにトラッキング設定してpush
jj bookmark track feat/xxx --remote=origin
jj git push --branch feat/xxx
```

または自動トラッキングを設定（推奨）:

```toml
# ~/.config/jj/config.toml に追加
[remotes.origin]
track-managed-bookmarks = "all"
```

これにより、新規ブックマークが自動でリモートにトラッキングされる。

**注意**: `--allow-new` フラグは非推奨。上記の方法を使用すること。

### 4.2 colocated化後のリモートブックマークトラッキング

`jj git init --colocate` 後、リモートブランチをトラッキングしないとpull時に更新されない:

```bash
# mainブランチをトラッキング（必須）
jj bookmark track main --remote=origin

# 他のブランチも必要に応じて
jj bookmark track feat/xxx --remote=origin
```

### 4.3 describeしてからpush

gitと違い、jjは変更を自動的に追跡する。pushする前に `describe` で説明を付ける:

```bash
# 変更に説明を付ける（gitのcommit -mに相当）
jj describe -m "feat: add new feature"

# その後push
jj git push --branch feat/xxx
```

## 5. トラブルシューティング

### 全workspace一覧確認

```bash
jwq-list -g
```

### workspace状態確認

```bash
jwq-status -g
```

## 6. jj vs git コマンド対応表

| 操作                 | jj                          | git                    |
| -------------------- | --------------------------- | ---------------------- |
| 状態確認             | `jj status`                 | `git status`           |
| 差分確認             | `jj diff`                   | `git diff`             |
| コミット（変更説明） | `jj describe -m "msg"`      | `git commit -m "msg"`  |
| ブランチ作成         | `jj bookmark create name`   | `git branch name`      |
| プッシュ             | `jj git push --branch name` | `git push origin name` |
| フェッチ             | `jj git fetch`              | `git fetch`            |
| ログ確認             | `jj log`                    | `git log`              |
| 新しい変更を作成     | `jj new`                    | (自動)                 |
| 変更の修正           | `jj squash` / `jj edit`     | `git commit --amend`   |

## 7. 既存gitリポジトリのcolocated化

```bash
# リポジトリルートで実行
jj git init --colocate

# .gitignoreに追加（推奨）
echo ".jj/" >> .gitignore
```

**注意**: フラグは `--colocate`（`--colocated`ではない）
