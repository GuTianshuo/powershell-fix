import test from "node:test";
import assert from "node:assert/strict";
import { fix } from "../lib/fixer.js";

const WIN = { platform: "win32" };          // → 本机真实引擎(pwsh 或 powershell51)
const WIN7 = { platform: "win32", shell: "pwsh" };
const WIN51 = { platform: "win32", shell: "powershell51" };
const LINUX = { platform: "linux" };        // → bash

function fixed(cmd, opts = WIN) {
  return fix(cmd, opts).fixed;
}

// ── 换行/续行/粘贴卫生 ─────────────────────────────────────────────

test("NORM_LINEENDINGS: CRLF normalized", () => {
  const r = fix("Get-Process\r\nGet-Date", WIN);
  assert.equal(r.fixed, "Get-Process\nGet-Date");
  assert.ok(r.fixes.some((f) => f.rule === "NORM_LINEENDINGS"));
});

test("STRIP_PROMPT: PS path prompt", () => {
  assert.equal(fixed("PS C:\\Users\\me> Get-Process"), "Get-Process");
});

test("STRIP_PROMPT: multi-line $ prompts", () => {
  // 提示符剥离后 ls -la 由 LS_FLAGS 继续修复(规则链正常协作)
  assert.equal(fixed("$ ls -la\n$ pwd"), "Get-ChildItem -Force\npwd");
});

test("STRIP_PROMPT: does not touch $variable assignment", () => {
  assert.equal(fixed("$x = 5"), "$x = 5");
});

test("CONT_TRAILING_SPACE: trailing space after backtick removed", () => {
  assert.equal(fixed("Get-ChildItem `   \n    -Force"), "Get-ChildItem `\n    -Force");
});

test("LC_BACKSLASH_TO_BACKTICK: bash continuation on windows", () => {
  assert.equal(fixed("Get-ChildItem \\\n    -Force"), "Get-ChildItem `\n    -Force");
});

test("LC_BACKSLASH_TO_BACKTICK: backslash inside unbalanced quote untouched", () => {
  assert.equal(fixed('echo "unterminated \\'), 'echo "unterminated \\');
});

test("LC_BACKTICK_TO_BACKSLASH: ps continuation on linux", () => {
  assert.equal(fixed("ls `\n  -la", LINUX), "ls \\\n  -la");
});

test("LC_MISSING_CONT: adds backtick before -Param continuation", () => {
  assert.equal(fixed("Get-ChildItem\n    -Force"), "Get-ChildItem `\n    -Force");
});

test("LC_MISSING_CONT: pipe continuation stays untouched", () => {
  const cmd = "Get-ChildItem |\n    Sort-Object Name";
  assert.equal(fixed(cmd), cmd);
});

test("LC_DANGLING_BACKTICK: removed before empty line", () => {
  assert.equal(fixed("Get-ChildItem `\n"), "Get-ChildItem \n");
});

test("QUOTE_BALANCE: unbalanced quotes warn", () => {
  const r = fix('echo "hello', WIN);
  assert.ok(r.warnings.some((w) => w.rule === "QUOTE_BALANCE"));
});

// ── 语义规则 ────────────────────────────────────────────────────────

test("ENV_EXPORT: bare value", () => {
  assert.equal(fixed("export FOO=bar"), "$env:FOO='bar'");
});

test("ENV_EXPORT: double-quoted value", () => {
  assert.equal(fixed('export FOO="a b"'), "$env:FOO='a b'");
});

test("ENV_EXPORT: value with single quote escaped", () => {
  assert.equal(fixed("export FOO=it's"), "$env:FOO='it''s'");
});

test("ENV_UNSET", () => {
  assert.equal(fixed("unset FOO"), "if (Test-Path Env:FOO) { Remove-Item Env:FOO }");
});

