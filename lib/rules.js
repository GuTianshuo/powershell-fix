/**
 * 规则表:每条规则 { id, severity, applies(env), run(text, env) -> {text?, notes[]} }。
 * - severity 'fix':run 返回改写后的 text(未命中时原样返回、notes 为空)。
 * - severity 'warn':不改写,仅产出 notes。
 * 规则必须幂等:run(run(x)) === run(x)。
 *
 * env = { platform, shell } —— shell ∈ pwsh | powershell51 | bash。
 */

import { isWindowsShell } from "./detect.js";

// ── 工具函数 ────────────────────────────────────────────────────────

/** 行内引号是否配对(未转义的 " 与 ' 分别计数)。奇数 = 未闭合。 */
export function quoteBalanced(line) {
  let d = 0, s = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) { i++; continue; }
    if (c === '"') d++;
    else if (c === "'") s++;
  }
  return d % 2 === 0 && s % 2 === 0;
}

function mapLines(text, fn) {
  return text.split("\n").map(fn).join("\n");
}

/** 把 bash 风格的值整理为 PS 单引号字面量:去外层引号、内部单引号翻倍。 */
function psSingleQuote(value) {
  let v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
    v = v.slice(1, -1);
  }
  return `'${v.replace(/'/g, "''")}'`;
}

// ── 3.1 换行/续行/粘贴卫生 ─────────────────────────────────────────

export const NORM_LINEENDINGS = {
  id: "NORM_LINEENDINGS",
  severity: "fix",
  applies: () => true,
  run(text) {
    if (!/\r/.test(text)) return { text, notes: [] };
    return { text: text.replace(/\r\n?/g, "\n"), notes: ["normalized CRLF/CR line endings to LF"] };
  },
};

const PS_PATH_PROMPT = /^[ \t]*PS\s+[^>]*>[ \t]?/;
const CMD_PATH_PROMPT = /^[ \t]*[A-Za-z]:\\[^>]*>[ \t]?/;
const SINGLE_CHAR_PROMPT = /^[ \t]*([$#>])[ \t]+/;

export const STRIP_PROMPT = {
  id: "STRIP_PROMPT",
  severity: "fix",
  applies: () => true,
  run(text) {
    const lines = text.split("\n");
    // 单字符提示符($/#/>):仅当多数非空行都以同一字符开头才判定为粘贴提示符,
    // 避免误伤单条 `$var` 赋值或 bash 注释。
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    const votes = {};
    for (const l of nonEmpty) {
      const m = l.match(SINGLE_CHAR_PROMPT);
      if (m) votes[m[1]] = (votes[m[1]] ?? 0) + 1;
    }
    const dominant = Object.entries(votes).find(([ch, n]) => n >= Math.max(2, Math.ceil(nonEmpty.length * 0.5)));
    const domChar = dominant ? dominant[0] : null;
    let changed = false;
    const out = lines.map((line) => {
      if (PS_PATH_PROMPT.test(line) || CMD_PATH_PROMPT.test(line)) {
        changed = true;
        return line.replace(PS_PATH_PROMPT, "").replace(CMD_PATH_PROMPT, "");
      }
      if (domChar) {
        const m = line.match(SINGLE_CHAR_PROMPT);
        if (m && m[1] === domChar) {
          changed = true;
          return line.replace(SINGLE_CHAR_PROMPT, "");
        }
      }
      return line;
    });
    return changed
      ? { text: out.join("\n"), notes: ["stripped pasted shell prompt(s)"] }
      : { text, notes: [] };
  },
};

/** 续行符后的尾随空白(肉眼不可见的续行失效)——两种 shell 通用。 */
export const CONT_TRAILING_SPACE = {
  id: "CONT_TRAILING_SPACE",
  severity: "fix",
  applies: () => true,
  run(text) {
    let changed = false;
    const out = mapLines(text, (line) => {
      if (/[\\`][ \t]+$/.test(line)) {
        changed = true;
        return line.replace(/([\\`])[ \t]+$/, "$1");
      }
      return line;
    });
    return changed ? { text: out, notes: ["removed trailing whitespace after line-continuation character"] } : { text, notes: [] };
  },
};

