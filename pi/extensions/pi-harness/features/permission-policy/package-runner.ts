// Package runners can download and execute code, so they are never eligible
// for the scanner's concrete explicit-allow candidate. Parse manager-level
// options to distinguish `bun --cwd . x pkg` from `bun --cwd . run x`; an
// unknown option before a later runner token stays conservatively ineligible.
// Keep detached-value tables deliberately narrow: an option is listed only
// when its next-argv consumption is known; all other spellings take the
// ambiguous fallback instead of accidentally swallowing a real subcommand.
const BUN_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-r",
  "-F",
  "--filter",
  "--cwd",
  "-c",
]);

const BUN_BOOLEAN_OPTIONS: ReadonlySet<string> = new Set([
  "--watch",
  "--hot",
  "--no-clear-screen",
  "--smol",
  "--cpu-prof",
  "--cpu-prof-md",
  "--heap-prof",
  "--heap-prof-md",
  "--if-present",
  "--no-install",
  "-i",
  "--prefer-offline",
  "--prefer-latest",
  "--expose-gc",
  "--no-deprecation",
  "--throw-deprecation",
  "--zero-fill-buffers",
  "--use-system-ca",
  "--use-openssl-ca",
  "--use-bundled-ca",
  "--redis-preconnect",
  "--sql-preconnect",
  "--no-addons",
  "--silent",
  "-b",
  "--bun",
  "--workspaces",
  "--parallel",
  "--sequential",
  "--no-exit-on-error",
  "--no-env-file",
  "--jsx-side-effects",
  "--ignore-dce-annotations",
  "-v",
  "--version",
  "--revision",
  "-h",
  "--help",
]);

const BUN_TERMINAL_OPTIONS: ReadonlySet<string> = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
]);
const BUN_ATTACHED_TERMINAL_OPTIONS: ReadonlySet<string> = new Set([
  "-e",
  "-p",
]);

const PNPM_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-C",
  "--dir",
  "-F",
  "--filter",
  "--filter-prod",
]);

const PNPM_BOOLEAN_OPTIONS: ReadonlySet<string> = new Set([
  "-r",
  "--recursive",
  "-w",
  "--workspace-root",
  "-g",
  "--global",
  "--offline",
  "--prefer-offline",
  "-P",
  "--prod",
  "-D",
  "--dev",
  "-O",
  "--optional",
  "--lockfile-only",
  "--frozen-lockfile",
  "--fix-lockfile",
  "--force",
  "--ignore-scripts",
  "--use-stderr",
  "--stream",
  "--parallel",
  "--aggregate-output",
  "--reverse",
  "--sort",
  "--silent",
]);

const PNPM_TERMINAL_OPTIONS: ReadonlySet<string> = new Set([
  "-h",
  "--help",
  "-v",
  "--version",
]);

const NPM_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "--prefix",
  "-w",
  "--workspace",
  "--loglevel",
  "--cache",
  "--registry",
  "--userconfig",
  "--scope",
]);

const NPM_BOOLEAN_OPTIONS: ReadonlySet<string> = new Set([
  "-y",
  "--yes",
  "--silent",
  "--workspaces",
  "--include-workspace-root",
  "--ignore-scripts",
  "--foreground-scripts",
  "--offline",
  "--prefer-offline",
  "--force",
]);

const NPM_TERMINAL_OPTIONS: ReadonlySet<string> = new Set([
  "-h",
  "--help",
  "-v",
  "--version",
]);

const YARN_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "--cwd",
  "--use-yarnrc",
  "--mutex",
  "--cache-folder",
  "--modules-folder",
  "--network-concurrency",
  "--network-timeout",
]);

const YARN_BOOLEAN_OPTIONS: ReadonlySet<string> = new Set([
  "--silent",
  "--verbose",
  "--offline",
  "--ignore-scripts",
  "--non-interactive",
  "--json",
]);

const YARN_TERMINAL_OPTIONS: ReadonlySet<string> = new Set([
  "-h",
  "--help",
  "-v",
  "--version",
]);

const NO_OPTIONS: ReadonlySet<string> = new Set();