test("ENV_UNSET: inline within chain (experiment S9)", () => {
  assert.equal(
    fixed("export A=1 && unset A && echo ok", WIN7),
    "$env:A='1' && if (Test-Path Env:A) { Remove-Item Env:A } && echo ok",
  );
});

test("ENV_UNSET: inline after semicolon", () => {
  assert.equal(
    fixed("export A=1; unset A", WIN7),
    "$env:A='1'; if (Test-Path Env:A) { Remove-Item Env:A }",
  );
});

test("ENV_LOCAL_REF: same-command $VAR rewritten to $env:VAR (experiment S1)", () => {
  assert.equal(fixed("export A=1 && echo $A", WIN7), "$env:A='1' && echo $env:A");
});

test("ENV_LOCAL_REF: braced ${VAR} form", () => {
  assert.equal(fixed("export A=1; echo ${A}", WIN7), "$env:A='1'; echo $env:A");
});

test("ENV_LOCAL_REF: unrelated $var untouched (only exported names)", () => {
  const r = fix("export A=1 && echo $other", WIN7);
  assert.equal(r.fixed, "$env:A='1' && echo $other");
});

test("DEV_NULL: all three redirect forms", () => {
  assert.equal(fixed("foo > /dev/null"), "foo > $null");
  assert.equal(fixed("foo 2>/dev/null"), "foo 2> $null");
  assert.equal(fixed("foo &> /dev/null"), "foo *> $null");
});

test("AND_OR_CHAIN: split on powershell51", () => {
  assert.equal(fixed("a && b", WIN51), "a; if ($?) { b }");
  assert.equal(fixed("a || b", WIN51), "a; if (-not $?) { b }");
});

test("AND_OR_CHAIN: kept native on pwsh 7+", () => {
  assert.equal(fixed("a && b", WIN7), "a && b");
});

test("LS_FLAGS: -la becomes Get-ChildItem -Force", () => {
  assert.equal(fixed("ls -la C:\\x"), "Get-ChildItem C:\\x -Force");
});

test("LS_FLAGS: bare ls untouched (alias works)", () => {
  assert.equal(fixed("ls"), "ls");
});

test("RM_FLAGS: rm -rf", () => {
  assert.equal(fixed("rm -rf ./build"), "Remove-Item ./build -Recurse -Force");
});

test("MKDIR_P: single path", () => {
  assert.equal(fixed("mkdir -p a/b/c"), "New-Item -ItemType Directory -Force a/b/c");
});

test("TOUCH: creates/updates file", () => {
  assert.equal(
    fixed("touch f.txt"),
    "if (Test-Path f.txt) { (Get-Item f.txt).LastWriteTime = Get-Date } else { New-Item -ItemType File f.txt | Out-Null }",
  );
});

test("GREP: basic", () => {
  assert.equal(fixed("grep foo bar.txt"), "Select-String -Pattern foo -Path bar.txt");
});

test("GREP: -r recurses via Get-ChildItem", () => {
  assert.equal(fixed("grep -r foo src"), "Get-ChildItem src -Recurse -File | Select-String -Pattern foo");
});

test("GREP: -v inverts", () => {
  assert.equal(fixed("grep -v foo bar.txt"), "Select-String -Pattern foo -Path bar.txt -NotMatch");
});

test("WHICH", () => {
  assert.equal(fixed("which node"), "(Get-Command node -ErrorAction SilentlyContinue).Source");
  assert.equal(fixed("command -v node"), "(Get-Command node -ErrorAction SilentlyContinue).Source");
});

test("HEAD_TAIL", () => {
  assert.equal(fixed("head -n 5 f.txt"), "Get-Content f.txt -TotalCount 5");
  assert.equal(fixed("tail -f log.txt"), "Get-Content log.txt -Wait");
  assert.equal(fixed("tail -n 3 f.txt"), "Get-Content f.txt -Tail 3");
});

