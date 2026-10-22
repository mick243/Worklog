// 개발 8회차 시험: 취합 13회차 차이 1·5 (PRD S3·S4·A16, Q22·Q23·Q24).
//  - 한쪽만 가려진 일지를 다시 만드는 명령은 그 일지를 만든 설정과 같게 다시 만드는 명령이에요.
//    cc-worklog --date <날짜> + (이름·이메일 가리기를 켜고 만든 일지면) --hide-identity
//    + (그 일지의 하루 경계가 기본(3)이나 지금 설정과 다르면) --day-start N + (이번 실행에 줬으면) --data-dir·--claude-dir <폴더>.
//    명령 아래에 "만들 때 --root나 --claude-dir를 줬으면 같은 값을 붙이세요" 한 줄이 있어요.
//    그 명령을 그대로 실행하면 같은 설정의 일지가 다시 만들어지고 검사가 통과해요.
//  - 검사가 읽지 못한 일지·보관본·보관 색인은 일반 비밀 값 의심과 구분해 "읽지 못함"과 원인 코드로 보여 주고("모양" 없이),
//    다음: 줄은 다시 가리기가 아니라 그 파일을 연 프로그램을 닫거나 권한을 확인한 뒤 다시 검사하라는 안내예요. 통과·실패 기준은 그대로예요.
// 개발 10회차(취합 17회차 차이 3)에 더한 시험 하나: 명령 속 폴더의 두 예외(\로 끝나는 경로, \\로 시작하는 UNC 경로) 모양과,
//    그 글자를 셸 없이 인자 규칙으로 되돌려 resolve하면 원래 폴더인지(실제 공유 폴더·드라이브에는 접속하지 않아요).
// 모든 시험은 임시 폴더의 가짜 세션 기록·임시 저장소로만 해요. 바꾼 잠금·권한·환경 변수는 시험 안에서 모두 되돌려요.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants, cpSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { test } from 'node:test';
import { resolveConfig } from '../src/config.js';
import { remakeCommand, remakeContext, REMAKE_HINT, shellPath } from '../src/worklog/mismatch.js';
import type { DayLog } from '../src/worklog/types.js';
import {
  asOldVersionWorklog,
  assistantText,
  CLI,
  commitAt,
  initRepo,
  kst,
  listFilesRec,
  NO_NET,
  readJson,
  rowText,
  runCli,
  sandbox,
  userText,
  writeSession,
  type CliResult,
  type Sandbox,
} from './helpers.js';

const DATE = '2026-10-16';
const ME = 'dev.kim@example.test';
const T1 = 'CORP-12345678';
const T2 = 'CORP-87654321';
const LABEL = '헤더 문구';
const PATTERNS = JSON.stringify([{ name: LABEL, pattern: 'CORP-[0-9]{8}', samples: ['CORP-00000000'] }]);
const SID = 'f8000000-0000-4000-8000-000000000001';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const lockSkip = isRoot ? 'POSIX root는 파일 권한을 무시해서 잠금을 흉내 낼 수 없어요' : false;
/** libuv: Windows에서 공유 없이(FILE_SHARE 0) 여는 플래그. 다른 프로그램이 FileShare.None으로 연 것과 같아요. */
const UV_FS_O_EXLOCK = 0x10000000;

/** 파일을 잠가요(Windows는 공유 없이 열어 두고, 그 밖의 OS는 권한을 모두 빼요). 돌려준 함수로 꼭 풀어요. */
function lockFile(path: string): () => void {
  if (process.platform === 'win32') {
    const fd = openSync(path, constants.O_RDWR | UV_FS_O_EXLOCK);
    let open = true;
    return () => {
      if (open) closeSync(fd);
      open = false;
    };
  }
  const mode = statSync(path).mode & 0o777;
  chmodSync(path, 0o000);
  return () => chmodSync(path, mode);
}

/** 남은 의심이 있을 때의 다시 가리기 다음: 줄 (80칸에서 나뉘어도 이어 붙여 봐요) */
const REDACT_NEXT = '다음: 필요하면 사용자 패턴을 더한 뒤 cc-worklog redact를 실행하고 다시 검사하세요.';

const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * CLI를 준 인자 그대로 실행해요(runCli와 달리 --claude-dir·--data-dir를 붙이지 않아요). 네트워크는 막아요.
 * 샌드박스 환경은 HOME·USERPROFILE이 임시 폴더라서, 폴더 옵션이 없으면 샌드박스의 ~/.claude·~/.cc-worklog를 써요.
 */