export const LC_BACKSLASH_TO_BACKTICK = {
  id: "LC_BACKSLASH_TO_BACKTICK",
  severity: "fix",
  applies: (env) => isWindowsShell(env.shell),
  run(text) {
    let changed = false;
    const out = mapLines(text, (line) => {
      // 引号未闭合时,行尾 \ 可能是字符串转义而非续行 —— 不动
      if (/\\[ \t]*$/.test(line) && !/\\{2}[ \t]*$/.test(line) && quoteBalanced(line)) {
        changed = true;
        return line.replace(/\\[ \t]*$/, "`");
      }
      return line;
    });
    return changed ? { text: out, notes: ["converted bash line-continuation '\\' to PowerShell backtick"] } : { text, notes: [] };
  },
};

export const LC_BACKTICK_TO_BACKSLASH = {
  id: "LC_BACKTICK_TO_BACKSLASH",
  severity: "fix",
  applies: (env) => env.shell === "bash",
  run(text) {
    let changed = false;
    const out = mapLines(text, (line) => {
      if (/`[ \t]*$/.test(line) && quoteBalanced(line)) {
        changed = true;
        return line.replace(/`[ \t]*$/, "\\");
      }
      return line;
    });
    return changed ? { text: out, notes: ["converted PowerShell line-continuation backtick to bash '\\'"] } : { text, notes: [] };
  },
};