test("SED_AWK: warn only", () => {
  const r = fix("sed 's/a/b/' f.txt", WIN);
  assert.equal(r.changed, false);
  assert.ok(r.warnings.some((w) => w.rule === "SED_AWK"));
});

test("CHMOD: warn only", () => {
  const r = fix("chmod +x run.sh", WIN);
  assert.ok(r.warnings.some((w) => w.rule === "CHMOD"));
});

test("BARE_VAR: suggests $env: but does not rewrite", () => {
  const r = fix("echo $PATH", WIN);
  assert.ok(r.warnings.some((w) => w.rule === "BARE_VAR" && w.note.includes("$env:PATH")));
});

test("PS_SYNTAX_ON_BASH: warns on linux", () => {
  const r = fix("Get-ChildItem", LINUX);
  assert.ok(r.warnings.some((w) => w.rule === "PS_SYNTAX_ON_BASH"));
});

// ── 无误伤回归集(正确 PowerShell 命令必须原样放行)────────────────

const CORRECT_PS = [
  "Get-ChildItem -Force",
  "$env:FOO = 'bar'",
  "Get-Content file.txt | Select-String 'x'",
  "Remove-Item .\\tmp -Recurse -Force",
  "a && b",
  "$x = Get-Date",
  "Get-ChildItem |\n    Sort-Object Name",
  "mkdir newdir",
  "rm file.txt",
  "New-Item -ItemType Directory -Force a\\b",
  "Get-Command node",
  "@('a','b') | ForEach-Object { Write-Output $_ }",
];

test("no false positives on correct PowerShell (pwsh 7 baseline)", () => {
  for (const cmd of CORRECT_PS) {
    const r = fix(cmd, WIN7);
    assert.equal(r.changed, false, `must stay unchanged: ${JSON.stringify(cmd)} -> ${JSON.stringify(r.fixed)}`);
  }
});

test("on powershell51 a bare && chain IS fixed (host-engine semantics)", () => {
  const r = fix("a && b", WIN51);
  assert.equal(r.changed, true);
});

// ── 原生程序多行参数 / here-string 插值(实际踩过的坑) ────────────────

test("NATIVE_MULTILINE_ARG: multi-line argument to a native program warns", () => {
  const r = fix('git commit -m "fix: subject\n\nbody line"', WIN51);
  assert.ok(
    r.warnings.some((w) => w.rule === "NATIVE_MULTILINE_ARG"),
    "PowerShell 5.1 re-tokenizes this and git sees a pathspec",
  );
});

test("NATIVE_MULTILINE_ARG: single-line quoted argument does not warn", () => {
  const r = fix('git commit -m "one line"', WIN51);
  assert.ok(!r.warnings.some((w) => w.rule === "NATIVE_MULTILINE_ARG"));
});

test("NATIVE_MULTILINE_ARG: a cmdlet taking a multi-line value does not warn", () => {
  const r = fix('Set-Content -Path a.txt -Value "x\ny"', WIN51);
  assert.ok(!r.warnings.some((w) => w.rule === "NATIVE_MULTILINE_ARG"));
});

test("NATIVE_MULTILINE_ARG: here-strings are left to HERESTRING_*", () => {
  const r = fix('node -e @"\nconsole.log(1)\n"@', WIN51);
  assert.ok(!r.warnings.some((w) => w.rule === "NATIVE_MULTILINE_ARG"));
});

test("HERESTRING_DOLLAR: interpolating here-string warns", () => {
  const r = fix('Set-Content -Path a.txt -Value @"\nHello $name\n"@', WIN51);
  assert.ok(r.warnings.some((w) => w.rule === "HERESTRING_DOLLAR"));
});

test("HERESTRING_DOLLAR: single-quoted here-string stays silent", () => {
  const r = fix("Set-Content -Path a.txt -Value @'\nHello $name\n'@", WIN51);
  assert.ok(!r.warnings.some((w) => w.rule === "HERESTRING_DOLLAR"));
});
