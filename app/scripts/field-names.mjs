// 개발용: 세션 기록의 줄 종류별 "칸 이름"만 세어 보여 줘요. 값은 한 글자도 찍지 않아요.
// 기록 형식 가정(custom-title의 customTitle, last-prompt의 lastPrompt, cost-state의 칸 이름 등)을 확인할 때 써요.
// 사용법: node scripts/field-names.mjs <projects 폴더> [최대 파일 수]
// 패키지에는 들어가지 않아요(package.json files에 없음).
import { createReadStream, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const root = process.argv[2];
const maxFiles = Number(process.argv[3] ?? 50);
if (!root) {
  console.error('사용법: node scripts/field-names.mjs <projects 폴더> [최대 파일 수]');
  process.exit(1);
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// 칸 이름 모양만 남겨요. 이름이 아닌 것(경로처럼 보이는 키 등)은 <key>로 바꿔요.
const safeKey = (k) => (/^[A-Za-z_][A-Za-z0-9_-]{0,40}$/.test(k) ? k : '<key>');
const safeType = (t) => (typeof t === 'string' && /^[a-z0-9_-]{1,40}$/i.test(t) ? t : '<type>');

function keyPaths(v, prefix, depth, out) {
  if (depth > 3 || v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    for (const x of v.slice(0, 20)) {
      if (x && typeof x === 'object' && !Array.isArray(x) && 'type' in x) out.add(`${prefix}[].type=${safeType(x.type)}`);
      keyPaths(x, `${prefix}[]`, depth + 1, out);
    }
    return;
  }
  for (const [k, val] of Object.entries(v)) {
    const p = prefix ? `${prefix}.${safeKey(k)}` : safeKey(k);
    out.add(`${p}:${Array.isArray(val) ? 'array' : val === null ? 'null' : typeof val}`);
    keyPaths(val, p, depth + 1, out);
  }
}

const stats = new Map(); // type -> { lines, keys: Map<path, count> }
let broken = 0;
const files = walk(root).slice(0, maxFiles);
for (const file of files) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      broken++;
      continue;
    }
    const t = safeType(o?.type);
    const s = stats.get(t) ?? { lines: 0, keys: new Map() };
    s.lines++;
    const paths = new Set();
    keyPaths(o, '', 0, paths);
    for (const p of paths) s.keys.set(p, (s.keys.get(p) ?? 0) + 1);
    stats.set(t, s);
  }
}

console.log(`파일 ${files.length}개 · 읽을 수 없는 줄 ${broken}개`);
for (const [t, s] of [...stats.entries()].sort((a, b) => b[1].lines - a[1].lines)) {
  console.log(`\n[${t}] ${s.lines}줄`);
  for (const [p, n] of [...s.keys.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) console.log(`  ${p}  (${n})`);
}