/** 行尾是 PS 天然续行点(无需反引号即可换行)。 */
const PS_NATURAL_CONT = /(?:\||,|&&|\|\||\(|\{|\[)[ \t]*$/;
const PARAM_START = /^[ \t]+-[A-Za-z][A-Za-z0-9]*\b/;

export const LC_MISSING_CONT = {
  id: "LC_MISSING_CONT",
  severity: "fix",
  applies: (env) => isWindowsShell(env.shell),
  run(text) {
    const lines = text.split("\n");
    let changed = false;
    for (let i = 0; i < lines.length - 1; i++) {
      const cur = lines[i];
      const nxt = lines[i + 1];
      if (!cur.trim() || !nxt.trim()) continue;
      if (/[`|,({\[]\s*$/.test(cur) || /&&\s*$/.test(cur) || /\|\|\s*$/.test(cur)) continue;
      if (!quoteBalanced(cur)) continue;              // 跨行字符串本身合法
      if (PARAM_START.test(nxt) && !PS_NATURAL_CONT.test(cur)) {
        lines[i] = cur.replace(/[ \t]*$/, " `");
        changed = true;
      }
    }
    return changed
      ? { text: lines.join("\n"), notes: ["added missing backtick before parameter-style continuation line(s)"] }
      : { text, notes: [] };
  },
};

export const LC_DANGLING_BACKTICK = {
  id: "LC_DANGLING_BACKTICK",
  severity: "fix",
  applies: (env) => isWindowsShell(env.shell),
  run(text) {
    const lines = text.split("\n");
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      if (/`[ \t]*$/.test(lines[i])) {
        const next = lines[i + 1];
        if (next === undefined || next.trim() === "") {
          lines[i] = lines[i].replace(/`[ \t]*$/, "");
          changed = true;
        }
      }
    }
    return changed ? { text: lines.join("\n"), notes: ["removed dangling line-continuation backtick"] } : { text, notes: [] };
  },
};

export const QUOTE_BALANCE = {
  id: "QUOTE_BALANCE",
  severity: "warn",
  applies: () => true,
  run(text) {
    const notes = [];
    if (!quoteBalanced(text.replace(/\n/g, ""))) {
      notes.push("unbalanced quotes across the command — check multi-line string boundaries");
    }
    return { text, notes };
  },
};

// ── 3.2 bash → PowerShell 语义规则 ────────────────────────────────

// 未加引号的值在空白或 shell 元字符(; & |)处截止,避免吞掉后续语句
const EXPORT_PAIR = /([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^;&|\s]+)/g;

export const ENV_EXPORT = {
  id: "ENV_EXPORT",
  severity: "fix",
  applies: (env) => isWindowsShell(env.shell),
  run(text) {
    let changed = false;
    const out = mapLines(text, (line) => {
      const m = line.match(/^([ \t]*)export[ \t]+(.*)$/);
      if (!m) return line;
      const rest = m[2];
      const re = new RegExp(EXPORT_PAIR.source, "g");
      const parts = [];
      let lastEnd = 0;
      let pm;
      while ((pm = re.exec(rest)) !== null) {
        // 首个配对之前若有非空白内容,说明不是纯 export 赋值 → 不动
        if (parts.length === 0 && rest.slice(0, pm.index).trim() !== "") return line;
        parts.push(`$env:${pm[1]}=${psSingleQuote(pm[2])}`);
        lastEnd = re.lastIndex;
      }
      if (parts.length === 0) return line;
      changed = true;
      const tail = rest.slice(lastEnd).trim();   // 保留行内剩余部分(如 && 链)
      const head = m[1] + parts.join("; ");
      if (!tail) return head;
      return tail.startsWith(";") ? `${head}${tail}` : `${head} ${tail}`;
    });
    return changed ? { text: out, notes: ["converted 'export NAME=VAL' to $env:NAME assignment"] } : { text, notes: [] };
  },
};

export const ENV_UNSET = {
  id: "ENV_UNSET",
  severity: "fix",
  applies: (env) => isWindowsShell(env.shell),
  run(text) {
    let changed = false;
    // ① 整行 unset
    let out = mapLines(text, (line) => {
      const m = line.match(/^([ \t]*)unset[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*$/);
      if (!m) return line;
      changed = true;
      // 守卫式:变量不存在时 Remove-Item Env: 会抛终止性错误(5.1 尤甚)
      return `${m[1]}if (Test-Path Env:${m[2]}) { Remove-Item Env:${m[2]} }`;
    });
    // ② 链内 inline unset(`a && unset X && b`):仅处理引号配对的行
    out = mapLines(out, (line) => {
      if (!quoteBalanced(line)) return line;
      return line.replace(
        /(^|&&|\|\||[;&])([ \t]*)unset[ \t]+([A-Za-z_][A-Za-z0-9_]*)(?=[ \t]*(?:$|&&|\|\||[;&]))/g,
        (_all, sep, ws, name) => {
          changed = true;
          return `${sep}${ws}if (Test-Path Env:${name}) { Remove-Item Env:${name} }`;
        },
      );
    });
    return changed ? { text: out, notes: ["converted 'unset NAME' to guarded Remove-Item Env:NAME"] } : { text, notes: [] };
  },
};

/**
 * 同一命令内 export 过的变量,后续 `$NAME`/`${NAME}` 引用改写为 `$env:NAME`。
 * 只改写已被 `$env:NAME=` 赋值捕获的名字(bash 语义:同脚本内可见),
 * 不碰其他 `$var`(可能是 PowerShell 变量,仅由 BARE_VAR 告警)。
 */
export const ENV_LOCAL_REF = {
  id: "ENV_LOCAL_REF",
  severity: "fix",
  applies: (env) => isWindowsShell(env.shell),
  run(text) {
    const names = new Set();
    for (const m of text.matchAll(/\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) names.add(m[1]);
    if (names.size === 0) return { text, notes: [] };
    let out = text;
    for (const n of names) {
      out = out.replace(new RegExp(`\\$\\{${n}\\}`, "g"), `$env:${n}`);
      out = out.replace(new RegExp(`\\$${n}(?![A-Za-z0-9_])`, "g"), `$env:${n}`);
    }
    return out !== text
      ? { text: out, notes: ["rewrote same-command $VAR references of exported names to $env:VAR"] }
      : { text, notes: [] };
  },
};

export const DEV_NULL = {
  id: "DEV_NULL",
  severity: "fix",
  applies: (env) => isWindowsShell(env.shell),
  run(text) {
    if (!/\/dev\/null/.test(text)) return { text, notes: [] };
    const out = text
      .replace(/&>\s*\/dev\/null/g, "*> $null")
      .replace(/2>\s*\/dev\/null/g, "2> $null")
      .replace(/>\s*\/dev\/null/g, "> $null");
    return { text: out, notes: ["replaced /dev/null redirection with $null"] };
  },
};

/** 在引号外拆分链式操作符(&& / ||)。 */
export function splitTopLevelChain(line) {
  const parts = [];
  let buf = "", inD = false, inS = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) { buf += c + line[i + 1]; i++; continue; }
    if (c === '"' && !inS) inD = !inD;
    if (c === "'" && !inD) inS = !inS;
    if (!inD && !inS && (line.startsWith("&&", i) || line.startsWith("||", i))) {
      parts.push({ text: buf.trim(), op: null });
      parts.push({ op: line.slice(i, i + 2) });
      buf = "";
      i++;
      continue;
    }
    buf += c;
  }
  parts.push({ text: buf.trim(), op: null });
  const segs = parts.filter((p) => p.op === null);
  const ops = parts.filter((p) => p.op).map((p) => p.op);
  return ops.length > 0 ? { segs: segs.map((s) => s.text), ops } : null;
}

export const AND_OR_CHAIN = {
  id: "AND_OR_CHAIN",
  severity: "fix",
  applies: (env) => env.shell === "powershell51", // pwsh 7+ 原生支持 && / ||
  run(text) {
    let changed = false;
    const out = mapLines(text, (line) => {
      if (!/&&|\|\|/.test(line)) return line;
      const chain = splitTopLevelChain(line);
      if (!chain) return line;
      changed = true;
      let acc = chain.segs[0];
      for (let i = 0; i < chain.ops.length; i++) {
        const wrap = chain.ops[i] === "&&" ? "; if ($?) { " : "; if (-not $?) { ";
        acc = `${acc}${wrap}${chain.segs[i + 1]} }`;
      }
      return acc;
    });
    return changed
      ? { text: out, notes: ["split && / || chain for Windows PowerShell 5.1 (pwsh 7+ keeps it native)"] }
      : { text, notes: [] };
  },
};

export const LS_FLAGS = {
  id: "LS_FLAGS",
  severity: "fix",
  applies: (env) => isWindowsShell(env.shell),
  run(text) {
    let changed = false;
    const out = mapLines(text, (line) => {
      const m = line.match(/^([ \t]*)ls(?:\.exe)?[ \t]+(.*)$/);
      if (!m) return line;
      const tokens = m[2].split(/\s+/).filter(Boolean);
      const flags = [];
      const paths = [];
      for (const t of tokens) {
        if (/^-[laRFh]+$/.test(t)) flags.push(...t.slice(1));
        else paths.push(t);
      }
      if (flags.length === 0) return line; // 无旗标时 ls 别名本身可用
      changed = true;
      const target = paths.length > 0 ? paths.join(" ") : "";
      const force = flags.includes("a") ? " -Force" : "";
      return `${m[1]}Get-ChildItem${target ? " " + target : ""}${force}`;
    });
    return changed ? { text: out, notes: ["converted 'ls -flags' to Get-ChildItem (PS alias exists but bash flags are invalid)"] } : { text, notes: [] };
  },
};

export const RM_FLAGS = {
  id: "RM_FLAGS",
  severity: "fix",
  applies: (env) => isWindowsShell(env.shell),
  run(text) {
    let changed = false;
    const out = mapLines(text, (line) => {
      const m = line.match(/^([ \t]*)rm(?:\.exe)?[ \t]+((?:-[A-Za-z]+[ \t]+)+)(.+)$/);
      if (!m) return line;
      const flagChars = new Set(m[2].replace(/-/g, "").replace(/\s/g, "").split(""));
      changed = true;
      const target = m[3].trim();
      let cmd = `Remove-Item ${target}`;
      if (flagChars.has("r") || flagChars.has("R")) cmd += " -Recurse";
      if (flagChars.has("f")) cmd += " -Force";
      return m[1] + cmd;
    });
    return changed ? { text: out, notes: ["converted 'rm -flags' to Remove-Item"] } : { text, notes: [] };
  },
};

export const MKDIR_P = {
  id: "MKDIR_P",
  severity: "fix",
  applies: (env) => isWindowsShell(env.shell),
  run(text) {
    let changed = false;
    const out = mapLines(text, (line) => {
      const m = line.match(/^([ \t]*)mkdir[ \t]+-p[ \t]+(.+)$/);
      if (!m) return line;
      changed = true;
      const paths = m[2].trim().split(/\s+/);
      if (paths.length === 1) return `${m[1]}New-Item -ItemType Directory -Force ${paths[0]}`;
      return `${m[1]}@(${paths.map((p) => `'${p}'`).join(", ")}) | ForEach-Object { New-Item -ItemType Directory -Force $_ }`;
    });
    return changed ? { text: out, notes: ["converted 'mkdir -p' to New-Item -ItemType Directory -Force"] } : { text, notes: [] };
  },
};

export const TOUCH = {
  id: "TOUCH",
  severity: "fix",
  applies: (env) => isWindowsShell(env.shell),
  run(text) {
    let changed = false;
    const out = mapLines(text, (line) => {
      const m = line.match(/^([ \t]*)touch[ \t]+(.+)$/);
      if (!m) return line;
      changed = true;
      const paths = m[2].trim().split(/\s+/);
      const one = (p) => `if (Test-Path ${p}) { (Get-Item ${p}).LastWriteTime = Get-Date } else { New-Item -ItemType File ${p} | Out-Null }`;
      if (paths.length === 1) return m[1] + one(paths[0]);
      return `${m[1]}@(${paths.map((p) => `'${p}'`).join(", ")}) | ForEach-Object { ${one("$_")} }`;
    });
    return changed ? { text: out, notes: ["converted 'touch' to Test-Path/New-Item timestamp update"] } : { text, notes: [] };
  },
};

export const GREP = {
  id: "GREP",
  severity: "fix",
  applies: (env) => isWindowsShell(env.shell),
  run(text) {
    let changed = false;
    const out = mapLines(text, (line) => {
      const m = line.match(/^([ \t]*)grep[ \t]+(.*)$/);
      if (!m) return line;
      const tokens = [];
      const re = /("[^"]*"|'[^']*'|\S+)/g;
      let suffix = "";
      for (const t of m[2].matchAll(re)) {
        // 重定向及其后内容保持原位,不当作 grep 参数
        if (/^(?:\d?>>?|&>)$/.test(t[1])) {
          suffix = m[2].slice(t.index).trim();
          break;
        }
        tokens.push(t[1]);
      }
      let recursive = false, invert = false;
      const rest = [];
      for (const t of tokens) {
        if (/^-[A-Za-z]+$/.test(t)) {
          const chars = t.slice(1);
          if (/[rievn]/.test(chars) && !/[^rievn]/.test(chars)) {
            if (chars.includes("r")) recursive = true;
            if (chars.includes("v")) invert = true;
            // i/n: Select-String 默认行为已接近,不再映射
          } else {
            return line; // 复杂旗标 → 不自动改(由 warn 规则提示)
          }
        } else rest.push(t);
      }
      if (rest.length < 2) return line; // 缺 pattern/file 的管道用法(grep x | ...)不处理
      const pattern = rest[0];
      const files = rest.slice(1);
      changed = true;
      const notMatch = invert ? " -NotMatch" : "";
      const tail = suffix ? ` ${suffix}` : "";
      if (recursive) {
        return `${m[1]}Get-ChildItem ${files.join(", ")} -Recurse -File | Select-String -Pattern ${pattern}${notMatch}${tail}`;
      }
      return `${m[1]}Select-String -Pattern ${pattern} -Path ${files.join(", ")}${notMatch}${tail}`;
    });
    return changed ? { text: out, notes: ["converted 'grep' to Select-String"] } : { text, notes: [] };
  },
};

export const WHICH = {
  id: "WHICH",
  severity: "fix",
  applies: (env) => isWindowsShell(env.shell),
  run(text) {
    let changed = false;
    const out = mapLines(text, (line) => {
      const m = line.match(/^([ \t]*)(?:which|command[ \t]+-v)[ \t]+(\S+)[ \t]*$/);
      if (!m) return line;
      changed = true;
      return `${m[1]}(Get-Command ${m[2]} -ErrorAction SilentlyContinue).Source`;
    });
    return changed ? { text: out, notes: ["converted 'which'/'command -v' to Get-Command"] } : { text, notes: [] };
  },
};

export const HEAD_TAIL = {
  id: "HEAD_TAIL",
  severity: "fix",
  applies: (env) => isWindowsShell(env.shell),
  run(text) {
    let changed = false;
    const out = mapLines(text, (line) => {
      let m = line.match(/^([ \t]*)head[ \t]+(?:-n[ \t]*(\d+)[ \t]+)?(.+)$/);
      if (m) {
        changed = true;
        return `${m[1]}Get-Content ${m[3].trim()} -TotalCount ${m[2] ?? 10}`;
      }
      m = line.match(/^([ \t]*)tail[ \t]+-f[ \t]+(.+)$/);
      if (m) {
        changed = true;
        return `${m[1]}Get-Content ${m[2].trim()} -Wait`;
      }
      m = line.match(/^([ \t]*)tail[ \t]+(?:-n[ \t]*(\d+)[ \t]+)?(.+)$/);
      if (m) {
        changed = true;
        return `${m[1]}Get-Content ${m[3].trim()} -Tail ${m[2] ?? 10}`;
      }
      return line;
    });
    return changed ? { text: out, notes: ["converted 'head'/'tail' to Get-Content"] } : { text, notes: [] };
  },
};

// ── warn 规则(不改写)─────────────────────────────────────────────

export const SED_AWK = {
  id: "SED_AWK",
  severity: "warn",
  applies: (env) => isWindowsShell(env.shell),
  run(text) {
    const notes = [];
    if (/^[ \t]*sed\b/m.test(text)) notes.push("'sed' has no native equivalent — consider -replace, Select-String, or ForEach-Object");
    if (/^[ \t]*awk\b/m.test(text)) notes.push("'awk' has no native equivalent — consider ForEach-Object with -split");
    return { text, notes };
  },
};

export const CHMOD = {
  id: "CHMOD",
  severity: "warn",
  applies: (env) => isWindowsShell(env.shell),
  run(text) {
    return /^[ \t]*chmod\b/m.test(text)
      ? { text, notes: ["'chmod' has no direct Windows equivalent (ACL-based; see icacls)"] }
      : { text, notes: [] };
  },
};

const KNOWN_ENV_VARS = "PATH|HOME|USER|USERNAME|TEMP|TMP|APPDATA|PROGRAMFILES|SYSTEMROOT|HOMEPATH|USERPROFILE";
const BARE_VAR_RE = new RegExp(`\\$(${KNOWN_ENV_VARS})\\b`, "g");

export const BARE_VAR = {
  id: "BARE_VAR",
  severity: "warn",
  applies: (env) => isWindowsShell(env.shell),
  run(text) {
    const notes = [];
    const seen = new Set();
    for (const m of text.matchAll(BARE_VAR_RE)) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        notes.push(`'$${m[1]}' as a bare shell variable is usually the environment variable — use $env:${m[1]} on Windows`);
      }
    }
    return { text, notes };
  },
};

