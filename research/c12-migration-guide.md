# c12 Configuration Loader - Migration Guide

## Overview

c12 (pronounced /siːtwelv/, like c-twelve) is a smart configuration loader from the UnJS ecosystem that provides a powerful, TypeScript-friendly approach to managing application configurations.

## Key Features

### Supported File Formats
- `.js`, `.mjs`, `.cjs` - JavaScript modules
- `.ts`, `.mts`, `.cts` - TypeScript modules (via unjs/jiti)
- `.json`, `.jsonc`, `.json5` - JSON variants
- `.yaml`, `.yml` - YAML configuration
- `.toml` - TOML configuration

### Core Capabilities
1. **Multi-format Support**: Load configurations from various file formats
2. **Configuration Merging**: Deep merge with unjs/defu
3. **Environment-specific Configs**: Support for `$test`, `$development`, `$production` keys
4. **Remote Config Extension**: Extend from GitHub/GitLab repositories
5. **Hot Module Replacement**: Watch and auto-reload configurations
6. **TypeScript Support**: Full type safety with TypeScript configs

## Installation

```bash
bun add c12
# or
npm install c12
# or
pnpm add c12
```

## Basic Usage

### Loading Configuration

```typescript
import { loadConfig } from "c12";

// Basic usage
const { config } = await loadConfig({
  name: "dotfiles", // Base configuration name
  cwd: process.cwd(), // Working directory
});

// With all return values
const { 
  config,      // Resolved configuration object
  configFile,  // Path to the loaded config file
  layers       // Array of extended configuration layers
} = await loadConfig({});
```

### Configuration File Names

For a configuration with `name: "dotfiles"`, c12 will look for:
1. `dotfiles.config.ts` / `.js` / `.mjs` / `.cjs`
2. `dotfiles.config.json` / `.jsonc` / `.json5`
3. `dotfiles.config.yaml` / `.yml`
4. `dotfiles.config.toml`
5. `.dotfilesrc` (RC file format)
6. `package.json` (under "dotfiles" key)

## Migration from JSON to TypeScript

### Current JSON Configuration (dotfiles.json)

```json
{
  "mappings": [
    {
      "source": "./shell/.bashrc",
      "target": "~/.bashrc",
      "type": "file"
    }
  ],
  "backup": {
    "directory": "~/.dotfiles_backup",
    "keepLast": 10,
    "compress": false
  }
}
```

### New TypeScript Configuration (dotfiles.config.ts)

```typescript
import { defineConfig } from "./src/types/config";

export default defineConfig({
  mappings: [
    {
      source: "./shell/.bashrc",
      target: "~/.bashrc",
      type: "file"
    }
  ],
  backup: {
    directory: "~/.dotfiles_backup",
    keepLast: 10,
    compress: false
  },
  
  // Environment-specific overrides
  $development: {
    backup: {
      keepLast: 20 // Keep more backups in development
    }
  },
  
  $production: {
    backup: {
      compress: true // Enable compression in production
    }
  }
});
```

## Advanced Features

### 1. Environment-specific Configuration

```typescript
export default {
  logLevel: "info", // Default
  
  $test: {
    logLevel: "silent"
  },
  
  $development: {
    logLevel: "debug"
  },
  
  $production: {
    logLevel: "error"
  },
  
  $env: {
    staging: {
      logLevel: "warning"
    }
  }
};
```

### 2. Configuration Extension

```typescript
export default {
  // Extend from local file
  extends: "./base.config",
  
  // Or extend from remote repository
  extends: "github:username/repo/config",
  
  // Or multiple sources
  extends: [
    "./base.config",
    "./override.config"
  ],
  
  // Your config values
  custom: "value"
};
```

### 3. Watching Configuration Changes

```typescript
import { watchConfig } from "c12";

const config = await watchConfig({
  name: "dotfiles",
  
  onWatch: ({ type, path }) => {
    console.log(`Config ${type} at ${path}`);
  },
  
  acceptHMR: ({ oldConfig, newConfig }) => {
    // Compare configs and return true to accept HMR
    // Return false to trigger full reload
    return JSON.stringify(oldConfig) === JSON.stringify(newConfig);
  }
});

// Later, unwatch
config.unwatch();
```

