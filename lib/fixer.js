/**
 * 修复编排:预处理 → fix 规则按序应用 → warn 规则(对原文扫描)。
 * 纯函数,可单测;幂等:fix(fix(x)).fixed === fix(x).fixed。
 *
 * LOCAL PATCH (2026-10-26; upstream 停更 2 个月) — two upstream defects fixed:
 *
 *  1. Rules anchor at line start and several of them consume the REST OF THE LINE
 *     (`ls`/`rm`/`grep`/`head`/`mkdir`/`touch`/`which` append flags at end-of-string).
 *     A chain like `rm -rf ./build || echo failed` was therefore mangled in a single
 *     pass into `Remove-Item ./build || echo failed -Recurse -Force`.
 *  2. After AND_OR_CHAIN wrapped a chain into `a; if ($?) { b }`, the inner segments
 *     were never visited, so `ok:true` came back with a still-broken command.
 *
 *  Fix: hygiene rules run over the whole text; every other rule runs per SEGMENT,
 *  after splitting top-level `&&`/`||`. Segments that still contain `;` or a
 *  pipeline are left untouched and surfaced as warnings instead of being
 *  silently half-fixed.
 */

import { hostPlatform, resolveShell } from "./detect.js";
import { FIX_RULES, WARN_RULES, AND_OR_CHAIN, splitTopLevelChain } from "./rules.js";

/** Rules that operate on the whole text and never consume a command. */
const HYGIENE_RULE_IDS = new Set([
  "NORM_LINEENDINGS",
  "STRIP_PROMPT",
  "CONT_TRAILING_SPACE",
  "LC_BACKSLASH_TO_BACKTICK",
  "LC_BACKTICK_TO_BACKSLASH",
  "LC_MISSING_CONT",
  "LC_DANGLING_BACKTICK",
  "QUOTE_BALANCE",
]);

/**
 * Targeted substitutions that are safe on a whole line, including one that carries a
 * chain. They must run line-level because ENV_LOCAL_REF resolves `$VAR` against an
 * `export VAR=` seen in the SAME string — splitting first would sever that link.
 */
const LINE_LEVEL_RULE_IDS = new Set([
  "ENV_EXPORT",
  "ENV_UNSET",
  "ENV_LOCAL_REF",
  "DEV_NULL",
  "BARE_VAR",
  "SED_AWK",
  "CHMOD",
]);

/** Most command rules append flags at end-of-string, so only a simple command is safe. */
const SIMPLE_SEGMENT = /^[^;|]*$/;

/**
 * Only these can be mangled by the command-shape rules, so a skipped segment is only
 * worth warning about when it actually starts with one of them. Warning on every
 * pipeline would flag correct PowerShell (`Get-ChildItem | Select-Object`) as suspicious.
 */
const BASH_SHAPE = /^[ \t]*(ls|rm|mkdir|touch|grep|head|tail|which)(\.exe)?[ \t]/;

function runRules(text, rules, env) {
  const fixes = [];
  for (const rule of rules) {
    if (!rule.applies(env)) continue;
    const res = rule.run(text, env);
    if (res.text !== text) {
      fixes.push({ rule: rule.id, notes: res.notes });
      text = res.text;
    }
  }
  return { text, fixes };
}

export function fix(command, opts = {}) {
  const platform = opts.platform ?? hostPlatform();
  const shell = resolveShell(opts.shell, platform);
  const env = { platform, shell };

  let text = command;
  const fixes = [];
  if (text.startsWith("\uFEFF")) {
    text = text.slice(1);
    fixes.push({ rule: "NORM_BOM", notes: ["stripped UTF-8 BOM"] });
  }

  const hygieneRules = FIX_RULES.filter((r) => HYGIENE_RULE_IDS.has(r.id));
  const lineRules = FIX_RULES.filter((r) => LINE_LEVEL_RULE_IDS.has(r.id));
  const commandRules = FIX_RULES.filter(
    (r) =>
      !HYGIENE_RULE_IDS.has(r.id) &&
      !LINE_LEVEL_RULE_IDS.has(r.id) &&
      r.id !== AND_OR_CHAIN.id,
  );

  // stage 1 — text hygiene (BOM already handled, line endings, prompts, continuations)
  const hygiene = runRules(text, hygieneRules, env);
  text = hygiene.text;
  fixes.push(...hygiene.fixes);

  // stage 2 — targeted substitutions across the whole text (keeps ENV_EXPORT →
  // ENV_LOCAL_REF in the same string, which the chain split would otherwise break)
  const lineLevel = runRules(text, lineRules, env);
  text = lineLevel.text;
  fixes.push(...lineLevel.fixes);

  // stage 3 — per-segment command fixing (only the rules that consume a command)
  const wrapChains = AND_OR_CHAIN.applies(env);
  const skippedSegments = [];
  let chains = 0;

  const fixSegment = (seg) => {
    if (!SIMPLE_SEGMENT.test(seg)) {
      if (BASH_SHAPE.test(seg)) skippedSegments.push(seg.trim().slice(0, 120));
      return seg;
    }
    const res = runRules(seg, commandRules, env);
    fixes.push(...res.fixes);
    return res.text;
  };

  const out = text.split("\n").map((line) => {
    if (!/&&|\|\|/.test(line)) {
      if (!SIMPLE_SEGMENT.test(line)) {
        // still holds `;` or a pipeline: the command-shape rules would consume the tail,
        // and the targeted substitutions already ran at line level — leave it and warn
        if (BASH_SHAPE.test(line)) skippedSegments.push(line.trim().slice(0, 120));
        return line;
      }
      return fixSegment(line);
    }
    const chain = splitTopLevelChain(line);
    if (!chain) return fixSegment(line);
    chains++;
    const segs = chain.segs.map(fixSegment);
    if (!wrapChains) {
      // PowerShell 7+: && and || are native, keep them
      let acc = segs[0];
      for (let i = 0; i < chain.ops.length; i++) acc = `${acc} ${chain.ops[i]} ${segs[i + 1]}`;
      return acc;
    }
    let acc = segs[0];
    for (let i = 0; i < chain.ops.length; i++) {
      const wrap = chain.ops[i] === "&&" ? "; if ($?) { " : "; if (-not $?) { ";
      acc = `${acc}${wrap}${segs[i + 1]} }`;
    }
    return acc;
  }).join("\n");

  if (out !== text) {
    if (chains > 0) {
      fixes.push({
        rule: AND_OR_CHAIN.id,
        notes: [
          wrapChains
            ? "split && / || chain for Windows PowerShell 5.1; each simple segment fixed"
            : "kept native && / || (PowerShell 7+); each simple segment fixed",
          `${chains} chain(s) rewritten`,
        ],
      });
    }
    text = out;
  }

  // warn 规则扫描**原始**命令(修复可能已消除 bash 痕迹)
  const warnings = [];
  for (const rule of WARN_RULES) {
    if (!rule.applies(env)) continue;
    const res = rule.run(command, env);
    for (const note of res.notes) warnings.push({ rule: rule.id, note });
  }
  for (const seg of skippedSegments) {
    warnings.push({
      rule: "SEGMENT_NOT_FIXED",
      note: `left as-is (contains ';' or '|'): ${seg}`,
    });
  }

  return { fixed: text, changed: text !== command, fixes, warnings, platform, shell };
}
