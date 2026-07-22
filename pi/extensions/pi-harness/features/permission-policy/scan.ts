/**
 * Shell-command tokenizer + speculative floor analysis for the permission
 * policy. `rules.ts` owns the concrete `^`-anchored regex floor and the final
 * verdict precedence; this module owns:
 *
 *  - `scanCommand`: split a command line into simple-command segments
 *    (quote/escape/comment/redirection aware) plus the raw text of every
 *    command substitution (including those nested in ${…}/$((…))) to recurse
 *    into. Structurally unparseable or unsupported input (including `<<`
 *    here-doc syntax) → `ok:false` (caller denies).
 *  - `normalizeSegment`: strip leading assignments / wrappers / reserved words
 *    and report whether the resulting head is statically unknown.
 *  - `speculativeFloor`: "could this segment become a built-in floor command
 *    that its concrete text does not already match?" Used to fail closed on
 *    dynamic/unsupported syntax in a sensitive-head segment.
 *
 * A statically-unknown word position (unresolved expansion, or brace/glob) is
 * tracked per word in `opaque` (+ `opaqueUnquoted` when it can word-split). The
 * sentinel char `OPAQUE` only keeps such a word non-empty and inert for concrete
 * matching; the index sets are authoritative for speculation.
 */
import { isPackageRunnerInvocation } from "./package-runner";

// Private-use sentinel: not in any rule's vocabulary, not a real path/flag, and
// `\S` so it preserves `\s+` word gaps and never causes a false concrete match.
const OPAQUE = "";

const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;
const FD_VAR = /^\{[A-Za-z_][A-Za-z0-9_]*\}$/;

// Leading words that do not change WHICH command runs → stripped before the
// floor sees the real head: group opener, transparent wrappers, exec/command/
// builtin, and reserved words that can precede a command.
const STRIP_WORDS: ReadonlySet<string> = new Set([
  "{",
  "!",
  "sudo",
  "env",
  "command",
  "builtin",
  "exec",
  "nohup",
  "time",
  "nice",
  "then",
  "do",
  "else",
  "elif",
  "in",
  "if",
  "while",
  "until",
  "for",
  "case",
  "select",
  "function",
]);

// Command names the built-in floor guards (every built-in rule is `^`-anchored
// on one of these). Keep in lockstep with rules.ts BUILT_IN_*_DEFINITIONS and
// with FLOOR_SHAPES below (a cross-check test asserts agreement).
const SENSITIVE_HEADS: ReadonlySet<string> = new Set([
  "bit",
  "git",
  "rm",
  "chmod",
]);

const OPAQUE_HEAD_WORDS: ReadonlySet<string> = new Set(["eval", "xargs"]);
const SHELL_INTERPRETERS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
]);

export interface Segment {
  readonly words: readonly string[];
  readonly opaque: ReadonlySet<number>;
  readonly opaqueUnquoted: ReadonlySet<number>;
  /** Word indices containing Bash ANSI-C `$'…'` syntax. */
  readonly ansiC: ReadonlySet<number>;
  /** ANSI-C syntax appeared anywhere in this executable segment. */
  readonly hasAnsiC: boolean;
  /** A file-opening output redirect (>, >>, >|, &>) appeared in this segment. */
  readonly hasOutputRedirection: boolean;
  /** Concrete redirect targets, retained only for local risk inspection. */
  readonly redirectionTargets: readonly string[];
  /** True only when this segment is outside a parenthesized shell group. */
  readonly topLevel: boolean;
  /** True only when the shell connector immediately after this segment is &&. */
  readonly followedByAnd: boolean;
  /** Concrete pre-normalization command text, when safe for explicit allow. */
  readonly allowCandidate?: string;
}

export interface ScanResult {
  readonly segments: readonly Segment[];
  readonly subs: readonly string[];
  readonly ok: boolean;
}

// ---------------------------------------------------------------------------
// Balanced / quoted readers
// ---------------------------------------------------------------------------

interface Balanced {
  readonly inner: string;
  readonly end: number;
}

const MAX_READER_NESTING = 64;

