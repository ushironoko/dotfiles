---
name: bit-coordination
description: "worktreeのライフサイクル管理とbit issueによるpeer-to-peer作業公開。worktreeで作業するすべてのセッションがTarget Filesを宣言し、セッション間のファイル競合を回避する。"
---

# Bit Coordination: Worktree + Peer-to-Peer 作業公開

軽微な修正以外の実装作業はworktreeで作業ディレクトリを分離し、bit issueで作業範囲を公開する。このスキルはworktreeで作業するすべてのセッションに適用される。orchestrator/workerの区別はない。

各セッションがbit issueでTarget Filesを宣言し、他セッションから作業範囲が見えるようにする。git worktreeは同一の `.git` を共有するため、どのworktreeからも同じbit issueが即座に参照・更新できる。

### アーキテクチャ

```
┌──────────────────────────────────────────────┐
│            .git (全worktree共有)              │
│      refs/notes/bit-hub ← bit issue データ   │
└──────┬──────────────────────────┬─────────────┘
       │                          │
┌──────┴──────┐            ┌──────┴──────┐
│ Session A   │            │ Session B   │
│ (独立起動)  │            │ (独立起動)  │
│             │            │             │
│ bit issue   │◄──────────►│ bit issue   │
│ create/list │  共有参照  │ create/list │
└─────────────┘            └─────────────┘
```

### 棲み分け

| 仕組み      | 用途                                         | スコープ                       |
| ----------- | -------------------------------------------- | ------------------------------ |
| agent-teams | タスク分配・進捗管理・チーム内メッセージング | リーダーが起動したセッション内 |
| bit issue   | Target Files宣言・ファイル競合回避           | 全worktreeセッション横断       |

### セッション状態遷移

```
  EnterWorktree           bit issue create
 ┌──────────┐          ┌──────────────┐
 │ worktree │─────────►│ issue create │
 │  作成    │          │ (Target宣言) │
 │ (hook)   │          └──────┬───────┘
 └──────────┘                 │
                    issue list (レース対策)
                              │
                       ┌──────▼───────┐
                  ┌───►│   作業中     │◄───┐
                  │    └──────┬───────┘    │
                  │           │            │
            スコープ変更    完了前確認   重複検知
            (§3再実行)     (issue list)  → 調整
                  │           │            │
                  └───────────┤            │
                              │            │
                       ┌──────▼───────┐    │
                       │ issue close  │────┘
                       └──────┬───────┘
                              │
                       ┌──────▼───────┐
                       │ worktree削除 │
                       │ (hook)       │
                       └──────────────┘
```

### bit issue ライフサイクル

```
 create                  comment add             close
   │                     (進捗/調整)               │
   ▼                         │                     ▼
┌──────┐  comment add   ┌───▼──┐  comment add  ┌──────┐
│ open │────────────────►│ open │───────────────►│closed│
│      │  (Target追加)   │      │  (完了サマリ) │      │
└──────┘                 └──────┘               └──────┘
                             │
                      ┌──────▼───────┐
                      │ orphan検知時 │
                      │ → 除外扱い  │
                      └──────────────┘

 ※ issueの状態は open / closed の2値のみ。
   commentで作業内容の変遷を記録する。
```

## 0. 前提条件

### worktreeのライフサイクルはhookが管理する

worktreeの作成・削除は Claude Code の `EnterWorktree` / `WorktreeRemove` hookが自動実行する。gwqコマンドを直接実行する必要はない。

| hook           | 実行内容                                       |
| -------------- | ---------------------------------------------- |
| WorktreeCreate | `gwq add -b <name>` → worktree絶対パス返却     |
| WorktreeRemove | ブランチ逆引き → `gwq remove -f -b` で完全削除 |

worktree作成後は依存関係をインストールする:

```bash
# lock fileを検出してインストール
if [ -f "bun.lockb" ]; then
    bun install
elif [ -f "pnpm-lock.yaml" ]; then
    pnpm install
fi
```

### bit存在チェック

```bash
command -v bit &>/dev/null && echo "bit: available" || echo "bit: not found"
```

- **不在時**: 単独作業モード。worktreeで作業し、「bit未検出のため協調はスキップ」と通知。以降のbit関連プロトコルはすべてスキップ。
- **存在時**: `bit issue init 2>/dev/null`（初回のみ）を実行し、以降のプロトコルに従う。

### CRITICAL: worktree内でのbit操作には GIT_DIR が必要

