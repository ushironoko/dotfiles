/**
 * Placeholder substitution shared by the subagent chain and the workflow
 * inter-stage injection.
 *
 * Uses a FUNCTION replacer so the substituted value is inserted verbatim:
 * String.prototype.replace treats `$&`, `$$`, `` $` ``, `$'`, `$1` in a string
 * replacement as special sequences, which would corrupt any prior-agent output
 * that happens to contain a `$`. A function replacer bypasses all of that.
 */
export const replacePrevious = (text: string, value: string): string =>
  text.replace(/\{previous\}/g, () => value);