const readBalanced = (
  text: string,
  openIndex: number,
  open: string,
  close: string,
  inDoubleQuotes = false,
  readerNesting = 0,
): Balanced | undefined => {
  if (readerNesting > MAX_READER_NESTING) return undefined;
  let depth = 1;
  let j = openIndex + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") {
      if (text[j + 1] === "\n") return undefined;
      j += 2;
      continue;
    }
    if (c === "$" && text[j + 1] === "(") {
      // A command substitution starts a fresh shell quote context. Skip its
      // complete balanced span before looking for the outer `}`; otherwise a
      // brace protected by an inner single quote can prematurely close `${…}`.
      const nested = readBalanced(
        text,
        j + 1,
        "(",
        ")",
        false,
        readerNesting + 1,
      );
      if (nested === undefined) return undefined;
      j = nested.end;
      continue;
    }
    if (c === "'") {
      // Apostrophes inside an outer-double-quoted parameter expansion are
      // operator-sensitive: they are literal in default-value words but quote
      // pattern characters for `${x#pattern}` / `${x/pattern/replacement}`.
      // Rather than let a quoted brace swallow later shell commands, reject
      // this ambiguous outer context. Nested `$()` spans were skipped above and
      // therefore retain their own ordinary single-quote semantics.
      if (inDoubleQuotes) return undefined;
      const k = text.indexOf("'", j + 1);
      if (k === -1) return undefined;
      j = k + 1;
      continue;
    }
    if (c === '"') {
      j += 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\" && text[j + 1] === "\n") return undefined;
        j += text[j] === "\\" ? 2 : 1;
      }
      if (j >= text.length) return undefined;
      j += 1;
      continue;
    }
    if (c === "`") {
      j += 1;
      while (j < text.length && text[j] !== "`") {
        j += text[j] === "\\" ? 2 : 1;
      }
      if (j >= text.length) return undefined;
      j += 1;
      continue;
    }
    if (c === open) {
      depth += 1;
      j += 1;
      continue;
    }
    if (c === close) {
      depth -= 1;
      if (depth === 0)
        return { inner: text.slice(openIndex + 1, j), end: j + 1 };
      j += 1;
      continue;
    }
    j += 1;
  }
  return undefined;
};

const readBacktick = (text: string, index: number): Balanced | undefined => {
  let j = index + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "`") return { inner: text.slice(index + 1, j), end: j + 1 };
    j += 1;
  }
  return undefined;
};

const ANSI_C_SIMPLE: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  f: "\f",
  v: "\v",
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

interface AnsiResult {
  readonly decoded: string;
  readonly end: number;
}

// $'…' ANSI-C quoting — decoded to a known literal (not opaque; its content is
// statically known and its whitespace stays inside the word).
const readAnsiC = (
  text: string,
  quoteIndex: number,
): AnsiResult | undefined => {
  let j = quoteIndex + 1;
  let out = "";
  while (j < text.length) {
    const c = text[j];
    if (c === "'") return { decoded: out, end: j + 1 };
    if (c === "\\") {
      const n = text[j + 1];
      if (n === undefined) {
        out += "\\";
        j += 1;
        continue;
      }
      const simple = ANSI_C_SIMPLE[n];
      if (simple !== undefined) {
        out += simple;
        j += 2;
        continue;
      }
      if (n === "x") {
        const hex = /^[0-9A-Fa-f]{1,2}/.exec(text.slice(j + 2));
        if (hex) {
          out += String.fromCharCode(parseInt(hex[0], 16));
          j += 2 + hex[0].length;
          continue;
        }
      }
      if (n === "u" || n === "U") {
        const re = n === "u" ? /^[0-9A-Fa-f]{1,4}/ : /^[0-9A-Fa-f]{1,8}/;
        const hex = re.exec(text.slice(j + 2));
        if (hex) {
          out += String.fromCodePoint(parseInt(hex[0], 16));
          j += 2 + hex[0].length;
          continue;
        }
      }
      if (n >= "0" && n <= "7") {
        const oct = /^[0-7]{1,3}/.exec(text.slice(j + 1));
        if (oct) {
          out += String.fromCharCode(parseInt(oct[0], 8));
          j += 1 + oct[0].length;
          continue;
        }
      }
      out += n;
      j += 2;
      continue;
    }
    out += c;
    j += 1;
  }
  return undefined;
};

interface DollarResult {
  readonly append: string;
  // Command substitutions to recurse (also collected from inside ${…}/$((…))).
  readonly subs: readonly string[];
  readonly boundary: boolean; // unquoted $IFS / ${IFS} → word boundary
  readonly opaque: boolean; // statically-unknown value
  readonly ansiC?: true; // contained an ANSI-C quoted fragment
  readonly end: number;
}

