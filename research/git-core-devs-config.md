# Git Core Developers Configuration Recommendations

Source: https://blog.gitbutler.com/how-git-core-devs-configure-git
Author: Scott Chacon
Date: 2025年2月

## 概要

Git コア開発者たちが実際に使用している Git 設定と、デフォルトとして推奨される設定についての記事。2021年の「Spring Cleaning」実験で、Git コア開発者たちがデフォルトの Git を使ってみて、どの設定が本当に必要かを特定した結果に基づいている。

## 推奨設定の分類

### 1. 明らかに Git を改善する設定（Clearly Makes Git Better）

これらの設定はデメリットがほぼなく、Git の使い勝手を明確に向上させる。

#### ブランチ表示の改善
```ini
[column]
    ui = auto                    # カラム形式で表示
[branch]
    sort = -committerdate        # 最新のコミット順でソート（アルファベット順ではなく）
```

#### タグ表示の改善
```ini
[tag]
    sort = version:refname       # バージョン番号として適切にソート（0.5.101 が 0.5.1000 の前に来る）
```

#### デフォルトブランチ名
```ini
[init]
    defaultBranch = main         # 新規リポジトリのデフォルトブランチ名
```

#### より良い diff
```ini
[diff]
    algorithm = histogram        # Myers (1986年) より新しく賢いアルゴリズム
    colorMoved = plain          # 移動したコードを異なる色で表示
    mnemonicPrefix = true       # a/b の代わりに i/ (index), w/ (working) などを使用
    renames = true              # ファイル名変更を検出
```

#### より良い push
```ini
[push]
    default = simple            # Git 2.0 以降のデフォルト
    autoSetupRemote = true      # 自動的にアップストリームを設定（--set-upstream 不要に）
    followTags = true           # push 時にローカルタグも送信
```

#### より良い fetch
```ini
[fetch]
    prune = true               # サーバーから削除されたブランチをローカルでも削除
    pruneTags = true           # サーバーから削除されたタグも削除
    all = true                 # すべてのリモートから取得
```

### 2. なぜやらない？（Why the Hell Not?）

害はなく、時々役立つ設定。

#### 自動修正プロンプト
```ini
[help]
    autocorrect = prompt       # タイプミスしたコマンドを推測して実行を提案
```

#### コミット時に diff を表示
```ini
[commit]
    verbose = true            # コミットメッセージ作成時に diff を表示
```

#### 競合解決の再利用
```ini
[rerere]
    enabled = true            # 解決済みの競合を記録
    autoupdate = true         # 同じ競合を自動的に解決
```

#### グローバル ignore ファイル
```ini
[core]
    excludesfile = ~/.gitignore  # グローバルな .gitignore
```

#### より良い rebase
```ini
[rebase]
    autoSquash = true         # fixup! や squash! コミットを自動的に処理
    autoStash = true          # rebase 前に自動的に stash
    updateRefs = true         # スタックされた ref も一緒に移動
```

### 3. 好みの問題（A Matter of Taste）

人によって好みが分かれる設定。

#### マージ競合の表示方法
```ini
[merge]
    conflictstyle = zdiff3    # 競合マーカーにベース（共通祖先）も表示
    # Git 2.35 未満の場合は 'diff3' を使用
```

#### pull の動作
```ini
[pull]
    rebase = true            # pull 時に merge ではなく rebase を使用
```

#### ファイルシステムモニター（大規模リポジトリ向け）
```ini
[core]
    fsmonitor = true         # ファイル変更を監視（git status を高速化）
    untrackedCache = true    # 未追跡ファイルのキャッシュ
```

## Spring Cleaning 実験の結果

2021年に Git メーリングリストで行われた実験で、コア開発者たちが提案した設定：

1. `merge.conflictstyle = zdiff3`
2. `rebase.autosquash = true`
3. `rebase.autostash = true`
4. `commit.verbose = true`
5. `diff.colorMoved = true`
6. `diff.algorithm = histogram`
7. `grep.patternType = perl`
8. `feature.experimental = true`
9. `branch.sort = committerdate`

これらの設定は3-4年経った今でもデフォルトにはなっていないが、多くの Git 開発者たちはこれらなしでは Git を使いづらいと感じている。

## 完全な推奨設定

```ini
# 明らかに Git を改善する設定
[column]
    ui = auto
[branch]
    sort = -committerdate
[tag]
    sort = version:refname
[init]
    defaultBranch = main
[diff]
    algorithm = histogram
    colorMoved = plain
    mnemonicPrefix = true
    renames = true
[push]
    default = simple
    autoSetupRemote = true
    followTags = true
[fetch]
    prune = true
    pruneTags = true
    all = true

# なぜやらない？
[help]
    autocorrect = prompt
[commit]
    verbose = true
[rerere]
    enabled = true
    autoupdate = true
[core]
    excludesfile = ~/.gitignore
[rebase]
    autoSquash = true
    autoStash = true
    updateRefs = true

# 好みの問題（必要に応じてコメントアウトを解除）
[core]
    # fsmonitor = true
    # untrackedCache = true
[merge]
    # conflictstyle = zdiff3  # Git 2.35 以降
    # conflictstyle = diff3    # Git 2.35 未満
[pull]
    # rebase = true
```