git worktreeでは `.git` がディレクトリではなくファイル（メイン `.git` へのポインタ）になる。bit CLIは `.git` ディレクトリを前提としているため、**worktree内でbit issueコマンドをそのまま実行するとエラーになる**。

```bash
# NG: worktree内でそのまま実行
bit issue list --open
# → "path exists and is not dir: ./.git"

# OK: GIT_DIR でメインリポジトリの .git を指定
GIT_DIR="<main-repo-path>/.git" bit issue list --open
```

メインリポジトリのパスは `git worktree list` の最初の行から取得できる:

```bash
MAIN_GIT="$(git worktree list --porcelain | head -1 | sed 's/^worktree //')/.git"
GIT_DIR="$MAIN_GIT" bit issue create ...
```

**注意**: bit CLIは日本語の title/body が文字化けする場合がある。issue内容は英語で記述するか、日本語が必要な場合はASCII以外の部分が化ける可能性を許容する。

### CRITICAL: 使用禁止コマンド

以下のコマンドはrelay server経由でネットワーク通信を行う。private repoで実行するとリポジトリ内容が外部に漏洩するため、**絶対に実行してはならない**:

| 禁止コマンド                                       | 理由                             |
| -------------------------------------------------- | -------------------------------- |
| `bit issue claim` / `unclaim` / `claims` / `watch` | relay server経由の排他制御・監視 |
| `bit issue import` / `bit pr import`               | GitHub APIへの接続               |
| `bit relay serve` / `bit relay sync`               | リポジトリ内容のrelay公開・同期  |
| `bit clone relay+*`                                | relay経由のクローン              |

`settings.json` の `permissions.deny` でも禁止済み。

### 使用可能コマンド（ローカル操作のみ）

- `bit issue init` / `create` / `list` / `view` / `update` / `close` / `reopen`
- `bit issue comment add` / `comment list`
- `bit issue search`

## 1. Planファイルの取得

worktreeはmainとファイルシステムが分離される。planファイルは `.gitignore` 対象のためgit showでは取得できない。以下の手順でメインリポジトリ上のplanファイルを読み取る。

1. セッション中にplanファイルのパスが残っていればそれを使う
2. 残っていなければ、settings.jsonの `plansDirectory`（デフォルト: `./plans`）を参照し、メインリポジトリの絶対パスと組み合わせて最新ファイルを特定する

```bash
# メインリポジトリのplansディレクトリから最新ファイルを取得
ls -t <main-repo-path>/plans/*.md 2>/dev/null | head -1
```

planファイルが存在しない場合（plan modeを使わなかった軽微な作業）はPlanセクションを省略する。

**重要**: planファイルの読み取りは **worktreeに移動する前** に行うのが最も確実。移動後でもメインリポジトリの絶対パスでアクセスは可能。

## 2. 作業公開プロトコル

worktree作成直後に `TaskCreate` でタスクを作成し、返された `task_id` をbit issue titleに埋め込む。これにより TaskCompleted hook がbit issueを自動特定・closeできる。

### TaskCreate → bit issue create の手順

1. `TaskCreate` ツールでタスクを作成し、`task_id` を取得する
2. bit issue create の `--title` に `[task:<branch-name>:<task_id>]` を埋め込む

`<branch-name>` を含めることで、複数セッションが同じ連番task_idを持っても衝突しない。

agent-teamsでチームメイトとして起動された場合、リーダーが作成した `task_id` がセッションに存在するので、それを使う。

worktree内で実行する場合は `GIT_DIR` を指定する（§0参照）。

```bash
# GIT_DIRの取得（worktree内で実行する場合）
MAIN_GIT="$(git worktree list --porcelain | head -1 | sed 's/^worktree //')/.git"

# 1. TaskCreateでタスク作成 → task_id取得（ツール呼び出し）
# 2. bit issue createでbranch名+task_idをtitleに埋め込む
GIT_DIR="$MAIN_GIT" bit issue create \
  --title "[task:<branch-name>:<task_id>] <task summary in English>" \
  --label "session:<branch-name>" \
  --body "$(cat <<'BODY'
## Session Info

- **branch**: <branch-name>
- **worktree**: <worktree-absolute-path>
- **main repo**: <main-repo-absolute-path>

## Target Files

- path/to/file.ts (modify|create|delete)

## Task Description

<task description>

## Plan

<planファイルの内容を完全コピー>
BODY
)"
```