const readDollar = (
  text: string,
  index: number,
  inDoubleQuotes = false,
): DollarResult | undefined => {
  const n = text[index + 1];
  if (n === "(") {
    const arithmetic = text[index + 2] === "(";
    const bal = readBalanced(text, index + 1, "(", ")");
    if (bal === undefined) return undefined;
    // Arithmetic is not a command, but a $(…) can be nested inside it and DOES
    // run; recurse into the inner text either way.
    const nestedSubs = arithmetic ? extractSubs(bal.inner) : [bal.inner];
    if (nestedSubs === undefined) return undefined;
    return {
      append: OPAQUE,
      subs: nestedSubs,
      boundary: false,
      opaque: true,
      ...(bal.inner.includes("$'") ? { ansiC: true as const } : {}),
      end: bal.end,
    };
  }
  if (n === "{") {
    const bal = readBalanced(text, index + 1, "{", "}", inDoubleQuotes);
    if (bal === undefined) return undefined;
    if (bal.inner === "IFS") {
      return {
        append: "",
        subs: [],
        boundary: true,
        opaque: false,
        end: bal.end,
      };
    }
    // ${x:-$(cmd)} etc. — a substitution inside a parameter expansion still
    // executes; recurse into any command substitutions found within. ANSI-C
    // syntax in the expansion word is conservatively provenance-marked even
    // when another shell condition might skip that branch.
    const nestedSubs = extractSubs(bal.inner, inDoubleQuotes);
    if (nestedSubs === undefined) return undefined;
    return {
      append: OPAQUE,
      subs: nestedSubs,
      boundary: false,
      opaque: true,
      ...(bal.inner.includes("$'") ? { ansiC: true as const } : {}),
      end: bal.end,
    };
  }
  if (n === "'") {
    if (inDoubleQuotes) {
      // `$'…'` has ANSI-C quote semantics only when it starts outside an
      // existing double quote. Inside `"…"`, both apostrophes are literal and
      // any later `$()` / backtick still executes; consume only the `$` so the
      // double-quote reader can inspect the remainder in the correct context.
      return {
        append: "$",
        subs: [],
        boundary: false,
        opaque: false,
        end: index + 1,
      };
    }
    const ansi = readAnsiC(text, index + 1);
    if (ansi === undefined) return undefined;
    return {
      append: ansi.decoded,
      subs: [],
      boundary: false,
      opaque: false,
      ansiC: true,
      end: ansi.end,
    };
  }
  const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(index + 1));
  if (nameMatch) {
    const name = nameMatch[0];
    if (name === "IFS") {
      return {
        append: "",
        subs: [],
        boundary: true,
        opaque: false,
        end: index + 1 + name.length,
      };
    }
    return {
      append: OPAQUE,
      subs: [],
      boundary: false,
      opaque: true,
      end: index + 1 + name.length,
    };
  }
  if (n !== undefined && "?$!#@*-0123456789".includes(n)) {
    return {
      append: OPAQUE,
      subs: [],
      boundary: false,
      opaque: true,
      end: index + 2,
    };
  }
  return {
    append: "$",
    subs: [],
    boundary: false,
    opaque: false,
    end: index + 1,
  };
};

interface DoubleQuoteResult {
  readonly literal: string;
  readonly subs: readonly string[];
  readonly opaque: boolean; // contained an expansion (quoted → single word)
  readonly ansiC: boolean;
  readonly end: number;
}

const readDoubleQuote = (
  text: string,
  index: number,
): DoubleQuoteResult | undefined => {
  let j = index + 1;
  let literal = "";
  const subs: string[] = [];
  let opaque = false;
  let ansiC = false;
  while (j < text.length) {
    const c = text[j];
    if (c === '"') return { literal, subs, opaque, ansiC, end: j + 1 };
    if (c === "\\") {
      const escaped = text[j + 1];
      if (escaped === undefined) return undefined;
      if (
        escaped === '"' ||
        escaped === "\\" ||
        escaped === "$" ||
        escaped === "`"
      ) {
        literal += escaped;
        j += 2;
        continue;
      }
      if (escaped === "\n") return undefined;
      literal += "\\";
      j += 1;
      continue;
    }
    if (c === "$") {
      const dollar = readDollar(text, j, true);
      if (dollar === undefined) return undefined;
      literal += dollar.boundary ? " " : dollar.append;
      subs.push(...dollar.subs);
      if (dollar.opaque) opaque = true;
      if (dollar.ansiC === true) ansiC = true;
      j = dollar.end;
      continue;
    }
    if (c === "`") {
      const back = readBacktick(text, j);
      if (back === undefined) return undefined;
      subs.push(back.inner);
      literal += OPAQUE;
      opaque = true;
      j = back.end;
      continue;
    }
    literal += c;
    j += 1;
  }
  return undefined;
};

// Pull the raw text of every top-level command substitution out of a fragment
// (used for ${…}/$((…)) interiors). Any malformed or over-nested substitution
// fails the enclosing scan; silently returning a partial list could hide a
// mandatory-deny command beyond the malformed span.
const extractSubs = (
  fragment: string,
  initiallyInDoubleQuotes = false,
): string[] | undefined => {
  const found: string[] = [];
  let i = 0;
  let inDoubleQuotes = initiallyInDoubleQuotes;
  // Within the `word` of a parameter expansion that itself started inside an
  // outer double quote, apostrophes remain literal even across nested `"…"`
  // pairs. Only a recursively evaluated `$()` gets a fresh shell quote context.
  const apostrophesAreLiteral = initiallyInDoubleQuotes;
  while (i < fragment.length) {
    const c = fragment[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') {
      inDoubleQuotes = !inDoubleQuotes;
      i += 1;
      continue;
    }
    if (c === "'" && !inDoubleQuotes && !apostrophesAreLiteral) {
      const k = fragment.indexOf("'", i + 1);
      if (k === -1) return undefined;
      i = k + 1;
      continue;
    }
    if (c === "`") {
      const back = readBacktick(fragment, i);
      if (back === undefined) return undefined;
      found.push(back.inner);
      i = back.end;
      continue;
    }
    if (c === "$" && fragment[i + 1] === "(" && fragment[i + 2] !== "(") {
      const bal = readBalanced(fragment, i + 1, "(", ")");
      if (bal === undefined) return undefined;
      found.push(bal.inner);
      i = bal.end;
      continue;
    }
    i += 1;
  }
  return found;
};

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const BRACE_GLOB = /[*?[]/;

const isBraceExpansion = (text: string, at: number): boolean => {
  // text[at] === "{"; a brace EXPANSION contains a top-level "," or ".." before
  // the matching "}". (A plain "{" is treated as a literal char.)
  let depth = 1;
  let j = at + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return false;
    } else if (
      depth === 1 &&
      (c === "," || (c === "." && text[j + 1] === "."))
    ) {
      return true;
    }
    j += 1;
  }
  return false;
};