### 4. LoadConfig Options

```typescript
interface LoadConfigOptions {
  // Working directory (default: process.cwd())
  cwd?: string;
  
  // Configuration name (default: "config")
  name?: string;
  
  // Config file name without extension
  configFile?: string;
  
  // RC file name (default: ".{name}rc")
  rcFile?: string | false;
  
  // Load from package.json (default: true)
  packageJson?: boolean | string;
  
  // Global RC file (default: true)
  globalRc?: boolean;
  
  // Environment name (default: process.env.NODE_ENV)
  envName?: string;
  
  // Default configuration
  defaults?: any;
  
  // Override configuration
  overrides?: any;
  
  // Merge function
  merge?: (a: any, b: any) => any;
}
```

## Configuration Priority

From lowest to highest priority:
1. Default configuration (`defaults` option)
2. Config from `package.json`
3. Global RC file (`~/.{name}rc`)
4. Local RC file (`./.{name}rc`)
5. Config file (`{name}.config.{ext}`)
6. Environment-specific overrides
7. Programmatic overrides (`overrides` option)

## Type Safety with TypeScript

### Define Configuration Type

```typescript
// src/types/config.ts
export interface DotfilesConfig {
  mappings: FileMapping[];
  backup: BackupConfig;
  mcp?: MCPConfig;
}

export interface FileMapping {
  source: string;
  target: string;
  type: "file" | "directory" | "selective";
  include?: string[];
  permissions?: Record<string, string>;
}

export interface BackupConfig {
  directory: string;
  keepLast: number;
  compress: boolean;
}

export interface MCPConfig {
  sourceFile: string;
  targetFile: string;
  mergeKey: string;
}

// Helper function for type-safe config definition
export function defineConfig(config: DotfilesConfig): DotfilesConfig {
  return config;
}
```

### Use in Configuration File

```typescript
// dotfiles.config.ts
import { defineConfig } from "./src/types/config";

export default defineConfig({
  // Full type safety and IntelliSense support
  mappings: [
    {
      source: "./shell/.bashrc",
      target: "~/.bashrc",
      type: "file" // Type checked
    }
  ],
  backup: {
    directory: "~/.dotfiles_backup",
    keepLast: 10,
    compress: false
  }
});
```

## Migration Steps

1. **Install c12**
   ```bash
   bun add c12
   ```

2. **Create Type Definitions**
   - Define configuration interfaces
   - Create `defineConfig` helper function

3. **Convert JSON to TypeScript**
   - Create `dotfiles.config.ts`
   - Export configuration as default
   - Add type safety with `defineConfig`

4. **Update ConfigManager**
   ```typescript
   import { loadConfig } from "c12";
   
   export const createConfigManager = async (configPath?: string) => {
     const { config } = await loadConfig<DotfilesConfig>({
       name: "dotfiles",
       cwd: configPath || process.cwd(),
       defaults: {
         backup: {
           keepLast: 10,
           compress: false
         }
       }
     });
     
     return {
       getConfig: () => config,
       getMappings: () => expandMappings(config.mappings),
       // ... other methods
     };
   };
   ```

5. **Benefits After Migration**
   - Type safety and IntelliSense
   - Environment-specific configurations
   - Dynamic configuration with JavaScript/TypeScript
   - Better IDE support
   - Configuration validation at compile time

## Best Practices

1. **Use `defineConfig` Helper**: Ensures type safety
2. **Leverage Environment Overrides**: Use `$development`, `$production` for env-specific settings
3. **Keep Defaults Minimal**: Define sensible defaults in the loader
4. **Use TypeScript**: Get compile-time validation
5. **Watch in Development**: Use `watchConfig` for HMR during development

## Ecosystem Integration

c12 is used by major projects in the UnJS ecosystem:
- Nuxt
- Nitro
- Prisma
- And many other projects

This ensures good community support and long-term maintenance.