- branch名でセッションを識別する（pid/agent-idは不要）
- issueのopen/closedで作業状態を管理する
- **Planセクションにはplanファイルの全文を含める**。セッション再開時に唯一のコンテキスト復元手段となる
- **worktreeパスは絶対パスで記載する**。orphan検知やセッション再開時のcd先として使う

## 3. 他セッション認識プロトコル

以下の3つのタイミングで他セッションの作業範囲を確認する:

1. **作業開始時**: issue create直後に `bit issue list --open` で再確認（同時宣言レース対策）
2. **スコープ変更時**: 予定外ファイル変更が必要になった場合
3. **作業完了前**: close前の最終確認

### 同時宣言レース対策

2セッションがほぼ同時にissueを作成すると、双方が「重複なし」と判断するリスクがある。create後に必ず `bit issue list --open` で再確認し、作成直後に他セッションのissueが増えていたら重複検知を再実行する。

```bash
# worktree内ではGIT_DIR指定（§0参照）
GIT_DIR="$MAIN_GIT" bit issue list --open     # 全openのissue一覧
GIT_DIR="$MAIN_GIT" bit issue view <id>       # Target Files確認
```

## 4. 重複検知・自律調整

### 判断マトリクス

```
重複度 = |自分のTarget Files ∩ 他のTarget Files| / |自分のTarget Files|

- 0%:       そのまま作業
- 50%未満:  重複ファイルを除外、comment記録
- 50%以上:  ユーザーに確認（peer-to-peerなのでorchestratorはいない）
```

### Target Files動的更新

- 他セッション管轄のファイル → 変更を避け別アプローチを検討
- 誰の管轄でもないファイル → Target Filesに追加し、commentに記録

```bash
GIT_DIR="$MAIN_GIT" bit issue comment add <id> --body "Target Files added: path/to/new-file.ts (modify) - reason: ..."
```

## 5. 作業完了プロトコル

以下の順序で完了処理を行う。bit issue close → worktree削除の順序を厳守する（issueがopenのまま削除されるとorphanになる）。

### TaskCompleted hookによる自動close

`TaskUpdate(task_id, completed)` を呼ぶと TaskCompleted hookが発火し、bit issueを自動でcomment + closeする:

- hookは `[task:<branch>:<task_id>]` をtitleに含むopen issueを検索し、comment add + closeを実行する
- hookは非同期（async）実行のためメインagentをブロックしない
- **推奨フロー**: `TaskUpdate` で完了マーク → hookが自動close → worktree削除

### フォールバック（hookが失敗した場合）

hookが失敗してもエラーにはならない（async実行）。issueがopenのまま残った場合は手動でcloseする:

```bash
# worktree内ではGIT_DIR指定（§0参照）

# 1. 完了サマリを記録
GIT_DIR="$MAIN_GIT" bit issue comment add <id> --body "Done: <summary of changes>"

# 2. issueをclose
GIT_DIR="$MAIN_GIT" bit issue close <id>

# 3. worktree削除（WorktreeRemove hookが自動実行）
```

## 6. agent-teamsとの併用

- **agent-teams**: セッション内タスク管理（共有タスクリスト + メッセージング）
- **bit issue**: セッション間Target Files宣言（ファイル競合回避）
- **併用ルール**: agent-teamsのチームメイトもworktree作業時はbit issueを作成する。外部の独立セッションからもチームメイトの作業が見えるようになる。

### task_id連携

- チームメイトがbit issue createする際、リーダーから渡された `task_id` をtitleに `[task:<branch-name>:<task_id>]` として埋め込む
- チームメイトのターン終了時にもTaskCompletedが自動発火し、対応するbit issueがcloseされる

## 7. 動作例

### 例1: 単独セッション（基本フロー）

他セッションがいない場合でも、後から別セッションが起動する可能性があるため必ずissueを作成する。