export const scanCommand = (command: string): ScanResult => {
  const segments: Segment[] = [];
  const subs: string[] = [];
  let words: string[] = [];
  let opaque = new Set<number>();
  let opaqueUnquoted = new Set<number>();
  let ansiC = new Set<number>();
  let segmentHasAnsiC = false;
  let segmentHasOutputRedirection = false;
  let redirectionTargets: string[] = [];
  let word = "";
  let wordStarted = false;
  let wordOpaque = false;
  let wordOpaqueUnquoted = false;
  let wordAnsiC = false;
  let atWordStart = true;
  let pendingRedirectTarget = false;
  let pendingFdDuplicationTarget = false;
  let pendingFdDuplicationOutput = false;
  let allowEligible = true;
  let groupDepth = 0;
  let i = 0;

  const resetWord = (): void => {
    word = "";
    wordStarted = false;
    wordOpaque = false;
    wordOpaqueUnquoted = false;
    wordAnsiC = false;
  };
  const flushWord = (): void => {
    if (!wordStarted && word === "") return;
    if (pendingRedirectTarget) {
      // This word is a redirect target (data, not a command word). Retain its
      // concrete portion for sensitive-path inspection, but never treat it as
      // argv or as eligible explicit-allow text. `>&word` is fd duplication
      // only when the complete expanded word is a concrete decimal descriptor,
      // descriptor move (`2-`), or `-`; prefixes such as `1out` are file names.
      const concreteFdDuplication =
        pendingFdDuplicationTarget &&
        !wordOpaque &&
        /^(?:\d+-?|-)$/u.test(word);
      if (pendingFdDuplicationOutput && !concreteFdDuplication) {
        segmentHasOutputRedirection = true;
      }
      redirectionTargets.push(word);
      pendingRedirectTarget = false;
      pendingFdDuplicationTarget = false;
      pendingFdDuplicationOutput = false;
      resetWord();
      return;
    }
    const index = words.length;
    words.push(word);
    if (wordOpaque) opaque.add(index);
    if (wordOpaqueUnquoted) opaqueUnquoted.add(index);
    if (wordAnsiC) ansiC.add(index);
    resetWord();
  };
  const flushSegment = (followedByAnd = false): void => {
    flushWord();
    pendingRedirectTarget = false;
    pendingFdDuplicationTarget = false;
    pendingFdDuplicationOutput = false;
    if (words.length > 0 || !allowEligible) {
      // Preserve argv boundaries when rendering the regex candidate. Literal
      // whitespace produced inside one quoted/escaped shell word must not turn
      // into the separator between two words: `codex 'login status'` is not
      // the granted argv prefix `codex login status`. OPAQUE is a private-use
      // non-whitespace sentinel that cannot satisfy either a literal space or
      // a custom `\s` separator, while broad single-head grants still match.
      const allowCandidate =
        allowEligible &&
        opaque.size === 0 &&
        words.length > 0 &&
        !isPackageRunnerInvocation(words)
          ? words.map((value) => value.replace(/\s/gu, OPAQUE)).join(" ")
          : undefined;
      segments.push({
        words,
        opaque,
        opaqueUnquoted,
        ansiC,
        hasAnsiC: segmentHasAnsiC,
        hasOutputRedirection: segmentHasOutputRedirection,
        redirectionTargets,
        topLevel: groupDepth === 0,
        followedByAnd,
        ...(allowCandidate === undefined ? {} : { allowCandidate }),
      });
    }
    words = [];
    opaque = new Set<number>();
    opaqueUnquoted = new Set<number>();
    ansiC = new Set<number>();
    segmentHasAnsiC = false;
    segmentHasOutputRedirection = false;
    redirectionTargets = [];
    allowEligible = true;
  };
  const fail = (): ScanResult => ({ segments, subs, ok: false });
  const markHeadSyntax = (): void => {
    if (words.length === 0) allowEligible = false;
  };
  const markOpaque = (unquoted: boolean): void => {
    wordStarted = true;
    wordOpaque = true;
    if (unquoted) wordOpaqueUnquoted = true;
  };

  while (i < command.length) {
    const c = command[i];

    if (c === "\\") {
      markHeadSyntax();
      const n = command[i + 1];
      if (n === undefined) {
        word += "\\";
        wordStarted = true;
        atWordStart = false;
        i += 1;
        continue;
      }
      // Backslash-newline removal happens before Bash tokenization and can
      // synthesize operators (`$(`, `<<`, `&&`, …) across physical lines.
      // Reconstructing every affected grammar is out of scope, so executable
      // contexts containing a line continuation are deliberately unsupported.
      if (n === "\n") return fail();
      word += n;
      wordStarted = true;
      atWordStart = false;
      i += 2;
      continue;
    }

    if (c === "'") {
      markHeadSyntax();
      const k = command.indexOf("'", i + 1);
      if (k === -1) return fail();
      word += command.slice(i + 1, k);
      wordStarted = true;
      atWordStart = false;
      i = k + 1;
      continue;
    }

    if (c === '"') {
      markHeadSyntax();
      const dq = readDoubleQuote(command, i);
      if (dq === undefined) return fail();
      word += dq.literal;
      wordStarted = true;
      subs.push(...dq.subs);
      if (dq.opaque) wordOpaque = true; // quoted: not word-splitting
      if (dq.ansiC) {
        wordAnsiC = true;
        segmentHasAnsiC = true;
        allowEligible = false;
      }
      atWordStart = false;
      i = dq.end;
      continue;
    }

    if (c === "$") {
      markHeadSyntax();
      const dollar = readDollar(command, i);
      if (dollar === undefined) return fail();
      subs.push(...dollar.subs);
      if (dollar.boundary) {
        // Shell comment recognition happens before expansion: in `$IFS#x`,
        // `#x` is part of the same lexical word, not a comment. Keep that
        // lexical state and never derive an explicit allow through IFS. When
        // IFS is the target of `>&`, retain the dynamic target as an output
        // write risk instead of letting an empty boundary drop the redirect.
        allowEligible = false;
        if (pendingRedirectTarget) {
          if (pendingFdDuplicationOutput) {
            segmentHasOutputRedirection = true;
          }
          redirectionTargets.push(OPAQUE);
          pendingRedirectTarget = false;
          pendingFdDuplicationTarget = false;
          pendingFdDuplicationOutput = false;
          resetWord();
        } else {
          flushWord();
        }
        atWordStart = false;
        i = dollar.end;
        continue;
      }
      word += dollar.append;
      wordStarted = true;
      if (dollar.ansiC === true) {
        // JavaScript strings cannot preserve every byte-level ANSI-C result
        // exactly as Bash argv. Keep decoded text for the deterministic deny
        // floor, but never derive an automatic allow from this segment.
        wordAnsiC = true;
        segmentHasAnsiC = true;
        allowEligible = false;
      }
      if (dollar.opaque) markOpaque(true);
      atWordStart = false;
      i = dollar.end;
      continue;
    }

    if (c === "`") {
      markHeadSyntax();
      const back = readBacktick(command, i);
      if (back === undefined) return fail();
      subs.push(back.inner);
      word += OPAQUE;
      markOpaque(true);
      atWordStart = false;
      i = back.end;
      continue;
    }

    if (c === "<" || c === ">") {
      allowEligible = false;
      if (command[i + 1] === "(") {
        const bal = readBalanced(command, i + 1, "(", ")");
        if (bal === undefined) return fail();
        subs.push(bal.inner);
        word += OPAQUE;
        markOpaque(true);
        atWordStart = false;
        i = bal.end;
        continue;
      }
      // Bash here-doc parsing depends on header-wide FIFO state, delimiter
      // quote removal, logical-line joining, and context-specific expansion
      // rules. A partial parser can swallow a later mandatory-deny command (or
      // confuse arithmetic `<<` with a here-doc), so this unsupported syntax is
      // deliberately fail-closed. `<<<` remains an ordinary here-string below.
      if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
        return fail();
      }
      // Ordinary redirection: drop a leading fd designator, skip the operator
      // run, and mark the following word as the (discarded) target.
      if (word.length > 0 && (/^\d+$/.test(word) || FD_VAR.test(word))) {
        resetWord();
      } else {
        flushWord();
      }
      i += 1;
      while (i < command.length && (command[i] === "<" || command[i] === ">")) {
        i += 1;
      }
      if (command[i] === "|") i += 1; // >|
      if (command[i] === "&") {
        // Defer fd-duplication classification until the complete redirect word
        // has been tokenized. Quoted/spaced numeric descriptors are valid, but
        // a numeric prefix such as `1out` is a file target.
        i += 1;
        pendingRedirectTarget = true;
        pendingFdDuplicationTarget = true;
        pendingFdDuplicationOutput = c === ">";
      } else {
        if (c === ">") segmentHasOutputRedirection = true;
        pendingRedirectTarget = true;
      }
      atWordStart = true;
      continue;
    }

    if (c === " " || c === "\t") {
      flushWord();
      atWordStart = true;
      i += 1;
      continue;
    }

    if (c === "\n") {
      flushSegment();
      atWordStart = true;
      i += 1;
      continue;
    }

    if (c === "#" && atWordStart) {
      const nl = command.indexOf("\n", i);
      i = nl === -1 ? command.length : nl;
      continue;
    }

    if (c === ";") {
      flushSegment();
      i += 1;
      if (command[i] === ";") i += 1;
      if (command[i] === "&") i += 1;
      atWordStart = true;
      continue;
    }

    if (c === "&") {
      // &> / &>> redirect-all — a redirection, not a background operator.
      if (command[i + 1] === ">") {
        allowEligible = false;
        segmentHasOutputRedirection = true;
        flushWord();
        i += 2;
        if (command[i] === ">") i += 1;
        pendingRedirectTarget = true;
        atWordStart = true;
        continue;
      }
      const followedByAnd = command[i + 1] === "&";
      if (!followedByAnd) allowEligible = false;
      flushSegment(followedByAnd);
      i += followedByAnd ? 2 : 1;
      atWordStart = true;
      continue;
    }

    if (c === "|") {
      flushSegment();
      i += 1;
      if (command[i] === "|" || command[i] === "&") i += 1;
      atWordStart = true;
      continue;
    }

    if (c === "(" || c === ")") {
      flushSegment();
      groupDepth = c === "(" ? groupDepth + 1 : Math.max(0, groupDepth - 1);
      i += 1;
      atWordStart = true;
      continue;
    }

    // Brace expansion / glob: statically-unknown expansion (unquoted).
    if (c === "{" && isBraceExpansion(command, i)) {
      word += c;
      markOpaque(true);
      atWordStart = false;
      i += 1;
      continue;
    }
    if (BRACE_GLOB.test(c)) {
      word += c;
      markOpaque(true);
      atWordStart = false;
      i += 1;
      continue;
    }

    word += c;
    wordStarted = true;
    atWordStart = false;
    i += 1;
  }

  flushSegment();
  return { segments, subs, ok: true };
};

