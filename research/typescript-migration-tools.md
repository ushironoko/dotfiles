# TypeScript Migration Tools Research

## 目次
1. [OXC (Oxidation Compiler) - Linter & Formatter](#oxc-oxidation-compiler---linter--formatter)
2. [Gunshi - CLI Framework](#gunshi---cli-framework)
3. [統合例: Dotfiles管理ツール](#統合例-dotfiles管理ツール)

---

## OXC (Oxidation Compiler) - Linter & Formatter

### 概要
OXC (Oxidation Compiler) は、Rustで書かれた高性能なJavaScript/TypeScriptツールセットです。2024年に1.0安定版がリリースされ、ESLintより50-100倍高速な動作を実現しています。

### 主な特徴
- **高速性**: ESLintより50-100倍高速、CPUコア数でスケール
- **TypeScriptサポート**: `.ts`, `.mts`, `.cts`, `.tsx`ファイルを完全サポート
- **570以上のルール**: ESLint、TypeScript-ESLint、各種プラグインから移植
- **型認識リンティング (Preview)**: `oxlint-tsgolint`による型ベースの検査
- **ゼロコンフィグ**: デフォルトで有用なルールが有効

### インストール

```bash
# Bunでのインストール
bun add -D oxlint

# 直接実行
bunx oxlint@latest

# 型認識リンティング用の追加パッケージ
bun add -D oxlint-tsgolint@latest
```

### 設定ファイル: .oxlintrc.json

```json
{
  "plugins": [
    "typescript",
    "import",
    "unicorn"
  ],
  "rules": {
    "no-unused-vars": "warn",
    "no-undef": "error",
    
    // TypeScript専用ルール
    "typescript/no-explicit-any": "error",
    "typescript/no-unused-vars": "warn",
    "typescript/explicit-function-return-type": "off",
    "typescript/no-non-null-assertion": "warn",
    
    // インポート関連
    "import/no-cycle": "error",
    
    // ファイル名規則
    "unicorn/filename-case": ["error", {"case": "kebabCase"}]
  },
  "categories": {
    "correctness": "error",
    "suspicious": "warn",
    "pedantic": "off",
    "perf": "warn",
    "style": "warn"
  },
  "ignorePatterns": [
    "dist/",
    "node_modules/",
    "build/"
  ],
  "files": [
    "**/*.{ts,tsx}",
    {
      "files": ["*.d.ts"],
      "rules": {
        "no-unused-vars": "off"
      }
    }
  ]
}
```

### package.jsonスクリプト

```json
{
  "scripts": {
    "lint": "oxlint",
    "lint:fix": "oxlint --fix",
    "lint:type-aware": "oxlint --type-aware"
  }
}
```

### コマンドライン使用例

```bash
# 基本的なリンティング
bunx oxlint

# 自動修正付き
bunx oxlint --fix

# 特定のディレクトリのみ
bunx oxlint src/

# 型認識リンティング（要oxlint-tsgolint）
bunx oxlint --type-aware

# エラーのみ表示
bunx oxlint --quiet

# 警告をエラーとして扱う
bunx oxlint --deny-warnings
```

---

## Gunshi - CLI Framework

### 概要
Gunshiは、TypeScript向けの型安全なCLIフレームワークです。宣言的な設定、コンポーザブルなサブコマンド、自動的なヘルプ生成が特徴です。

### 主な特徴
- **完全なTypeScriptサポート**: 型安全な引数パース
- **宣言的設定**: コマンドの構造を宣言的に定義
- **コンポーザブル**: サブコマンドの柔軟な組み合わせ
- **遅延ロード**: パフォーマンス向上のための非同期モジュールロード
- **国際化サポート**: 多言語対応の組み込み機能
- **`define`関数による型推論**: 明示的な型注釈なしで完全な型安全性を実現

### インストール

```bash
# Bunでのインストール
bun add gunshi

# TypeScript型定義（Node.js用）
bun add -D @types/node
```

### 基本的な使用例

#### シンプルなCLI（基本版）

```typescript
// src/cli.ts
import { cli } from 'gunshi';

await cli(process.argv.slice(2), {
  name: 'mycli',
  version: '1.0.0',
  description: 'My CLI tool',
  args: {
    name: { 
      type: 'string', 
      short: 'n', 
      description: 'Name to greet',
      required: false 
    },
    verbose: { 
      type: 'boolean', 
      short: 'v', 
      description: 'Verbose output' 
    }
  },
  run: (ctx) => {
    const { name = 'World', verbose } = ctx.values;
    if (verbose) {
      console.log('Verbose mode enabled');
    }
    console.log(`Hello, ${name}!`);
  }
});
```

#### 型安全なCLI（define関数使用）

```typescript
// src/cli.ts - 推奨パターン
import { cli, define } from 'gunshi';

// define関数を使うと型推論が自動的に行われる
const command = define({
  name: 'mycli',
  version: '1.0.0',
  description: 'My CLI tool',
  args: {
    name: { 
      type: 'string', 
      short: 'n', 
      description: 'Name to greet'
      // defaultがないため: string | undefined
    },
    age: {
      type: 'number',
      short: 'a', 
      description: 'Your age',
      default: 30  // defaultがあるため: number (常に値を持つ)
    },
    verbose: { 
      type: 'boolean', 
      short: 'v', 
      description: 'Verbose output'
      // booleanは常にboolean型（--verbose: true, --no-verbose: false, 省略: false）
    }
  },
  run: (ctx) => {
    // ctx.valuesは完全に型付けされる！
    const { name, age, verbose } = ctx.values;
    // TypeScriptが型を認識:
    // - name: string | undefined
    // - age: number
    // - verbose: boolean
    
    let greeting = `Hello, ${name || 'stranger'}!`;
    greeting += ` You are ${age} years old.`;
    
    console.log(greeting);
    
    if (verbose) {
      console.log('Verbose mode enabled.');
      console.log('Parsed values:', ctx.values);
    }
  }
});

await cli(process.argv.slice(2), command);
```

**define関数の利点:**
- `Command`や`CommandContext`などの型のインポート不要
- `ctx`パラメータが自動的に正しい型を取得
- `ctx.values.optionName`でIDEの自動補完とコンパイル時型チェック
- オプションのdefault有無で型が自動調整（undefined対応）

### サブコマンドの実装

#### define関数を使った型安全なサブコマンド（推奨）

```typescript
// src/commands/install.ts
import { define } from 'gunshi';

export const installCommand = define({
  name: 'install',
  description: 'Install dotfiles',
  args: {
    dryRun: {
      type: 'boolean',
      short: 'd',
      description: 'Perform a dry run without making changes',
      default: false
    },
    verbose: {
      type: 'boolean',
      short: 'v',
      description: 'Verbose output',
      default: false
    },
    force: {
      type: 'boolean',
      short: 'f',
      description: 'Force overwrite existing files',
      default: false
    }
  },
  run: async (ctx) => {
    // 型推論により、すべてboolean型として認識される
    const { dryRun, verbose, force } = ctx.values;
    
    if (dryRun) {
      console.log('🔍 Dry run mode - no changes will be made');
    }
    
    if (verbose) {
      console.log('Configuration:', ctx.values);
    }
    
    // インストールロジック
    console.log('Installing dotfiles...');
    
    if (force) {
      console.log('Force mode: overwriting existing files');
    }
  }
});
```

```typescript
// src/commands/restore.ts
import { define } from 'gunshi';

export const restoreCommand = define({
  name: 'restore',
  description: 'Restore from backup',
  args: {
    backup: {
      type: 'string',
      short: 'b',
      description: 'Backup timestamp or path'
      // string | undefined
    },
    interactive: {
      type: 'boolean',
      short: 'i',
      description: 'Interactive mode',
      default: true  // boolean (常にtrue/false)
    },
    partial: {
      type: 'string',
      multiple: true,
      short: 'p',
      description: 'Restore specific files only'
      // string[] | undefined
    }
  },
  run: async (ctx) => {
    // 型が自動推論される
    const { backup, interactive, partial } = ctx.values;
    
    if (backup) {
      console.log(`Restoring from backup: ${backup}`);
    }
    
    if (interactive) {
      console.log('Running in interactive mode...');
      // 対話的選択のロジック
    }
    
    if (partial && partial.length > 0) {
      console.log('Partial restore:', partial);
    }
  }
});
```

### メインCLIエントリポイント

```typescript
// src/index.ts - define関数を使った完全型安全な実装
import { cli, define } from 'gunshi';
import { installCommand } from './commands/install';
import { restoreCommand } from './commands/restore';

// メインコマンドもdefineで定義
const mainCommand = define({
  name: 'dotfiles',
  version: '2.0.0',
  description: 'Dotfiles management tool',
  commands: [
    installCommand,
    restoreCommand
  ],
  // グローバルオプション
  args: {
    config: {
      type: 'string',
      short: 'c',
      description: 'Path to config file',
      default: './config/dotfiles.json'
    },
    verbose: {
      type: 'boolean',
      short: 'v',
      description: 'Verbose output for all commands'
    }
  },
  // デフォルトアクション（コマンドが指定されない場合）
  run: (ctx) => {
    // ctx.valuesは型付けされている
    const { config, verbose } = ctx.values;
    
    if (verbose) {
      console.log(`Using config: ${config}`);
    }
    
    console.log('Dotfiles Manager v2.0.0');
    console.log('Use --help for available commands');
  }
});

async function main() {
  await cli(process.argv.slice(2), mainCommand);
}

main().catch(console.error);
```

### Bunでの実行設定

```typescript
// bin/dotfiles.ts
#!/usr/bin/env bun
import '../src/index';
```

```json
// package.json
{
  "name": "dotfiles",
  "version": "2.0.0",
  "type": "module",
  "bin": {
    "dotfiles": "./bin/dotfiles.ts"
  },
  "scripts": {
    "dev": "bun run src/index.ts",
    "build": "bun build src/index.ts --outdir=dist --target=bun",
    "install:local": "bun link"
  }
}
```

---

## 統合例: Dotfiles管理ツール

### プロジェクト構造

```
dotfiles/
├── src/
│   ├── commands/
│   │   ├── install.ts
│   │   ├── restore.ts
│   │   └── add.ts
│   ├── core/
│   │   ├── config.ts
│   │   ├── symlink.ts
│   │   ├── backup.ts
│   │   └── json-merge.ts
│   ├── utils/
│   │   ├── logger.ts
│   │   ├── fs.ts
│   │   └── paths.ts
│   ├── types/
│   │   └── config.ts
│   └── index.ts
├── config/
│   └── dotfiles.json
├── bin/
│   ├── install.ts  # #!/usr/bin/env bun
│   └── restore.ts  # #!/usr/bin/env bun
├── tests/
│   ├── commands/
│   │   ├── install.test.ts
│   │   └── restore.test.ts
│   └── core/
│       ├── config.test.ts
│       └── symlink.test.ts
├── .oxlintrc.json
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### 型定義

```typescript
// src/types/config.ts
export interface DotfilesConfig {
  mappings: FileMapping[];
  backup: BackupConfig;
  specialHandlers?: SpecialHandler[];
}

export interface FileMapping {
  source: string;
  target: string;
  type: 'file' | 'directory' | 'selective';
  include?: string[];
  exclude?: string[];
  permissions?: Record<string, string>;
}

export interface BackupConfig {
  directory: string;
  keepLast: number;
  compress?: boolean;
}

export interface SpecialHandler {
  name: string;
  mergeFile: string;
  targetFile: string;
  mergeKey: string;
}
```

### コア機能実装例

```typescript
// src/core/config.ts
import { readFile } from 'fs/promises';
import { DotfilesConfig } from '../types/config';
import { expandPath } from '../utils/paths';

export class ConfigManager {
  private config: DotfilesConfig;
  
  async load(path: string): Promise<void> {
    const content = await readFile(path, 'utf-8');
    this.config = JSON.parse(content);
    this.validateConfig();
  }
  
  private validateConfig(): void {
    if (!this.config.mappings || !Array.isArray(this.config.mappings)) {
      throw new Error('Invalid config: mappings must be an array');
    }
    
    for (const mapping of this.config.mappings) {
      if (!mapping.source || !mapping.target) {
        throw new Error('Invalid mapping: source and target are required');
      }
    }
  }
  
  getMappings(): FileMapping[] {
    return this.config.mappings.map(m => ({
      ...m,
      source: expandPath(m.source),
      target: expandPath(m.target)
    }));
  }
  
  getBackupConfig(): BackupConfig {
    return {
      ...this.config.backup,
      directory: expandPath(this.config.backup.directory)
    };
  }
}
```

```typescript
// src/core/symlink.ts
import { symlink, unlink, stat, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { Logger } from '../utils/logger';

export class SymlinkManager {
  constructor(private logger: Logger) {}
  
  async createSymlink(source: string, target: string, options?: {
    dryRun?: boolean;
    force?: boolean;
  }): Promise<void> {
    const { dryRun = false, force = false } = options || {};
    
    // ターゲットディレクトリの作成
    const targetDir = dirname(target);
    await mkdir(targetDir, { recursive: true });
    
    // 既存ファイルのチェック
    try {
      const stats = await stat(target);
      if (stats) {
        if (!force) {
          throw new Error(`Target exists: ${target}`);
        }
        this.logger.warn(`Removing existing: ${target}`);
        if (!dryRun) {
          await unlink(target);
        }
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
    
    // シンボリックリンクの作成
    this.logger.info(`Creating symlink: ${source} -> ${target}`);
    if (!dryRun) {
      await symlink(source, target);
    }
  }
  
  async removeSymlink(target: string, options?: {
    dryRun?: boolean;
  }): Promise<void> {
    const { dryRun = false } = options || {};
    
    const stats = await stat(target);
    if (!stats.isSymbolicLink()) {
      throw new Error(`Not a symlink: ${target}`);
    }
    
    this.logger.info(`Removing symlink: ${target}`);
    if (!dryRun) {
      await unlink(target);
    }
  }
}
```

### package.json設定

```json
{
  "name": "dotfiles",
  "version": "2.0.0",
  "type": "module",
  "bin": {
    "dotfiles": "./bin/dotfiles.ts",
    "dotfiles-install": "./bin/install.ts",
    "dotfiles-restore": "./bin/restore.ts"
  },
  "scripts": {
    "dev": "bun run src/index.ts",
    "test": "vitest",
    "lint": "oxlint",
    "lint:fix": "oxlint --fix",
    "typecheck": "tsc --noEmit",
    "format": "oxlint --fix",
    "build": "bun build src/index.ts --outdir=dist --target=bun"
  },
  "dependencies": {
    "gunshi": "0.3.0",
    "chalk": "5.3.0"
  },
  "devDependencies": {
    "oxlint": "1.0.0",
    "oxlint-tsgolint": "0.1.0",
    "typescript": "5.7.3",
    "vitest": "2.2.1",
    "@types/node": "22.10.6"
  }
}
```

### tsconfig.json設定

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["bun-types"],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

---

## まとめ

### OXC (oxlint) の利点
1. **超高速**: ESLintの50-100倍の速度
2. **ゼロコンフィグ**: デフォルトで有用な設定
3. **TypeScript完全対応**: 型認識リンティング（プレビュー）
4. **段階的移行**: ESLintとの併用が可能

### Gunshi の利点
1. **型安全**: TypeScriptファーストの設計
2. **宣言的**: 直感的なコマンド定義
3. **拡張性**: サブコマンドの柔軟な組み合わせ
4. **Bun対応**: 高速な実行環境での動作

### 推奨される開発フロー
1. Bunをランタイムとして使用
2. OXCでリンティング・フォーマット
3. Gunshiで型安全なCLI構築
4. Vitestでテスト実行
5. GitHub Actionsでの CI/CD 統合