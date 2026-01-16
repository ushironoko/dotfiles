---
name: plan-hearing
description: Plan mode時の効率的なヒアリングを支援するスキル。4フェーズの構造化された質問でより堅牢なプランを構築する。
---

# Plan Hearing Guide

Plan mode時に効率的なヒアリングを行い、堅牢なプランを構築するためのガイド。

## 必須ヒアリングフェーズ

ExitPlanMode前に、以下の4フェーズを**必ず順番に**実施する：

### Phase 1: 目標確認

ユーザーが達成したい目標を明確にする。

**質問例:**

- header: "目標確認"
- question: "この実装で達成したい目標は以下のどれですか？"
- options:
  - 「新機能追加」- 既存にない機能を追加する
  - 「バグ修正」- 既存の不具合を修正する
  - 「リファクタリング」- 動作を変えずにコードを改善する
  - 「パフォーマンス改善」- 速度やリソース効率を向上させる

### Phase 2: 技術選択

実装に使用する技術的アプローチを決定する。

**質問例:**

- header: "技術選択"
- question: "○○の実装にどのアプローチを使用しますか？"
- options: 各アプローチ名 + トレードオフを説明
  - 「アプローチA (推奨)」- シンプルだが拡張性は低い
  - 「アプローチB」- 複雑だが拡張性が高い
  - 「アプローチC」- 既存パターンに準拠

### Phase 3: 命名パターン

関数名、変数名、ファイル名などの命名規則を確認する。

**質問例:**

- header: "命名規則"
- question: "新規追加する関数/ファイルの命名パターンはどれが良いですか？"
- options: 具体的な命名候補を提示
  - 「createUser / user-service.ts」- 動詞+名詞パターン
  - 「userFactory / UserFactory.ts」- Factoryパターン
  - 「useUser / use-user.ts」- Hooks風パターン

### Phase 4: 補足情報（自由入力）

ユーザーから追加の要件や考慮事項を収集する。

**質問例:**

- header: "補足情報"
- question: "その他、考慮すべき要件や制約はありますか？"
- options:
  - 「特になし」- 上記の確認事項で十分
  - 「パフォーマンス要件あり」- 具体的な要件を入力
  - 「既存コードとの互換性」- 互換性の詳細を入力
  - 「その他」- 自由入力で補足

## AskUserQuestionの使い方

### 質問の構造化

| フィールド  | 使い方                                                   |
| ----------- | -------------------------------------------------------- |
| header      | 12文字以内でフェーズを示す（例: "目標確認", "技術選択"） |
| question    | 明確で具体的な質問。「〜ですか？」で終わる               |
| options     | 2-4個の選択肢。最初に推奨を置き「(推奨)」を付ける        |
| description | 各選択肢の影響やトレードオフを説明                       |
| multiSelect | Phase 4の補足情報など複数選択可能な場合はtrue            |

### 4フェーズ一括質問の例

AskUserQuestionは最大4問まで同時に質問できるため、4フェーズを1回の呼び出しで実施可能：

```json
{
  "questions": [
    {
      "question": "この実装で達成したい主な目標は何ですか？",
      "header": "目標確認",
      "options": [
        { "label": "新機能追加", "description": "ユーザー認証機能を新規実装" },
        {
          "label": "既存機能の拡張",
          "description": "現在のログイン機能にSSO対応を追加"
        },
        {
          "label": "リファクタリング",
          "description": "認証ロジックの整理・改善"
        }
      ],
      "multiSelect": false
    },
    {
      "question": "認証方式としてどのアプローチを使用しますか？",
      "header": "技術選択",
      "options": [
        { "label": "JWT (推奨)", "description": "ステートレスで拡張性が高い" },
        {
          "label": "Session",
          "description": "シンプルだがサーバー側で状態管理が必要"
        },
        { "label": "OAuth2.0", "description": "外部プロバイダ連携に最適" }
      ],
      "multiSelect": false
    },
    {
      "question": "認証関連の関数・ファイルの命名パターンはどれが良いですか？",
      "header": "命名規則",
      "options": [
        {
          "label": "authenticate / auth-service.ts",
          "description": "動詞ベースのシンプルな命名"
        },
        {
          "label": "useAuth / use-auth.ts",
          "description": "React Hooks風の命名"
        },
        {
          "label": "AuthManager / AuthManager.ts",
          "description": "クラス風の命名（関数で実装）"
        }
      ],
      "multiSelect": false
    },
    {
      "question": "その他、考慮すべき要件や制約はありますか？",
      "header": "補足情報",
      "options": [
        { "label": "特になし", "description": "上記の確認で十分" },
        {
          "label": "既存DBスキーマに制約あり",
          "description": "詳細を自由入力で補足"
        },
        {
          "label": "パフォーマンス要件あり",
          "description": "詳細を自由入力で補足"
        }
      ],
      "multiSelect": true
    }
  ]
}
```

## ヒアリングのチェックリスト

ExitPlanMode前に以下を確認：

- [ ] Phase 1: ユーザーの目標を明確に理解したか
- [ ] Phase 2: 技術的選択肢を提示し、決定を仰いだか
- [ ] Phase 3: 命名パターンを確認したか
- [ ] Phase 4: 補足情報を収集する機会を提供したか

## アンチパターン

避けるべき質問の仕方：

1. **フェーズのスキップ**: 4フェーズすべてを実施せずにExitPlanMode → 必ず全フェーズ実施
2. **曖昧な質問**: 「これでいいですか？」→ 具体的に何を確認したいか明示
3. **選択肢なし**: 自由回答のみ → 選択肢を提示して判断を容易に
4. **技術用語の羅列**: → ユーザーが理解できる言葉で説明