// ---------------------------------------------------------------------------
// Head normalization
// ---------------------------------------------------------------------------

export interface NormalizedSegment {
  readonly words: readonly string[];
  readonly opaque: ReadonlySet<number>;
  readonly opaqueUnquoted: ReadonlySet<number>;
  readonly ansiC: ReadonlySet<number>;
  readonly hasAnsiC: boolean;
  readonly privileged: boolean;
  readonly headOpaque: boolean;
}

// A head written as a path (`/usr/bin/bit`, `~/bin/sh`, `./x`) runs the same
// program as its basename; normalizing to the basename closes the "reach a
// floor command by its absolute path" bypass without enumerating install dirs.
const isPathHead = (word: string): boolean =>
  word.includes("/") || word.startsWith("~");
const basenameOf = (word: string): string => {
  const idx = word.lastIndexOf("/");
  return idx === -1 ? word : word.slice(idx + 1);
};

// bit global options that carry a value / are inert, and its command wrappers.
// Stripping these before the deny floor stops `bit -C x relay`, `bit repo
// relay`, and `bit hub issue claim` from dodging rules anchored on the real
// subcommand. `hub sync|serve` is the relay alias, so it folds to `relay`.
const BIT_GLOBAL_WITH_ARG: ReadonlySet<string> = new Set(["-C"]);
const BIT_GLOBAL_FLAG: ReadonlySet<string> = new Set([
  "-v",
  "--version",
  "-h",
  "--help",
]);