function runRaw(sb: Sandbox, args: string[], cwd?: string): CliResult {
  const r = spawnSync(process.execPath, ['--require', NO_NET, CLI, ...args], {
    env: sb.env,
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 안내에 나온 명령 한 줄을 인자로 나눠요(큰따옴표로 감싼 경로는 한 덩어리). 맨 앞 cc-worklog는 빼요. */
function argsOf(command: string): string[] {
  const parts = [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
  assert.equal(parts[0], 'cc-worklog');
  return parts.slice(1);
}

/** 출력에서 n칸 들여 쓴 cc-worklog --date <날짜> 명령 줄을 모두 꺼내요. 끈 일지의 이름·이메일 [알림] 아래 명령 모양(`--date <날짜>` 글자 그대로, A19)은 빼요. */
function commandLines(out: string, indent: number): string[] {
  return out
    .split('\n')
    .filter((l) => new RegExp(`^ {${indent}}cc-worklog --date \\d{4}-`).test(l))
    .map((l) => l.trim());
}

interface Dirs {
  claudeDir: string;
  dataDir: string;
}

/**
 * 가짜 사내 토큰이 든 세션·커밋으로 makeArgs 설정의 일지를 만든 뒤 사용자 패턴을 더해 다시 가리고,
 * 마크다운만 다시 가리기 전 내용으로 되돌려 "화면용 데이터만 가려진 일지"(이전 판이 남긴 어긋남)를 만들어요.
 * run은 이번 시험의 실행 방법(폴더 옵션을 붙이는지)이에요.
 */
function makeMismatched(s: Sandbox, dirs: Dirs, run: (args: string[]) => CliResult, makeArgs: string[]): { md: string; json: string } {
  const repo = join(s.root, 'work', 'web');
  initRepo(s, repo, ME);
  commitAt(s, repo, `style: 헤더 정리 ${T2}`, `${DATE}T11:00:00+09:00`);
  const A = { sid: SID, cwd: repo };
  writeSession({ ...s, projectsDir: join(dirs.claudeDir, 'projects') }, repo, SID, [
    userText({ ...A, ts: kst(DATE, '10:00') }, `헤더 손보기 ${T1} 로 확인해 줘`),
    assistantText({ ...A, ts: kst(DATE, '10:05') }, '했어요'),
  ]);
  let r = run(['--date', DATE, ...makeArgs]);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  writeFileSync(join(dirs.dataDir, 'patterns.json'), PATTERNS);
  const md = join(dirs.dataDir, 'worklogs', `${DATE}.md`);
  const json = join(dirs.dataDir, 'worklogs', `${DATE}.json`);
  const oldMd = readFileSync(md, 'utf8');
  r = run(['redact', '--yes']);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  writeFileSync(md, oldMd);
  // 이전 판은 손으로 고친 일지를 알아보는 해시를 남기지 않았어요(그래서 다시 만들 수 있어요, PRD A21).
  asOldVersionWorklog(json);
  assert.match(readFileSync(md, 'utf8'), /CORP-[0-9]{8}/);
  assert.ok(!readFileSync(json, 'utf8').includes('CORP-'), '화면용 데이터만 가려져 있어요');
  return { md, json };
}

/** S3(다시 가리기)·S4(검사)가 같은 명령 한 줄과 안내 한 줄을 보여 주는지 보고, 그 명령을 돌려줘요. */
function assertRemakeShown(run: (args: string[]) => CliResult, expected: string): string {
  // S3: 고칠 수 없는 의심 [알림] 덩어리 안 — 그중 줄(7칸) → 명령(9칸) → 안내 한 줄(7칸)
  const r = run(['redact', '--yes']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(commandLines(r.stdout, 9), [expected], r.stdout);
  assert.match(r.stdout, new RegExp(`^ {9}${esc(expected)}\\n {7}${esc(REMAKE_HINT)}$`, 'm'), '명령 바로 아래 이름표 뒤 위치에 --root·--claude-dir 한 줄이 있어요');
  assert.ok(
    rowText(r.stdout, '[알림] 다시 가리기로 고칠 수 없는 의심').endsWith(`고쳐져요. ${expected} ${REMAKE_HINT}`),
    '같은 [알림] 덩어리 안이에요',
  );
  // S4: 다시 가리기 다음: 뒤 한쪽만 가려진 일지 다음: — 명령(8칸) → 안내 한 줄(6칸)
  const c = run(['check']);
  assert.equal(c.code, 1, c.stdout);
  assert.deepEqual(commandLines(c.stdout, 8), [expected], c.stdout);
  assert.match(c.stdout, new RegExp(`^ {8}${esc(expected)}\\n {6}${esc(REMAKE_HINT)}$`, 'm'));
  assert.ok(rowText(c.stdout, '다음: 아래 날짜의').endsWith(`다시 검사하세요. ${expected} ${REMAKE_HINT}`));
  assert.equal(rowText(c.stdout, '다음: 필요하면'), REDACT_NEXT, '다시 가리기 다음: 줄도 그대로 있어요');
  return expected;
}

// ---- 다시 만드는 명령 규칙 (단위) ----

test('8회차: 다시 만드는 명령 — --hide-identity, --day-start N(기본이나 지금 설정과 다를 때만), 이번 실행의 --data-dir·--claude-dir, 폴더 경로는 늘 큰따옴표(취합 15회차)', () => {
  const day = (hideIdentity: boolean, dayStartHour: number) => ({ date: DATE, hideIdentity, dayStartHour });
  // 기본(3)으로 만든 일지 + 지금 설정도 3 → 날짜만
  assert.equal(remakeCommand(day(false, 3), { dayStartHour: 3 }), `cc-worklog --date ${DATE}`);
  // 이름·이메일 가리기를 켜고 만든 일지
  assert.equal(remakeCommand(day(true, 3), { dayStartHour: 3 }), `cc-worklog --date ${DATE} --hide-identity`);
  // 그 일지의 하루 경계가 기본과 다름 (지금 설정과는 같아도 붙여요)
  assert.equal(remakeCommand(day(false, 5), { dayStartHour: 5 }), `cc-worklog --date ${DATE} --day-start 5`);
  assert.equal(remakeCommand(day(false, 5), { dayStartHour: 3 }), `cc-worklog --date ${DATE} --day-start 5`);
  // 기본(3)으로 만들었지만 지금 설정(config.json·--day-start)이 다름
  assert.equal(remakeCommand(day(false, 3), { dayStartHour: 6 }), `cc-worklog --date ${DATE} --day-start 3`);
  assert.equal(remakeCommand(day(false, 0), { dayStartHour: 0 }), `cc-worklog --date ${DATE} --day-start 0`);
  // 이번 실행에 준 폴더: 순서는 --hide-identity → --day-start → --data-dir → --claude-dir, 폴더 경로는 공백이 없어도 늘 큰따옴표
  // (DESIGN S3·S4 공통 터미널 규칙: 따옴표 없는 Windows 경로는 Git Bash에 붙여 넣으면 \가 지워져요, 취합 15회차)
  assert.equal(
    remakeCommand(day(true, 5), { dayStartHour: 3, dataDir: 'C:\\My Data\\wl', claudeDir: '/home/dev/.claude' }),
    `cc-worklog --date ${DATE} --hide-identity --day-start 5 --data-dir "C:\\My Data\\wl" --claude-dir "/home/dev/.claude"`,
  );
  assert.equal(shellPath('/tmp/a b'), '"/tmp/a b"');
  assert.equal(shellPath('C:\\Program Files (x86)\\x'), '"C:\\Program Files (x86)\\x"');
  assert.equal(shellPath('C:\\work\\데이터'), '"C:\\work\\데이터"', '공백이 없는 경로(한글 폴더 이름 포함)도 큰따옴표로 감싸요');
  assert.match(REMAKE_HINT, /^만들 때 --root나 --claude-dir를 줬으면 같은 값을 붙이세요\.$/);
});

// ---- 10회차: 명령 속 폴더의 두 예외 (취합 17회차 차이 3, DESIGN 공통 터미널 규칙의 예외 표) ----
// 아래 세 함수는 셸을 띄우지 않고, 사용자가 명령 줄을 붙여 넣었을 때 도구(node)가 받는 인자를 규칙대로 되돌려요.
// 이 명령에 나오는 글자(큰따옴표, \, /, 공백)에 필요한 규칙만 담았어요($·`는 DESIGN대로 다루지 않아요).

/**
 * Windows 프로그램 인자 규칙: node.exe가 명령 줄을 인자로 나누는 규칙이에요. 명령 프롬프트는 따옴표와 \를 바꾸지 않고 이 규칙에 넘겨요.
 * 따옴표 앞 \ 2n개는 \ n개 + 따옴표 열기·닫기, 2n+1개는 \ n개 + 따옴표 글자예요. 따옴표 앞이 아닌 \는 그대로예요.
 */
function windowsArgs(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  let has = false;
  for (let i = 0; i < line.length; ) {
    const c = line[i]!;
    if (c === '\\') {
      let n = 0;
      while (line[i] === '\\') {
        n++;
        i++;
      }
      if (line[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2 === 1) {
          cur += '"';
          i++;
        }
      } else {
        cur += '\\'.repeat(n);
      }
      has = true;
      continue;
    }
    i++;
    if (c === '"') {
      inQuote = !inQuote;
      has = true;
    } else if ((c === ' ' || c === '\t') && !inQuote) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** bash(Git Bash, macOS·Linux)의 규칙: 큰따옴표 안의 \는 $ ` " \ 줄바꿈 앞에서만 빠지고 그 밖에는 그대로, 따옴표 밖의 \는 다음 글자를 그대로 둬요. */
function bashArgs(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuote) {
      if (c === '"') inQuote = false;
      else if (c === '\\' && i + 1 < line.length && '$`"\\\n'.includes(line[i + 1]!)) cur += line[++i];
      else cur += c;
    } else if (c === '"') {
      inQuote = true;
      has = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (c === ' ' || c === '\t') {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  assert.equal(inQuote, false, `bash에서 따옴표가 닫혀야 해요: ${line}`);
  if (has) out.push(cur);
  return out;
}

/**
 * Windows PowerShell 5.1: 큰따옴표 안의 \를 바꾸지 않고 따옴표만 벗겨요. 프로그램에 넘길 때 공백이 든 인자만 다시 큰따옴표로
 * 감싸고(안의 \·끝 \는 고치지 않아요) 그 뒤는 Windows 프로그램 인자 규칙이에요(취합 17회차 셸 확인과 같은 결과).
 */
function powershellArgs(line: string): string[] {
  const words = [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
  return windowsArgs(words.map((w) => (/\s/.test(w) ? `"${w}"` : w)).join(' '));
}

/** (Windows) 셸 없이 node.exe에 명령 줄 뒤쪽을 글자 그대로 넘겨, node가 실제로 나눈 인자를 받아요. */
function realNodeArgs(tail: string): string[] {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', tail], {
    windowsVerbatimArguments: true,
    argv0: 'node',
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as string[];
}

test('10회차: 명령 속 폴더의 두 예외 — \\로 끝나면 끝 \\를 하나 더("D:\\\\"), \\\\로 시작하는 UNC 경로는 맨 앞을 \\/로, 둘 다면 둘 다, 보통 경로는 그대로 큰따옴표 → bash·Windows 프로그램 인자 규칙(node.exe)·PowerShell 5.1로 되돌려 resolve하면 원래 폴더 (취합 17회차 차이 3)', () => {
  // 실제 폴더 → 명령 속 글자 (DESIGN 공통 터미널 규칙의 예외 표와 예)
  const windowsCases: Array<[string, string]> = [
    ['D:\\', '"D:\\\\"'],
    ['\\\\nas\\share\\cc-worklog', '"\\/nas\\share\\cc-worklog"'],
    ['\\\\nas\\share\\', '"\\/nas\\share\\\\"'],
    ['\\\\nas\\my share\\', '"\\/nas\\my share\\\\"'],
    ['\\\\nas\\my share\\cc-worklog', '"\\/nas\\my share\\cc-worklog"'],
    ['C:\\work\\wl', '"C:\\work\\wl"'],
    ['D:\\work logs\\cc-worklog', '"D:\\work logs\\cc-worklog"'],
  ];
  const posixCases: Array<[string, string]> = [
    ['/home/dev/.claude', '"/home/dev/.claude"'],
    ['/tmp/a b', '"/tmp/a b"'],
    ['/', '"/"'],
  ];
  for (const [path, quoted] of [...windowsCases, ...posixCases]) assert.equal(shellPath(path), quoted, path);
  // 바꾸는 것은 명령 속 폴더뿐이고 순서·다른 옵션은 그대로예요. --data-dir·--claude-dir 모두 같은 규칙이에요.
  assert.equal(
    remakeCommand({ date: '2026-10-19', hideIdentity: true, dayStartHour: 3 }, { dayStartHour: 3, dataDir: '\\\\nas\\share\\', claudeDir: 'D:\\' }),
    'cc-worklog --date 2026-10-19 --hide-identity --data-dir "\\/nas\\share\\\\" --claude-dir "D:\\\\"',
  );

  /** 두 폴더 옵션에 같은 폴더를 준 명령에서 cc-worklog 뒤쪽 (인자 수로 따옴표가 섞여 뒤 인자가 붙지 않았는지도 봐요) */
  const tailFor = (dir: string) => {
    const cmd = remakeCommand({ date: '2026-10-19', hideIdentity: true, dayStartHour: 3 }, { dayStartHour: 3, dataDir: dir, claudeDir: dir });
    assert.ok(cmd.startsWith('cc-worklog '));
    return cmd.slice('cc-worklog '.length);
  };
  const expectRead = (args: string[], resolve: (p: string) => string, dir: string, how: string) => {
    assert.equal(args.length, 7, `${how}: 인자 7개여야 해요 ${JSON.stringify(args)}`);
    assert.deepEqual([args[0], args[1], args[2], args[3], args[5]], ['--date', '2026-10-19', '--hide-identity', '--data-dir', '--claude-dir'], how);
    assert.equal(resolve(args[4]!), dir, `${how}: --data-dir ${JSON.stringify(args[4])}`);
    assert.equal(resolve(args[6]!), dir, `${how}: --claude-dir ${JSON.stringify(args[6])}`);
  };
  for (const [dir] of windowsCases) {
    const tail = tailFor(dir);
    // 도구는 받은 폴더를 resolve로 정리해요(config.ts). Windows 경로라 win32 규칙으로 봐요(UNC에 접속하지 않는 글자 계산이에요).
    expectRead(bashArgs(tail), win32.resolve, dir, `Git Bash: ${tail}`);
    expectRead(windowsArgs(tail), win32.resolve, dir, `명령 프롬프트·node.exe: ${tail}`);
    expectRead(powershellArgs(tail), win32.resolve, dir, `PowerShell 5.1: ${tail}`);
    if (process.platform === 'win32') {
      // 흉내 낸 규칙이 실제 node.exe가 나누는 인자와 같은지 봐요(셸 없이 명령 줄을 글자 그대로 넘겨요).
      const real = realNodeArgs(tail);
      assert.deepEqual(real, windowsArgs(tail), `node.exe가 실제로 받은 인자: ${tail}`);
      expectRead(real, win32.resolve, dir, `node.exe 실제: ${tail}`);
    }
  }
  for (const [dir] of posixCases) expectRead(bashArgs(tailFor(dir)), posix.resolve, dir, `bash·zsh: ${dir}`);

  // 예외 없이 그대로 감쌌다면 깨지는 것도 같은 규칙으로 보여요(DESIGN이 예외를 둔 까닭, 취합 17회차 셸 확인 표의 "예전 모양").
  const oldDrive = '--data-dir "D:\\" --claude-dir "D:\\"';
  assert.equal(bashArgs(oldDrive).length, 2, 'Git Bash: 끝 \\"가 따옴표 글자가 되어 뒤 옵션까지 한 덩어리예요');
  assert.equal(windowsArgs(oldDrive).length, 2, '명령 프롬프트·node.exe도 한 덩어리예요');
  if (process.platform === 'win32') assert.deepEqual(realNodeArgs(oldDrive), windowsArgs(oldDrive));
  const oldUnc = bashArgs('--data-dir "\\\\nas\\share\\cc-worklog"')[1]!;
  assert.equal(oldUnc, '\\nas\\share\\cc-worklog', 'Git Bash가 큰따옴표 안 \\\\를 하나로 줄여요');
  assert.notEqual(win32.resolve(oldUnc), '\\\\nas\\share\\cc-worklog', '지금 드라이브의 폴더가 돼요');
});

test('8회차: 이번 실행에 --data-dir·--claude-dir를 줬을 때만 명령에 붙여요 (환경 변수·기본 폴더면 붙이지 않음, 지금 하루 경계는 --day-start 다음 config.json)', () => {
  const s = sandbox();
  const saved = { home: process.env.CC_WORKLOG_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
  try {
    // 이 시험 프로세스의 실제 폴더를 읽지 않게, 기본 폴더도 환경 변수로 샌드박스를 가리켜요.
    process.env.CC_WORKLOG_HOME = s.dataDir;
    process.env.CLAUDE_CONFIG_DIR = s.claudeDir;
    const none = remakeContext(resolveConfig({}));
    assert.equal(none.dataDir, undefined);
    assert.equal(none.claudeDir, undefined);
    assert.equal(none.dayStartHour, 3);
    const given = remakeContext(resolveConfig({ dataDir: s.dataDir, claudeDir: s.claudeDir, dayStart: 6 }));
    assert.equal(given.dataDir, s.dataDir);
    assert.equal(given.claudeDir, s.claudeDir);
    assert.equal(given.dayStartHour, 6, '이번 실행의 --day-start가 지금 설정이에요');
    // config.json의 dayStartHour도 지금 설정이에요.
    const cfgDir = join(s.root, 'cfg');
    mkdirSync(cfgDir);
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ dayStartHour: 7 }));
    const fromFile = remakeContext(resolveConfig({ dataDir: cfgDir, claudeDir: s.claudeDir }));
    assert.equal(fromFile.dayStartHour, 7);
  } finally {
    if (saved.home === undefined) delete process.env.CC_WORKLOG_HOME;
    else process.env.CC_WORKLOG_HOME = saved.home;
    if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved.claude;
    s.cleanup();
  }
});

// ---- 다시 만드는 명령 (실제 실행) ----

test('8회차: 이름·이메일 가리기를 켜고 만든 일지 → 명령에 --hide-identity (폴더 옵션 없는 실행이면 폴더도 없음) → 그대로 실행하면 같은 설정으로 다시 만들어지고 검사 통과', () => {
  const s = sandbox();
  try {
    const run = (args: string[]) => runRaw(s, args);
    const x = makeMismatched(s, { claudeDir: s.claudeDir, dataDir: s.dataDir }, run, ['--hide-identity']);
    assert.equal(readJson<DayLog>(x.json).hideIdentity, true);

    const cmd = assertRemakeShown(run, `cc-worklog --date ${DATE} --hide-identity`);

    // 안내대로 실행해요(옵션은 명령에 있는 것만).
    const r = runRaw(s, argsOf(cmd));
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const day = readJson<DayLog>(x.json);
    assert.equal(day.hideIdentity, true, '공개용 일지가 이름·이메일 가리기가 꺼진 일지로 바뀌지 않아요');
    assert.equal(day.dayStartHour, 3);
    assert.ok(!readFileSync(x.md, 'utf8').includes('CORP-') && !readFileSync(x.json, 'utf8').includes('CORP-'), '두 파일이 같게 가려져요');
    const ok = runRaw(s, ['check']);
    assert.equal(ok.code, 0, ok.stdout);
    assert.match(ok.stdout, /이름·이메일 \(일지만\) +켠 일지 \d+개 — 사용자 이름 0건 · 이메일 0건/);
    assert.ok(!runRaw(s, ['redact', '--yes']).stdout.includes('한쪽만 가려진'), '고친 뒤에는 안내가 없어요');
  } finally {
    s.cleanup();
  }
});

test('8회차: 하루 경계가 기본과 다른 일지 → --day-start N, 이번 실행에 준 --data-dir·--claude-dir도 붙어요 → 그대로 실행하면 같은 하루 경계로 다시 만들어지고 검사 통과', () => {
  const s = sandbox();
  try {
    // runCli는 --claude-dir·--data-dir를 늘 붙여요(= 이번 실행에 준 폴더).
    const run = (args: string[]) => runCli(s, args);
    const x = makeMismatched(s, { claudeDir: s.claudeDir, dataDir: s.dataDir }, run, ['--day-start', '5']);
    assert.equal(readJson<DayLog>(x.json).dayStartHour, 5);

    const cmd = assertRemakeShown(run, `cc-worklog --date ${DATE} --day-start 5 --data-dir ${shellPath(s.dataDir)} --claude-dir ${shellPath(s.claudeDir)}`);

    // 명령만으로 실행해요(runCli처럼 폴더를 덧붙이지 않아요).
    const r = runRaw(s, argsOf(cmd));
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const day = readJson<DayLog>(x.json);
    assert.equal(day.dayStartHour, 5, '같은 하루 경계(범위)로 다시 만들어져요');
    assert.equal(day.hideIdentity, false);
    assert.equal(runCli(s, ['check']).code, 0);
  } finally {
    s.cleanup();
  }
});

test('8회차: 기본(3)으로 만든 일지인데 지금 설정(config.json의 dayStartHour·이번 실행의 --day-start)이 다르면 --day-start 3을 붙여요, 같으면 붙이지 않아요', () => {
  const s = sandbox();
  try {
    const run = (args: string[]) => runRaw(s, args);
    const x = makeMismatched(s, { claudeDir: s.claudeDir, dataDir: s.dataDir }, run, []);
    const fromCheck = (args: string[]) => commandLines(runRaw(s, ['check', ...args]).stdout, 8);

    assert.deepEqual(fromCheck([]), [`cc-worklog --date ${DATE}`], '기본 = 지금 설정 = 그 일지면 붙이지 않아요');
    assert.deepEqual(fromCheck(['--day-start', '6']), [`cc-worklog --date ${DATE} --day-start 3`], '이번 실행의 --day-start');
    writeFileSync(join(s.dataDir, 'config.json'), JSON.stringify({ dayStartHour: 6 }));
    assert.deepEqual(fromCheck([]), [`cc-worklog --date ${DATE} --day-start 3`], 'config.json의 dayStartHour');
    const r0 = runRaw(s, ['redact', '--yes']);
    assert.deepEqual(commandLines(r0.stdout, 9), [`cc-worklog --date ${DATE} --day-start 3`], '다시 가리기(S3)도 같아요');

    // 지금 설정이 6이어도 안내대로 실행하면 그 일지의 하루 경계(3)로 다시 만들어져요.
    const r = runRaw(s, argsOf(`cc-worklog --date ${DATE} --day-start 3`));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readJson<DayLog>(x.json).dayStartHour, 3);
    assert.equal(runRaw(s, ['check']).code, 0);
  } finally {
    s.cleanup();
  }
});

test('8회차: 공백이 든 --data-dir·--claude-dir를 준 실행이면 따옴표로 감싼 절대 경로를 붙이고, 그대로 실행하면 그 폴더에 다시 만들어 검사가 통과해요', () => {
  const s = sandbox();
  try {
    const dataDir = join(s.root, 'my data');
    const claudeDir = join(s.root, 'claude home');
    cpSync(s.claudeDir, claudeDir, { recursive: true });
    const opts = ['--data-dir', dataDir, '--claude-dir', claudeDir];
    const run = (args: string[]) => runRaw(s, [...args, ...opts]);
    const x = makeMismatched(s, { claudeDir, dataDir }, run, ['--hide-identity', '--day-start', '4']);

    const expected = `cc-worklog --date ${DATE} --hide-identity --day-start 4 --data-dir "${dataDir}" --claude-dir "${claudeDir}"`;
    assertRemakeShown(run, expected);
    // 상대 경로로 줘도 명령에는 절대 경로가 붙어요(다른 폴더에서 실행해도 같은 폴더를 가리켜요).
    const relCheck = runRaw(s, ['check', '--data-dir', 'my data', '--claude-dir', 'claude home'], s.root);
    assert.deepEqual(commandLines(relCheck.stdout, 8), [expected], relCheck.stdout);

    const r = runRaw(s, argsOf(expected));
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const day = readJson<DayLog>(x.json);
    assert.equal(day.hideIdentity, true);
    assert.equal(day.dayStartHour, 4);
    assert.equal(day.totals.sessions, 1, '준 세션 기록 폴더의 세션이 들어 있어요');
    assert.equal(day.totals.commits, 1);
    assert.equal(run(['check']).code, 0);
    assert.ok(!existsSync(s.dataDir), '기본 데이터 폴더에는 아무것도 만들지 않아요');
  } finally {
    s.cleanup();
  }
});

// ---- 검사가 읽지 못한 파일 (S4) ----

/** 가짜 세션·커밋으로 깨끗한(남은 의심 없는) 일지·보관본을 만들어요. */
function seedClean(): { s: Sandbox; md: string; archive: string; index: string } {
  const s = sandbox();
  const repo = join(s.root, 'work', 'web');
  initRepo(s, repo, ME);
  commitAt(s, repo, 'style: 헤더 정리', `${DATE}T11:00:00+09:00`);
  const A = { sid: SID, cwd: repo };
  writeSession(s, repo, SID, [userText({ ...A, ts: kst(DATE, '10:00') }, '헤더 손보기'), assistantText({ ...A, ts: kst(DATE, '10:05') }, '했어요')]);
  const r = runCli(s, ['--date', DATE]);
  assert.equal(r.code, 0, r.stderr);
  const archive = listFilesRec(join(s.dataDir, 'archive', 'projects')).find((p) => p.endsWith(`${SID}.jsonl`))!;
  assert.ok(archive);
  assert.equal(runCli(s, ['check']).code, 0, '시작할 때는 검사가 통과해요');
  return { s, md: join(s.dataDir, 'worklogs', `${DATE}.md`), archive, index: join(s.dataDir, 'archive', 'index.json') };
}

const UNREADABLE_NEXT_RE = /^다음: 읽지 못한 파일을 연 프로그램\(편집기·화면·백신 등\)을 닫거나 파일 권한을 확인한 뒤 다시 검사하세요\.$/;

for (const which of ['md', 'archive', 'index'] as const) {
  const name = { md: '일지 마크다운은', archive: '보관본은', index: '보관 색인은' }[which];
  test(`8회차: 검사가 읽지 못한 ${name} "읽지 못함"과 원인 코드로 보여 주고("모양" 없음), 다음: 줄은 프로그램을 닫고 다시 검사하라는 안내뿐이에요 (실패·종료 코드 1 그대로)`, { skip: lockSkip }, () => {
    const x = seedClean();
    try {
      const target = x[which];
      const rel = target.slice(x.s.dataDir.length + 1).split('\\').join('/');
      const release = lockFile(target);
      let c;
      try {
        c = runCli(x.s, ['check']);
      } finally {
        release();
      }
      assert.equal(c.code, 1, c.stdout);
      assert.match(c.stdout, /^\[실패\] 남은 의심 1건, 놓친 패턴 0개$/m, '읽지 못한 파일은 남은 의심으로 세서 실패예요');
      // "줄 …" 칸 자리에 읽지 못함, 괄호에 원인 코드만 (DESIGN S4 5번, 취합 15회차)
      assert.match(c.stdout, new RegExp(`^ {5}${esc(rel)} +읽지 못함 \\((EBUSY|EPERM|EACCES)\\)$`, 'm'), c.stdout);
      assert.ok(!/모양/.test(c.stdout.split('\n').find((l) => l.includes(rel) && l.includes('읽지 못함')) ?? ''), '"…모양" 글자가 없어요');
      const next = c.stdout.split('\n').filter((l) => l.startsWith('다음:'));
      assert.equal(next.length, 1, c.stdout);
      assert.match(rowText(c.stdout, '다음:'), UNREADABLE_NEXT_RE);
      assert.ok(!c.stdout.includes('cc-worklog redact를 실행하고'), '읽지 못한 파일만 있으면 다시 가리기 다음: 줄은 없어요');
      // 잠금을 풀면 그대로 통과해요(검사는 읽기만 했어요).
      assert.equal(runCli(x.s, ['check']).code, 0);
    } finally {
      x.s.cleanup();
    }
  });
}

test('8회차: 읽지 못한 파일과 일반 남은 의심이 함께 있으면 다음: 줄이 둘 — 프로그램을 닫고 다시 검사가 먼저, 그다음 다시 가리기', { skip: lockSkip }, () => {
  const x = seedClean();
  try {
    // 보관본·화면용 데이터에 사용자 패턴에 걸리는 값을 넣고 패턴을 더해요(일반 남은 의심).
    const json = join(x.s.dataDir, 'worklogs', `${DATE}.json`);
    writeFileSync(json, readFileSync(json, 'utf8').replace('헤더 손보기', `헤더 손보기 ${T1}`));
    writeFileSync(join(x.s.dataDir, 'patterns.json'), PATTERNS);
    const release = lockFile(x.md);
    let c;
    try {
      c = runCli(x.s, ['check']);
    } finally {
      release();
    }
    assert.equal(c.code, 1, c.stdout);
    assert.match(c.stdout, new RegExp(`worklogs/${DATE}\\.md +읽지 못함 \\((EBUSY|EPERM|EACCES)\\)$`, 'm'));
    assert.match(c.stdout, new RegExp(`worklogs/${DATE}\\.json +줄 번호 없음 \\(${esc(LABEL)} 모양\\)$`, 'm'), '일반 의심은 전처럼 "모양"이에요');
    const next = c.stdout.split('\n').filter((l) => l.startsWith('다음:'));
    assert.equal(next.length, 2, c.stdout);
    assert.match(next[0]!, /^다음: 읽지 못한 파일을 연 프로그램/);
    assert.match(next[1]!, /^다음: 필요하면 사용자 패턴을 더한 뒤 cc-worklog redact를 실행하고/);
    assert.equal(rowText(c.stdout, '다음: 필요하면'), REDACT_NEXT);
  } finally {
    x.s.cleanup();
  }
});

test('8회차: 내용이 깨진 화면용 일지 데이터(파일은 읽힘)는 전처럼 "읽을 수 없는 일지 파일 모양"이고 다시 가리기 다음: 줄이에요', () => {
  const x = seedClean();
  try {
    writeFileSync(join(x.s.dataDir, 'worklogs', `${DATE}.json`), '{ "schema": 1, ');
    const c = runCli(x.s, ['check']);
    assert.equal(c.code, 1);
    assert.match(c.stdout, new RegExp(`worklogs/${DATE}\\.json +줄 번호 없음 \\(읽을 수 없는 일지 파일 모양\\)$`, 'm'));
    assert.ok(!c.stdout.includes('읽지 못함'));
    assert.ok(!c.stdout.includes('읽지 못한 파일을 연 프로그램'));
    assert.equal(rowText(c.stdout, '다음: 필요하면'), REDACT_NEXT);
  } finally {
    x.s.cleanup();
  }
});
