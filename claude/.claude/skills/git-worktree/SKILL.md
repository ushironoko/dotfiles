---
name: git-worktree
description: "[DEPRECATED] Git worktreeを使用した並行作業管理。jj-workspaceスキルへ移行してください。"
---

> **⚠️ DEPRECATED**: このスキルは非推奨です。代わりに `jj-workspace` スキルを使用してください。
> Jujutsu (jj) はgit互換のcolocatedモードで動作し、より効率的なワークフローを提供します。
>
> 移行方法: `/jj-workspace` を参照

# Git Worktree Management (gwq)

軽微な修正以外の実装作業は、gwqを使ってworktreeで作業する。

## 0. 前提条件

- gwqはmise管理によりインストール済み
- 参考: https://github.com/d-kuro/gwq

## 1. Worktree 作成

### 1.1 既存worktree確認

```bash
gwq list
```

### 1.2 新規ブランチでworktree作成（推奨）

```bash
# 新規ブランチ + worktree を作成
gwq add -b feature/xxx

# 作成後、worktreeに移動
cd $(gwq get feature/xxx)
```

### 1.3 現在のブランチでworktree作成

```bash
gwq add
cd $(gwq get <branch-name>)
```

### 1.4 依存関係インストール

```bash
# lock fileを検出してインストール
if [ -f "bun.lockb" ]; then
    bun install
elif [ -f "pnpm-lock.yaml" ]; then
    pnpm install
fi
```

## 2. 作業中

### 2.1 worktree内でコマンド実行

```bash
# cdなしでworktree内でコマンド実行
gwq exec feature/xxx -- bun test
gwq exec feature/xxx -- bun run lint
gwq exec feature/xxx -- bun run tsc
```

### 2.2 変更状態確認

```bash
gwq status
```

### 2.3 注意事項

- worktree内で作業を継続する
- コミット・プッシュは通常通り実行可能
- 各Bashコマンドは worktree ディレクトリ内で実行する

## 3. 作業完了後

### 3.1 削除前確認

ユーザーに以下を確認する:

- 「worktree作業が完了しました。削除してよろしいですか？」

```bash
# 変更状態を確認
gwq status
```

### 3.2 削除実行

```bash
# 元のリポジトリに移動してから削除
cd <original-repo-path>

# worktree + ブランチを削除（推奨）
gwq remove -b feature/xxx

# worktree のみ削除（ブランチは残す）
gwq remove feature/xxx
```

### 3.3 強制削除（未コミット変更がある場合）

ユーザー確認必須:

```bash
gwq remove -f feature/xxx
```

## 4. トラブルシューティング

### 不要なworktree参照を削除

```bash
gwq prune
```

### 全worktree一覧確認

```bash
gwq list
```