type KeptWord = { readonly from: number } | { readonly literal: string };

const normalizeBitWords = (
  words: readonly string[],
  opaque: ReadonlySet<number>,
  opaqueUnquoted: ReadonlySet<number>,
  ansiC: ReadonlySet<number>,
): {
  words: string[];
  opaque: Set<number>;
  opaqueUnquoted: Set<number>;
  ansiC: Set<number>;
} => {
  const kept: KeptWord[] = [{ from: 0 }]; // "bit"
  const n = words.length;
  let i = 1;

  const stripGlobals = (): void => {
    while (i < n && !opaque.has(i)) {
      const w = words[i];
      if (BIT_GLOBAL_WITH_ARG.has(w)) {
        i += 2; // drop the option and its value operand
        continue;
      }
      if (BIT_GLOBAL_FLAG.has(w)) {
        i += 1;
        continue;
      }
      break;
    }
  };

  stripGlobals();
  let guard = 0;
  while (i < n && !opaque.has(i) && guard < 16) {
    guard += 1;
    const w = words[i];
    if (w === "repo") {
      // `bit repo <cmd>` re-dispatches <cmd> as a regular bit command.
      i += 1;
      stripGlobals();
      continue;
    }
    if (w === "hub") {
      const next = words[i + 1];
      if ((next === "sync" || next === "serve") && !opaque.has(i + 1)) {
        // `bit hub sync|serve` ≡ `bit relay sync|serve`.
        kept.push({ literal: "relay" });
        i += 1; // consume "hub"; sync|serve stays as the following operand
        break;
      }
      i += 1; // drop the deprecated `hub` alias
      stripGlobals();
      continue;
    }
    break;
  }
  for (let j = i; j < n; j += 1) kept.push({ from: j });

  const outWords: string[] = [];
  const outOpaque = new Set<number>();
  const outOpaqueUnquoted = new Set<number>();
  const outAnsiC = new Set<number>();
  kept.forEach((k, idx) => {
    if ("literal" in k) {
      outWords.push(k.literal);
      return;
    }
    outWords.push(words[k.from]);
    if (opaque.has(k.from)) outOpaque.add(idx);
    if (opaqueUnquoted.has(k.from)) outOpaqueUnquoted.add(idx);
    if (ansiC.has(k.from)) outAnsiC.add(idx);
  });
  return {
    words: outWords,
    opaque: outOpaque,
    opaqueUnquoted: outOpaqueUnquoted,
    ansiC: outAnsiC,
  };
};

