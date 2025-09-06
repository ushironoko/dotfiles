# defu Integration for MCP Server Configuration Merging

## Overview

defuは、UnJSが提供する軽量で高速な再帰的デフォルトプロパティ割り当てライブラリです。MCPサーバー設定のマージにおいて、現在の手動実装をより堅牢で保守性の高い方法に置き換えるために使用できます。

## インストール

```bash
bun add defu
```

## 主要機能

### 1. 基本的なオブジェクトマージ

```javascript
import { defu } from "defu";

// 左側の引数が優先される
const merged = defu(
  { a: { b: 2 } }, // 優先される値
  { a: { b: 1, c: 3 } }, // デフォルト値
);
// 結果: { a: { b: 2, c: 3 } }
```

### 2. 配列の処理

defuの配列処理には特徴があります：

- **配列の連結**: デフォルトプロパティが定義されている場合、配列値を連結します
- **制限事項**: 配列を再帰的にマージすることはできません（オブジェクトのマージ専用）
- **注意点**: 配列内のオブジェクトをマージする場合、lodash.mergeとは異なる動作をします

```javascript
// 配列は連結される
defu({ tags: ["vue"] }, { tags: ["react", "angular"] });
// 結果: { tags: ['vue', 'react', 'angular'] }
```

## API メソッド

### defu(object, ...defaults)

基本的なマージ機能。複数のデフォルトオブジェクトを受け取り、左から右の優先順位でマージします。

```javascript
const result = defu(userConfig, defaultConfig, baseConfig);
```

### createDefu(customMerger)

カスタムマージ戦略を定義できます。MCPサーバーの特殊なマージロジックに有用です。

```javascript
const customMerge = createDefu((obj, key, value) => {
  // mcpServersの場合、重複を防ぐカスタムロジック
  if (key === "mcpServers" && Array.isArray(obj[key])) {
    const existingNames = new Set(obj[key].map((s) => s.name));
    const newServers = value.filter((s) => !existingNames.has(s.name));
    obj[key] = [...obj[key], ...newServers];
    return true; // カスタムマージを適用
  }
  // デフォルトの動作を使用
  return false;
});
```

### defuFn(object, defaults)

関数値の処理に特化。設定の動的な処理に使用できます。

```javascript
const config = defuFn(
  {
    filter: (val) => val.filter((item) => item.active),
  },
  {
    filter: [
      { name: "server1", active: true },
      { name: "server2", active: false },
    ],
  },
);
```

### defuArrayFn(object, defaults)

配列値のみに関数処理を適用。

```javascript
const config = defuArrayFn(
  {
    servers: (arr) => arr.map((s) => ({ ...s, enabled: true })),
  },
  {
    servers: [{ name: "server1" }, { name: "server2" }],
  },
);
```

## MCPサーバーマージへの適用案

### 現在の実装の問題点

1. 手動での重複チェック
2. 配列の単純な結合による重複の可能性
3. エラーハンドリングの複雑さ

### defuを使用した改善案

```typescript
import { createDefu } from "defu";

// MCPサーバー専用のマージ関数を作成
const mergeMCPConfig = createDefu((obj, key, value) => {
  if (key === "mcpServers" && Array.isArray(obj[key]) && Array.isArray(value)) {
    // 名前ベースで重複を除外
    const existingNames = new Set(obj[key].map((server) => server.name));
    const uniqueNewServers = value.filter(
      (server) => !existingNames.has(server.name),
    );
    obj[key] = [...obj[key], ...uniqueNewServers];
    return true;
  }
  return false;
});

// 使用例
export class MCPMerger {
  async merge(): Promise<void> {
    const sourceConfig = await this.readJSON(this.sourcePath);
    const targetConfig = (await this.readJSON(this.targetPath)) || {};

    // defuを使用したマージ
    const mergedConfig = mergeMCPConfig(targetConfig, sourceConfig);

    await this.writeJSON(this.targetPath, mergedConfig);
  }
}
```

## 利点

1. **型安全性**: TypeScriptの型ユーティリティを提供
2. **セキュリティ**: `__proto__`と`constructor`キーのスキップによるオブジェクト汚染の防止
3. **パフォーマンス**: 軽量で高速（2.3kB gzipped）
4. **柔軟性**: カスタムマージ戦略の定義が可能
5. **保守性**: UnJSエコシステムの一部として活発にメンテナンスされている

## 注意事項

1. **配列の再帰的マージ不可**: 配列内のオブジェクトは期待通りにマージされない可能性がある
2. **左優先**: 左側の引数が常に優先される（通常のdefaultsとは逆）
3. **immutability**: 元のオブジェクトを変更する可能性があるため、必要に応じてクローンを作成

## 実装時の考慮点

### 1. エラーハンドリング

```typescript
try {
  const merged = mergeMCPConfig(target, source);
} catch (error) {
  console.error("Failed to merge MCP configurations:", error);
  // フォールバック処理
}
```

### 2. バックアップの統合

```typescript
// マージ前にバックアップを作成
await this.backupManager.backup(this.targetPath);
const merged = mergeMCPConfig(target, source);
await this.writeJSON(this.targetPath, merged);
```

### 3. バリデーション

```typescript
// マージ後の検証
const validateMCPConfig = (config: any): boolean => {
  return config.mcpServers?.every((server) => server.name && server.command);
};

const merged = mergeMCPConfig(target, source);
if (!validateMCPConfig(merged)) {
  throw new Error("Invalid MCP configuration after merge");
}
```

## 移行計画

1. **フェーズ1**: defuのインストールと基本的な統合
2. **フェーズ2**: カスタムマージ関数の実装
3. **フェーズ3**: 既存のMCPMergerクラスの更新
4. **フェーズ4**: テストの更新と拡充
5. **フェーズ5**: ドキュメントの更新

## 参考リンク

- [GitHub Repository](https://github.com/unjs/defu)
- [NPM Package](https://www.npmjs.com/package/defu)
- [UnJS Documentation](https://unjs.io/packages/defu)
- [c12での使用例](https://github.com/unjs/c12) - 設定ローダーでの実践的な使用例