const BUN_RUNNER_SUBCOMMANDS: ReadonlySet<string> = new Set(["x"]);
const PNPM_RUNNER_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "dlx",
  "exec",
  "x",
]);
const NPM_RUNNER_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "exec",
  "exe",
  "x",
]);
const YARN_RUNNER_SUBCOMMANDS: ReadonlySet<string> = new Set(["dlx", "exec"]);

interface SubcommandScan {
  readonly subcommand?: string;
  readonly ambiguousFrom?: number;
}

const optionName = (word: string): string => {
  const equals = word.indexOf("=");
  return equals === -1 ? word : word.slice(0, equals);
};

const hasAttachedShortValue = (
  word: string,
  optionsWithValue: ReadonlySet<string>,
): boolean => {
  for (const option of optionsWithValue) {
    if (
      option.length === 2 &&
      option.startsWith("-") &&
      !option.startsWith("--") &&
      word.startsWith(option) &&
      word.length > option.length
    ) {
      return true;
    }
  }
  return false;
};

const scanManagerSubcommand = (
  words: readonly string[],
  optionsWithValue: ReadonlySet<string>,
  booleanOptions: ReadonlySet<string>,
  terminalOptions: ReadonlySet<string>,
  terminalValueOptions: ReadonlySet<string>,
): SubcommandScan => {
  let index = 1;
  while (index < words.length) {
    const word = words[index];
    if (word === undefined) break;
    if (word === "--") {
      const subcommand = words[index + 1];
      return subcommand === undefined ? {} : { subcommand };
    }
    if (!word.startsWith("-") || word === "-") return { subcommand: word };

    const name = optionName(word);
    if (
      terminalOptions.has(word) ||
      terminalValueOptions.has(name) ||
      hasAttachedShortValue(word, terminalValueOptions)
    ) {
      return {};
    }
    if (optionsWithValue.has(name)) {
      index +=
        word.includes("=") || hasAttachedShortValue(word, optionsWithValue)
          ? 1
          : 2;
      continue;
    }
    if (booleanOptions.has(name) || word.includes("=")) {
      index += 1;
      continue;
    }
    return { ambiguousFrom: index + 1 };
  }
  return {};
};

const scanContainsRunner = (
  words: readonly string[],
  scan: SubcommandScan,
  runners: ReadonlySet<string>,
): boolean => {
  if (scan.subcommand !== undefined) return runners.has(scan.subcommand);
  return scan.ambiguousFrom === undefined
    ? false
    : words.slice(scan.ambiguousFrom).some((word) => runners.has(word));
};

const isPackageRunnerInvocation = (words: readonly string[]): boolean => {
  const [command] = words;
  if (command === "npx" || command === "pnpx" || command === "bunx") {
    return true;
  }
  if (command === "bun") {
    return scanContainsRunner(
      words,
      scanManagerSubcommand(
        words,
        BUN_OPTIONS_WITH_VALUE,
        BUN_BOOLEAN_OPTIONS,
        BUN_TERMINAL_OPTIONS,
        BUN_ATTACHED_TERMINAL_OPTIONS,
      ),
      BUN_RUNNER_SUBCOMMANDS,
    );
  }
  if (command === "pnpm") {
    return scanContainsRunner(
      words,
      scanManagerSubcommand(
        words,
        PNPM_OPTIONS_WITH_VALUE,
        PNPM_BOOLEAN_OPTIONS,
        PNPM_TERMINAL_OPTIONS,
        NO_OPTIONS,
      ),
      PNPM_RUNNER_SUBCOMMANDS,
    );
  }
  if (command === "npm") {
    return scanContainsRunner(
      words,
      scanManagerSubcommand(
        words,
        NPM_OPTIONS_WITH_VALUE,
        NPM_BOOLEAN_OPTIONS,
        NPM_TERMINAL_OPTIONS,
        NO_OPTIONS,
      ),
      NPM_RUNNER_SUBCOMMANDS,
    );
  }
  if (command === "yarn") {
    return scanContainsRunner(
      words,
      scanManagerSubcommand(
        words,
        YARN_OPTIONS_WITH_VALUE,
        YARN_BOOLEAN_OPTIONS,
        YARN_TERMINAL_OPTIONS,
        NO_OPTIONS,
      ),
      YARN_RUNNER_SUBCOMMANDS,
    );
  }
  return false;
};

export { isPackageRunnerInvocation };