// Strip leading assignments / wrappers / reserved words so the floor sees the
// real command head; report `headOpaque` when the head is statically unknown
// (an opaque head, or a dangling `-option` left by a wrapper we cannot fully
// parse → fail-closed). The concrete head and bit-wrapper words are normalized
// (basename + bit global/alias folding) so path spellings and equivalent bit
// invocations map to the same floor as their canonical form.
export const normalizeSegment = (segment: Segment): NormalizedSegment => {
  let start = 0;
  let privileged = false;
  while (start < segment.words.length) {
    const raw = segment.words[start];
    if (segment.opaque.has(start)) break; // opaque head — stop, handle below
    // Compare STRIP_WORDS against the basename so `/usr/bin/sudo bit relay`
    // still has its wrapper stripped.
    const base = isPathHead(raw) ? basenameOf(raw) : raw;
    if (raw === "{" || ASSIGNMENT_PREFIX.test(raw) || STRIP_WORDS.has(base)) {
      if (base === "sudo") privileged = true;
      start += 1;
      continue;
    }
    break;
  }

  const shift = start;
  const remap = (set: ReadonlySet<number>): Set<number> => {
    const out = new Set<number>();
    for (const idx of set) if (idx >= shift) out.add(idx - shift);
    return out;
  };
  let words: readonly string[] = segment.words.slice(shift);
  let opaque: ReadonlySet<number> = remap(segment.opaque);
  let opaqueUnquoted: ReadonlySet<number> = remap(segment.opaqueUnquoted);
  let ansiC: ReadonlySet<number> = remap(segment.ansiC);

  // Basename-normalize a concrete path-form head (opaque heads are left for
  // speculativeFloor). Length is unchanged, so opaque indices stay valid.
  const rawHead = words[0];
  if (rawHead !== undefined && !opaque.has(0) && isPathHead(rawHead)) {
    words = [basenameOf(rawHead), ...words.slice(1)];
  }

  // Fold bit global options / repo / hub so the deny floor sees the real
  // subcommand (this rewrites indices, so remap the opaque sets too).
  if (words[0] === "bit") {
    const folded = normalizeBitWords(words, opaque, opaqueUnquoted, ansiC);
    words = folded.words;
    opaque = folded.opaque;
    opaqueUnquoted = folded.opaqueUnquoted;
    ansiC = folded.ansiC;
  }

  const head = words[0];
  const headOpaque =
    words.length > 0 &&
    (opaque.has(0) || (head !== undefined && head.startsWith("-")));
  return {
    words,
    opaque,
    opaqueUnquoted,
    ansiC,
    hasAnsiC: segment.hasAnsiC,
    privileged,
    headOpaque,
  };
};

// ---------------------------------------------------------------------------
// Speculative floor (structured shapes)
// ---------------------------------------------------------------------------

type TokenPred = (token: string) => boolean;

interface FloorShape {
  readonly kind: "deny" | "ask";
  readonly prefix: readonly string[]; // required leading tokens (literal-or-opaque)
  readonly flags?: readonly string[]; // required flag LETTERS (literal-only)
  readonly tokens?: readonly TokenPred[]; // required exact tokens (literal-only)
  readonly operands?: readonly TokenPred[]; // required operands (literal-or-opaque)
}

const isHard: TokenPred = (t) => t === "--hard";
const isForce: TokenPred = (t) => t === "--force" || t === "-f";
const isBigR: TokenPred = (t) => t === "-R";
const is777: TokenPred = (t) => t === "777";
const isAbsPath: TokenPred = (t) => t.startsWith("/") || t.startsWith("~");
const isRelayPlus: TokenPred = (t) => t.startsWith("relay+");

const isShortFlag = (t: string): boolean =>
  t.startsWith("-") && !t.startsWith("--");
const flagHasLetter = (t: string, letter: string): boolean =>
  isShortFlag(t) && t.slice(1).includes(letter);

// Mirrors rules.ts BUILT_IN_DENY_DEFINITIONS / BUILT_IN_ASK_DEFINITIONS. DENY
// shapes let opaque fill discriminating positions (data-leak floor → aggressive);
// ASK shapes require the DANGER flags/tokens to be LITERAL (so `git push origin
// "$branch"` is not force-asked), and let opaque fill only operand slots
// (so `rm -rf "$dir"` / `chmod -R "$m" /x` still ask). See R4.
const FLOOR_SHAPES: readonly FloorShape[] = [
  { kind: "deny", prefix: ["bit", "issue", "claim"] },
  { kind: "deny", prefix: ["bit", "issue", "unclaim"] },
  { kind: "deny", prefix: ["bit", "issue", "claims"] },
  { kind: "deny", prefix: ["bit", "issue", "watch"] },
  { kind: "deny", prefix: ["bit", "issue", "import"] },
  { kind: "deny", prefix: ["bit", "pr", "import"] },
  { kind: "deny", prefix: ["bit", "relay"] },
  { kind: "deny", prefix: ["bit", "clone"], operands: [isRelayPlus] },
  { kind: "ask", prefix: ["rm"], flags: ["r", "f"], operands: [isAbsPath] },
  { kind: "ask", prefix: ["git", "reset"], tokens: [isHard] },
  { kind: "ask", prefix: ["git", "push"], tokens: [isForce] },
  { kind: "ask", prefix: ["git", "clean"], flags: ["f", "d"] },
  { kind: "ask", prefix: ["chmod"], tokens: [isBigR], operands: [is777] },
];

