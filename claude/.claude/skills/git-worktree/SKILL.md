---
name: git-worktree
description: Git worktreeを使用した並行作業管理。実装開始時にworktreeを作成し、完了時に削除する。
---

# Git Worktree Management

実装作業をメインリポジトリから分離し、worktreeで作業する。

## 1. Worktree 作成

### 1.1 現在の状態確認

```bash
# ブランチ名を取得
git branch --show-current

# リポジトリ名を取得
basename "$(git rev-parse --show-toplevel)"

# 既存のworktree一覧を確認
git worktree list
```

### 1.2 Worktree 作成・移動

```bash
# 変数設定
REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")
BRANCH_NAME=$(git branch --show-current)
WORKTREE_PATH="../${REPO_NAME}-${BRANCH_NAME}"

# 現在のブランチでworktreeを作成
git worktree add "$WORKTREE_PATH"

# worktreeに移動
cd "$WORKTREE_PATH"

# 依存関係インストール（lock fileを検出）
if [ -f "bun.lockb" ]; then
    bun install
elif [ -f "pnpm-lock.yaml" ]; then
    pnpm install
fi
```

### 1.3 新規ブランチでworktree作成

```bash
# 新しいブランチを指定してworktree作成
git worktree add -b feature/new-feature "../${REPO_NAME}-feature-new-feature"
```

### 1.4 同名worktreeが存在する場合

```bash
# 番号を付与して作成
WORKTREE_PATH="../${REPO_NAME}-${BRANCH_NAME}-2"
git worktree add "$WORKTREE_PATH"
```

## 2. 作業中の注意

- worktree内で作業を継続する
- コミット・プッシュは通常通り実行可能
- 各Bashコマンドで `cd "$WORKTREE_PATH" &&` を先頭に付けるか、絶対パスを使用する

## 3. 作業完了後

### 3.1 削除前確認

ユーザーに以下を確認する:

- 「worktree作業が完了しました。削除してよろしいですか？」
- 未コミットの変更がある場合は警告を表示

```bash
# 未コミット変更の確認
cd "$WORKTREE_PATH" && git status --porcelain
```

### 3.2 削除実行

```bash
# 元のリポジトリに移動
ORIGINAL_REPO=$(git rev-parse --show-toplevel)/../${REPO_NAME}
cd "$ORIGINAL_REPO"

# worktreeを削除
git worktree remove "$WORKTREE_PATH"

# 削除確認
git worktree list
```

### 3.3 強制削除（未コミット変更がある場合）

ユーザー確認必須:

```bash
git worktree remove --force "$WORKTREE_PATH"
```

## 4. トラブルシューティング

### ブランチがロックされている場合

```bash
# ロック状態を確認
git worktree list --porcelain

# ロック解除
git worktree unlock "$WORKTREE_PATH"
```

### worktreeが残っている場合

```bash
# pruneで不要な参照を削除
git worktree prune
```