```
Session A:
  # 1. worktree移動前にplanファイルを読み取る
  Read: /Users/user/project/plans/add-validation.md
  → planの内容を保持

  # 2. EnterWorktreeでworktree作成（hookがgwq add -bを実行）
  → /Users/user/.worktrees/feat/add-validation に移動

  # 3. 依存関係インストール
  bun install

  # 4. GIT_DIR取得 + issue作成（plan全文を含む）
  MAIN_GIT="$(git worktree list --porcelain | head -1 | sed 's/^worktree //')/.git"
  GIT_DIR="$MAIN_GIT" bit issue create \
    --title "[task:feat/add-validation:1] Add input validation" \
    --label "session:feat/add-validation" \
    --body "
      ## Session Info
      - branch: feat/add-validation
      - worktree: /Users/user/.worktrees/feat/add-validation
      - main repo: /Users/user/project

      ## Target Files
      - src/utils/validate.ts (create)
      - src/commands/install.ts (modify)

      ## Task Description
      Add input validation for CLI commands

      ## Plan
      (planファイルの全文)
    "

  # 5. 他セッション確認
  GIT_DIR="$MAIN_GIT" bit issue list --open
  → #1 Add input validation [session:feat/add-validation]  ← 自分のみ

  ... 作業 ...

  # セッション再開時: GIT_DIR="$MAIN_GIT" bit issue view 1 で全コンテキスト復元可能

  # 6. 完了 → close → worktree削除
  GIT_DIR="$MAIN_GIT" bit issue comment add 1 --body "Done: validate.ts created, install.ts updated"
  GIT_DIR="$MAIN_GIT" bit issue close 1
  # WorktreeRemove hookがgwq removeを実行
```

### 例2: 2セッション並行（重複なし）

Target Filesが被らないため、互いに干渉せず作業できる。

```
Session A:                                Session B:
  bit issue create                          bit issue create
    "Improve CLI parser"                      "Increase test coverage"
    Target: src/cli/parser.ts                 Target: tests/core/*.test.ts
    → issue #2                                → issue #3
       │                                         │
  bit issue list --open                     bit issue list --open
  → #2 CLI parser (self)                    → #2 CLI parser (Session A)
  → #3 test coverage (Session B)            → #3 test coverage (self)
       │                                         │
  overlap = 0% → proceed                    overlap = 0% → proceed
       │                                         │
  bit issue close #2                        bit issue close #3
```

### 例3: 2セッション並行（重複あり → 調整）

Target Filesが被った場合のセッション側の判断と調整。

```
Session A:                                Session B:
  bit issue create                          bit issue create
    "Unify error handling"                    "Improve logging"
    Target:                                   Target:
      src/core/symlink-manager.ts               src/core/symlink-manager.ts  ← overlap!
      src/core/backup-manager.ts                src/utils/logger.ts
    → issue #4                                → issue #5
       │                                         │
  bit issue list --open                     bit issue list --open
  → #4 (self), #5 (Session B)              → #4 (Session A), #5 (self)
       │                                         │
  bit issue view #5                         bit issue view #4
  → symlink-manager.ts overlaps!            → symlink-manager.ts overlaps!
       │                                         │
  overlap = 1/2 = 50%                       overlap = 1/2 = 50%
  → ask user                                → ask user
       │                                         │
       ▼                                         ▼
  User: "A owns symlink-manager.ts"         User: "leave symlink-manager.ts to A"
       │                                         │
  proceed as-is                             bit issue comment add #5
                                              "Excluded symlink-manager.ts, logger.ts only"
```

### 例4: agent-teams併用

リーダーがチームメイトをworktreeで起動する場合。各チームメイトが独立にbit issueを作成するため、外部セッションからも見える。

```
┌─ Leader Session ─────────────────────────────┐
│ agent-teams でチームメイト A, B を起動        │
│                                               │
│  Teammate A (worktree: feat/api)              │
│    bit issue #6: "Implement API"              │
│    Target: src/api/*.ts                       │
│                                               │
│  Teammate B (worktree: feat/ui)               │
│    bit issue #7: "Implement UI"               │
│    Target: src/components/*.tsx               │
└───────────────────────────────────────────────┘

┌─ External Session C (独立起動) ──────────────┐
│ bit issue list --open                         │
│ → #6 Implement API [session:feat/api]         │
│ → #7 Implement UI [session:feat/ui]           │
│                                               │
│ → チームの作業範囲が見え、重複を回避できる   │
└───────────────────────────────────────────────┘
```

## 8. 異常系

- **bit操作失敗**: ユーザーに「協調機能が無効化されています。他セッションとの重複検知が機能しません」と明示通知し、作業は継続する
- **bit不在**: 単独作業モード（協調スキップを通知）
- **orphan issue**: `gwq list` でworktree存在確認。対応するworktreeが不在ならば重複チェック対象から除外する
- **worktreeの手動トラブルシューティング**: `gwq list`（一覧確認）、`gwq prune`（不要な参照を削除）、`gwq status`（変更状態確認）