interface PrefixMatch {
  readonly rest: number; // first word index after the prefix
  readonly usedUnquoted: boolean;
}

const matchPrefix = (
  seg: NormalizedSegment,
  prefix: readonly string[],
): PrefixMatch | undefined => {
  let wi = 0;
  for (const token of prefix) {
    if (wi >= seg.words.length) return undefined;
    if (seg.opaque.has(wi)) {
      if (seg.opaqueUnquoted.has(wi))
        return { rest: wi + 1, usedUnquoted: true };
      wi += 1; // quoted opaque matches exactly one prefix token
      continue;
    }
    if (seg.words[wi] === token) {
      wi += 1;
      continue;
    }
    return undefined;
  }
  return { rest: wi, usedUnquoted: false };
};

const shapeCouldMatch = (
  seg: NormalizedSegment,
  shape: FloorShape,
): boolean => {
  const matched = matchPrefix(seg, shape.prefix);
  if (matched === undefined) return false;
  // An unquoted opaque used for the prefix can word-split into anything that
  // follows → treat the shape as satisfiable (fail-closed).
  if (matched.usedUnquoted) return true;

  const restStart = matched.rest;
  const restIndices: number[] = [];
  for (let i = restStart; i < seg.words.length; i += 1) restIndices.push(i);
  const literalIndices = restIndices.filter((i) => !seg.opaque.has(i));
  const opaqueRest = restIndices.filter((i) => seg.opaque.has(i)).length;

  // Danger flags must be present LITERALLY (opaque cannot supply them).
  if (shape.flags) {
    const covered = shape.flags.every((letter) =>
      literalIndices.some((i) => flagHasLetter(seg.words[i], letter)),
    );
    if (!covered) return false;
  }
  for (const pred of shape.tokens ?? []) {
    if (!literalIndices.some((i) => pred(seg.words[i]))) return false;
  }
  // Operand slots may be filled by a literal OR one opaque token each.
  let operandSlots = 0;
  for (const pred of shape.operands ?? []) {
    if (!literalIndices.some((i) => pred(seg.words[i]))) operandSlots += 1;
  }
  return operandSlots <= opaqueRest;
};

/**
 * Does this segment plausibly *become* a built-in floor command that its
 * concrete text does not already match? Returns the highest floor kind at risk,
 * or null. Only sensitive-head segments with an opaque token are speculated
 * over — a benign literal head can never match the `^`-anchored floor.
 */
export const speculativeFloor = (
  seg: NormalizedSegment,
): "deny" | "ask" | null => {
  // headOpaque can hold with no expansions (a dangling `-option` left by a
  // wrapper we cannot fully parse), so check it before the opaque short-circuit.
  if (seg.headOpaque) return "deny"; // unknown head could be any floor command
  if (seg.hasAnsiC) return "ask";
  if (seg.opaque.size === 0) return null;
  const head = seg.words[0];
  if (head === undefined || !SENSITIVE_HEADS.has(head)) return null;
  let ask = false;
  for (const shape of FLOOR_SHAPES) {
    if (!shapeCouldMatch(seg, shape)) continue;
    if (shape.kind === "deny") return "deny";
    ask = true;
  }
  return ask ? "ask" : null;
};

export const isOpaqueExecutor = (words: readonly string[]): boolean => {
  const head = words[0];
  if (head === undefined) return false;
  if (OPAQUE_HEAD_WORDS.has(head)) return true;
  // A shell interpreter can always execute script text from stdin, including
  // forms whose redirect target the argv scanner intentionally removes
  // (`bash -s <<< ...`, `bash -x < script`). Concrete -c bodies are still
  // recursed separately so a built-in deny inside them remains a hard deny.
  if (SHELL_INTERPRETERS.has(head)) return true;
  return false;
};

// For a shell interpreter (`sh`/`bash`/… — head already basename-normalized)
// invoked as `-c <script>`, return the concrete script string so the caller can
// evaluate it recursively (so `sh -c 'bit relay sync'` is denied, not merely
// asked). Returns undefined when the head is not an interpreter, there is no
// `-c`, or its argument is opaque/absent (nothing to inspect statically).
export const interpreterConcreteArg = (
  seg: NormalizedSegment,
): string | undefined => {
  const head = seg.words[0];
  if (head === undefined || !SHELL_INTERPRETERS.has(head)) return undefined;
  for (let i = 1; i < seg.words.length; i += 1) {
    if (seg.opaque.has(i)) continue;
    const w = seg.words[i];
    if (isShortFlag(w) && w.slice(1).includes("c")) {
      const arg = seg.words[i + 1];
      if (arg !== undefined && !seg.opaque.has(i + 1)) return arg;
      return undefined;
    }
  }
  return undefined;
};