export const PS_SYNTAX_ON_BASH = {
  id: "PS_SYNTAX_ON_BASH",
  severity: "warn",
  applies: (env) => env.shell === "bash",
  run(text) {
    const notes = [];
    if (/\$env:[A-Za-z_]/.test(text)) notes.push("$env:NAME is PowerShell syntax — use $NAME or export on bash");
    if (/`[ \t]*$/m.test(text)) notes.push("backtick line-continuation is PowerShell syntax — use '\\' on bash");
    if (/^[ \t]*(?:Get|Set|New|Remove|Test|Select)-[A-Za-z]+\b/m.test(text)) notes.push("Verb-Noun cmdlets are PowerShell-only");
    return { text, notes };
  },
};

// ── 原生程序的参数编组:多行字符串会被 5.1 拆坏 ────────────────────
//
// 这是实际踩过的坑,不是理论问题:Windows PowerShell 5.1 把参数交给原生 exe 时,
// 多行字符串会被重新分词,`git commit -m "<三行>"` 到 git 那里可能变成
// -m "<第一行>" 加若干 pathspec,于是报 "did not match any file(s) known to git"。
// 不能靠改引号"修好" —— 正确做法是把文本落成文件再用文件参数
// (git commit -F、git tag -F、gh --body-file)。
const NATIVE_EXE_NAMES = new Set([
  "git", "node", "npm", "npx", "pnpm", "yarn", "python", "py", "pip",
  "curl", "wget", "gh", "taskkill", "robocopy", "msiexec", "reg", "sc",
  "java", "javac", "jar", "cargo", "go", "docker", "kubectl", "aws", "az",
  "ffmpeg", "sqlite3", "7z", "tar", "ida", "ida64", "objdump", "dumpbin",
]);

/** 第一条可执行语句的命令词:去引号、去路径、去 .exe、小写。 */
function firstCommandWord(text) {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:&\s*)?["']?([^\s"'&|;]+)["']?/);
    if (!m) continue;
    return m[1].replace(/\\/g, "/").split("/").pop().replace(/\.exe$/i, "").toLowerCase();
  }
  return "";
}

/** 是否有跨行的普通引号字符串(here-string 先剔除,由 HERESTRING_* 负责)。 */
function hasMultilineQuotedArg(text) {
  const scan = text.replace(/@(["'])\r?\n[\s\S]*?\r?\n\1@/g, "");
  for (const q of ['"', "'"]) {
    let i = 0;
    for (;;) {
      const open = scan.indexOf(q, i);
      if (open === -1) break;
      const close = scan.indexOf(q, open + 1);
      if (close === -1) break;
      if (scan.slice(open + 1, close).includes("\n")) return true;
      i = close + 1;
    }
  }
  return false;
}

export const NATIVE_MULTILINE_ARG = {
  id: "NATIVE_MULTILINE_ARG",
  severity: "warn",
  applies: (env) => isWindowsShell(env.shell),
  run(text) {
    if (!hasMultilineQuotedArg(text)) return { text, notes: [] };
    const word = firstCommandWord(text);
    if (!NATIVE_EXE_NAMES.has(word)) return { text, notes: [] };
    return {
      text,
      notes: [
        `'${word}' is a native program receiving a multi-line quoted argument; Windows PowerShell 5.1 ` +
          "re-tokenizes it, so the program sees extra arguments (this is how 'git commit -m \"<text>\"' " +
          "becomes a pathspec error). Write the text to a file and use the file-based flag instead " +
          "(git commit -F <file>, git tag -F <file>, gh --body-file <file>).",
      ],
    };
  },
};

// ── 双引号 here-string 会插值 ──────────────────────────────────────
//
// @"…"@ 里的 $ 会被展开,想写字面量必须用 @'…'@。搞混的后果是文本被静默吃掉
// 一段(例如把 "$VAR" 写成 "``\``"),而不是报错。
export const HERESTRING_DOLLAR = {
  id: "HERESTRING_DOLLAR",
  severity: "warn",
  applies: () => true,
  run(text) {
    for (const m of text.matchAll(/@"\r?\n([\s\S]*?)\r?\n"@/g)) {
      if (!/\$/.test(m[1])) continue;
      const sample = (m[1].match(/\$[A-Za-z_{][\w:{}.]*/) || ["$…"])[0];
      return {
        text,
        notes: [
          `double-quoted here-string ("@ … "@) interpolates: '${sample}' is expanded, not literal. ` +
            "For literal text use the single-quoted form ('@ … '@).",
        ],
      };
    }
    return { text, notes: [] };
  },
};

// ── 规则排序(应用顺序)────────────────────────────────────────────

export const FIX_RULES = [
  NORM_LINEENDINGS,
  STRIP_PROMPT,
  CONT_TRAILING_SPACE,
  LC_BACKSLASH_TO_BACKTICK,
  LC_BACKTICK_TO_BACKSLASH,
  LC_DANGLING_BACKTICK,
  LC_MISSING_CONT,
  ENV_EXPORT,
  ENV_UNSET,
  ENV_LOCAL_REF,
  DEV_NULL,
  AND_OR_CHAIN,
  LS_FLAGS,
  RM_FLAGS,
  MKDIR_P,
  TOUCH,
  GREP,
  WHICH,
  HEAD_TAIL,
];

export const WARN_RULES = [
  QUOTE_BALANCE,
  SED_AWK,
  CHMOD,
  BARE_VAR,
  NATIVE_MULTILINE_ARG,
  HERESTRING_DOLLAR,
  PS_SYNTAX_ON_BASH,
];
