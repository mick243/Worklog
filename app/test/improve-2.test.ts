// 개선 개발 2회차 시험 (정리 회차, docs/IMPROVEMENT.md I-29·I-32, PRD 확정 2026-10-22의 A23).
//  - I-29 (A23): 검사의 남은 사용자 이름·이메일 "건"은 켠 일지·끈 일지 모두 일지 마크다운에서 찾은 자리예요. 화면용 일지 데이터는
//    마크다운과 같은 내용이라 더하지 않고, 같은 날짜 마크다운에 없는 종류가 화면용 데이터에만 남았으면 그 .json을 그 종류 1건으로 세요
//    (켠 일지는 그때만 .json 위치를 보여 줘요). 판정·[알림] 여부·다시 만드는 명령의 날짜·남은 의심(비밀 값) 수는 그대로예요.
//  - I-32: --help의 모든 줄이 80칸(표시 폭) 안이에요.
// 모든 시험은 임시 폴더의 가짜 세션 기록·임시 저장소로만 해요.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectIdentity, EMAIL_LABEL, USER_NAME_LABEL } from '../src/redact/identity.js';
import { displayWidth } from '../src/term/format.js';
import { IDENTITY_TEXT } from '../src/term/s4-check.js';
import { mdUnescape } from '../src/util/text.js';
import { assistantText, initRepo, kst, rowText, runCli, sandbox, userText, writeSession, type Sandbox } from './helpers.js';

const ME = 'dev.kim@example.test';
const DATE = '2026-10-15';
/** 요청 글에 넣을 가짜 이메일 */
const EMAIL = 'qa.lee@example.test';
/** 요청 글에 넣을 경로 속 가짜 사용자 이름 */
const WIN_USER = 'kimdev';
const lines = (s: string) => s.replace(/\n$/, '').split('\n');

let sidN = 0;
const nextSid = () => `2b000000-0000-4000-8000-${String(++sidN).padStart(12, '0')}`;

const files = (sb: Sandbox, date = DATE) => ({ md: join(sb.dataDir, 'worklogs', `${date}.md`), json: join(sb.dataDir, 'worklogs', `${date}.json`) });

/** 일지 마크다운에서 찾은 사용자 이름·이메일 자리 (검사와 같은 규칙: 줄마다 마크다운 글자를 되돌린 뒤 찾아요) */
function mdPlaces(md: string): { names: number; emails: number; nameLines: number[]; emailLines: number[] } {
  const out = { names: 0, emails: 0, nameLines: [] as number[], emailLines: [] as number[] };
  md.split('\n').forEach((line, i) => {
    const c = detectIdentity(mdUnescape(line.replace(/\r$/, '')));
    if (c[USER_NAME_LABEL]) {
      out.names += c[USER_NAME_LABEL];
      out.nameLines.push(i + 1);
    }
    if (c[EMAIL_LABEL]) {
      out.emails += c[EMAIL_LABEL];
      out.emailLines.push(i + 1);
    }
  });
  return out;
}

/** 화면용 일지 데이터의 글 칸마다 찾은 사용자 이름·이메일 수 (예전 검사가 마크다운 수에 더하던 수) */
function jsonPlaces(json: string): { names: number; emails: number } {
  const out = { names: 0, emails: 0 };
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      const c = detectIdentity(v);
      out.names += c[USER_NAME_LABEL] ?? 0;
      out.emails += c[EMAIL_LABEL] ?? 0;
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(JSON.parse(json));
  return out;
}

/** 요청 글(들)로 DATE 세션 하나를 써요. 요청마다 10분 간격, 답변은 그 5분 뒤예요. */
function session(sb: Sandbox, cwd: string, start: string, requests: string[]) {
  const sid = nextSid();
  const A = { sid, cwd };
  const [h, m] = start.split(':').map(Number) as [number, number];
  const at = (add: number) => {
    const t = h * 60 + m + add;
    return kst(DATE, `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  };
  writeSession(
    sb,
    cwd,
    sid,
    requests.flatMap((text, i) => [userText({ ...A, ts: at(i * 10) }, text), assistantText({ ...A, ts: at(i * 10 + 5) }, '했어요')]),
  );
}

/** S4의 `이름·이메일 (일지만)` 칸에서 켠·끈 일지 줄의 수를 꺼내요. */
function identityRow(out: string, which: '켠' | '끈'): { worklogs: number; names: number; emails: number } | null {
  const m = new RegExp(`^ +(?:이름·이메일 \\(일지만\\) +)?${which} 일지 (\\d+)개 — 사용자 이름 (\\d+)건 · 이메일 (\\d+)건$`, 'm').exec(out);
  return m ? { worklogs: Number(m[1]), names: Number(m[2]), emails: Number(m[3]) } : null;
}

/** `이름·이메일 (일지만)` 칸 괄호 줄 아래의 위치 목록 줄 (켠 일지만 있어요) */
function identityRows(out: string): string[] {
  const L = lines(out);
  const i = L.findIndex((l) => l.trim() === IDENTITY_TEXT.rowNote);
  const rows: string[] = [];
  for (let j = i + 1; j < L.length && /^ {5}\S/.test(L[j]!); j++) rows.push(L[j]!);
  return rows;
}

// ---- I-29 남은 이름·이메일을 세는 단위 (A23) ----

test('I-29: 이메일 하나가 든 요청 하나로 만든 일지는 끈 일지로 검사해도 --hide-identity로 검사해도 `이메일 1건`이고(마크다운 자리), 종료 코드·[알림]·남은 의심 수는 그대로예요', () => {
  const sb = sandbox();
  try {
    const web = join(sb.root, 'work', 'web');
    initRepo(sb, web, ME);
    session(sb, web, '10:00', [`${EMAIL} 에게 CORP-12345678 리뷰 요청`]);
    const made = runCli(sb, ['--date', DATE]);
    assert.equal(made.code, 0, made.stderr);
    const f = files(sb);
    const md = readFileSync(f.md, 'utf8');
    const want = mdPlaces(md);
    assert.equal(want.emails, 1, '마크다운에는 이메일이 한 자리예요');
    assert.ok(jsonPlaces(readFileSync(f.json, 'utf8')).emails >= 2, '화면용 데이터에는 첫 요청·마지막 요청 칸에 두 번 있어요(예전엔 이 수를 더했어요)');

    // 끈 일지: 수만, 판정·종료 코드 그대로(통과 0), 판정 아래 [알림]도 같은 수예요.
    const off = runCli(sb, ['check']);
    assert.equal(off.code, 0, off.stdout);
    assert.deepEqual(identityRow(off.stdout, '끈'), { worklogs: 1, names: want.names, emails: 1 }, off.stdout);
    assert.match(off.stdout, /^\[통과\] 남은 의심 0건, 놓친 패턴 0개$/m);
    assert.ok(rowText(off.stdout, '[알림]').startsWith(`[알림] ${IDENTITY_TEXT.offNotice(1, want.names, 1)} cc-worklog --date <날짜> --hide-identity `));
    assert.deepEqual(identityRows(off.stdout), [], '끈 일지는 위치를 늘어놓지 않아요');

    // 같은 데이터를 --hide-identity로: 같은 수가 켠 일지 줄과 판정(실패)에 들어가고, 위치 목록은 마크다운 줄만이에요.
    const on = runCli(sb, ['check', '--hide-identity']);
    assert.equal(on.code, 1, on.stdout);
    assert.deepEqual(identityRow(on.stdout, '켠'), { worklogs: 1, names: want.names, emails: 1 }, on.stdout);
    assert.match(on.stdout, new RegExp(`^\\[실패\\] 남은 의심 0건, 놓친 패턴 0개, 남은 이름·이메일 ${want.names + 1}건$`, 'm'));
    const rows = identityRows(on.stdout);
    assert.equal(rows.length, 1, on.stdout);
    assert.match(rows[0]!, new RegExp(`^ {5}worklogs/${DATE}\\.md  줄 ${[...new Set([...want.nameLines, ...want.emailLines])].sort((a, b) => a - b).join(', ')} \\(`));
    assert.ok(!on.stdout.includes(`${DATE}.json`), '마크다운에 같은 종류가 있으면 .json 위치는 나오지 않아요');
    assert.ok(!on.stdout.includes(EMAIL) && !on.stdout.includes('[알림] 이름·이메일 가리기를 끈 일지'));

    // 남은 의심(비밀 값) 수는 그대로 파일마다 찾은 자리를 더해요(마크다운 1 + 화면용 데이터 2 + 보관본).
    writeFileSync(join(sb.dataDir, 'patterns.json'), JSON.stringify([{ name: '사내 토큰', pattern: 'CORP-[0-9]{8}' }]));
    const occurrences = (file: string) => readFileSync(file, 'utf8').split('CORP-12345678').length - 1;
    const archives = readdirSync(join(sb.dataDir, 'archive', 'projects'), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => join(e.parentPath, e.name));
    const suspects = occurrences(f.md) + occurrences(f.json) + archives.reduce((a, p) => a + occurrences(p), 0);
    assert.ok(occurrences(f.json) >= 2 && archives.length > 0);
    const sec = runCli(sb, ['check']);
    assert.equal(sec.code, 1, sec.stdout);
    assert.match(sec.stdout, new RegExp(`^ {3}남은 의심 +${suspects}건$`, 'm'), sec.stdout);
    assert.deepEqual(identityRow(sec.stdout, '끈'), { worklogs: 1, names: want.names, emails: 1 }, '이름·이메일 수는 그대로예요');
  } finally {
    sb.cleanup();
  }
});

test('I-29: 세션이 여러 개인 프로젝트에서 남은 사용자 이름 수는 마크다운 자리 수예요(화면용 데이터의 첫·마지막 요청·작업 폴더 칸을 더하지 않아요)', () => {
  const sb = sandbox();
  try {
    const web = join(sb.root, 'work', 'web');
    initRepo(sb, web, ME);
    const path = (file: string) => `C:\\Users\\${WIN_USER}\\proj\\${file}`;
    session(sb, web, '10:00', [`${path('a.ts')} 고쳐 줘`]);
    session(sb, web, '11:00', [`${path('b.ts')} 고쳐 줘`]);
    session(sb, web, '13:00', [`${path('c.ts')} 먼저`, '그다음', `${path('d.ts')} 도`]);
    const made = runCli(sb, ['--date', DATE]);
    assert.equal(made.code, 0, made.stderr);
    const f = files(sb);
    const want = mdPlaces(readFileSync(f.md, 'utf8'));
    const json = jsonPlaces(readFileSync(f.json, 'utf8'));
    assert.ok(want.names >= 4, `마크다운에는 요청 줄마다 한 자리예요: ${want.names}`);
    assert.ok(json.names > want.names, '화면용 데이터에는 더 많아요(같은 요청이 첫·마지막 칸에, 작업 폴더가 세션마다)');

    const off = runCli(sb, ['check']);
    assert.equal(off.code, 0, off.stdout);
    assert.deepEqual(identityRow(off.stdout, '끈'), { worklogs: 1, names: want.names, emails: 0 }, off.stdout);
    assert.ok(rowText(off.stdout, '[알림]').startsWith(`[알림] ${IDENTITY_TEXT.offNotice(1, want.names, 0)} cc-worklog --date <날짜> --hide-identity `));

    const on = runCli(sb, ['check', '--hide-identity']);
    assert.equal(on.code, 1, on.stdout);
    assert.deepEqual(identityRow(on.stdout, '켠'), { worklogs: 1, names: want.names, emails: 0 }, on.stdout);
    assert.match(on.stdout, new RegExp(`^\\[실패\\] 남은 의심 0건, 놓친 패턴 0개, 남은 이름·이메일 ${want.names}건$`, 'm'));
    assert.deepEqual(identityRows(on.stdout), [`     worklogs/${DATE}.md  줄 ${want.nameLines.join(', ')} (사용자 이름 모양)`], '수에 든 자리만 목록에 있어요');
    assert.ok(!on.stdout.includes(WIN_USER));
  } finally {
    sb.cleanup();
  }
});

test('I-29: 마크다운에는 없고 화면용 데이터에만 남은 이름·이메일 — 켠 일지는 그 종류 1건·.json 줄 번호 없음 줄·실패(다시 만드는 명령), 끈 일지는 1건으로 [알림](통과 그대로)', () => {
  // 켠 일지: 이름·이메일 가리기를 켜고 만든 일지의 화면용 데이터만 이메일이 가려지지 않은 상태(마크다운만 가려진 일지)
  const sb = sandbox();
  try {
    const web = join(sb.root, 'work', 'web');
    initRepo(sb, web, ME);
    session(sb, web, '10:00', [`C:\\Users\\${WIN_USER}\\proj 의 ${EMAIL} 에게 리뷰 요청`]);
    assert.equal(runCli(sb, ['--date', DATE, '--hide-identity']).code, 0);
    const f = files(sb);
    const start = runCli(sb, ['check']);
    assert.equal(start.code, 0, '시작할 때는 통과해요');
    assert.deepEqual(identityRow(start.stdout, '켠'), { worklogs: 1, names: 0, emails: 0 }, '마크다운에도 화면용 데이터에도 없으면 0건이에요');
    const NAME_MARK = '[가림:사용자 이름]';
    const EMAIL_MARK = '[가림:이메일]';
    const leak = (file: string, mark: string, value: string) => {
      const text = readFileSync(file, 'utf8');
      assert.ok(text.includes(mark), `${file}에 ${mark}가 있어야 해요`);
      writeFileSync(file, text.split(mark).join(value));
    };

    // ① 화면용 데이터에만 이메일(첫·마지막 요청 칸 두 자리) → 이메일 1건, .json 줄은 이메일 모양만
    leak(f.json, EMAIL_MARK, EMAIL);
    assert.equal(mdPlaces(readFileSync(f.md, 'utf8')).emails, 0);
    const c = runCli(sb, ['check']);
    assert.equal(c.code, 1, c.stdout);
    assert.deepEqual(identityRow(c.stdout, '켠'), { worklogs: 1, names: 0, emails: 1 }, c.stdout);
    assert.deepEqual(identityRows(c.stdout), [`     worklogs/${DATE}.json  줄 번호 없음 (이메일 모양)`], '그 종류가 화면용 데이터에만 있을 때만 .json 위치가 나와요');
    assert.match(c.stdout, /^\[실패\] 남은 의심 0건, 놓친 패턴 0개, 남은 이름·이메일 1건$/m);
    assert.match(c.stdout, new RegExp(`^ {8}cc-worklog --date ${DATE} --hide-identity `, 'm'), '그 날짜를 다시 만드는 명령도 그대로예요');
    assert.ok(!c.stdout.includes(EMAIL) && !c.stdout.includes(WIN_USER));

    // ② 화면용 데이터에 두 종류, 마크다운에는 없음 → 종류마다 1건, .json 줄 하나에 두 종류
    leak(f.json, NAME_MARK, WIN_USER);
    const both = runCli(sb, ['check']);
    assert.equal(both.code, 1, both.stdout);
    assert.deepEqual(identityRow(both.stdout, '켠'), { worklogs: 1, names: 1, emails: 1 }, both.stdout);
    assert.deepEqual(identityRows(both.stdout), [`     worklogs/${DATE}.json  줄 번호 없음 (사용자 이름 모양, 이메일 모양)`]);
    assert.match(both.stdout, /^\[실패\] 남은 의심 0건, 놓친 패턴 0개, 남은 이름·이메일 2건$/m);

    // ③ 마크다운에도 이메일이 남음 → 이메일은 마크다운 자리로만, .json 줄 괄호에는 사용자 이름만(.json 줄이 .md보다 먼저)
    leak(f.md, EMAIL_MARK, EMAIL);
    const md = mdPlaces(readFileSync(f.md, 'utf8'));
    assert.deepEqual([md.names, md.emails], [0, 1]);
    const mixed = runCli(sb, ['check']);
    assert.equal(mixed.code, 1, mixed.stdout);
    assert.deepEqual(identityRow(mixed.stdout, '켠'), { worklogs: 1, names: 1, emails: 1 }, mixed.stdout);
    assert.deepEqual(identityRows(mixed.stdout), [
      `     worklogs/${DATE}.json  줄 번호 없음 (사용자 이름 모양)`,
      `     worklogs/${DATE}.md    줄 ${md.emailLines.join(', ')} (이메일 모양)`,
    ]);
    // 같은 날짜라 다시 만드는 명령은 한 줄이에요.
    assert.equal(lines(mixed.stdout).filter((l) => l.startsWith(`        cc-worklog --date ${DATE} `)).length, 1);

    // ④ 마크다운이 없는 날짜(화면용 데이터만 남음) → 남은 종류마다 1건, .json 줄 하나에 모두
    rmSync(f.md);
    const noMd = runCli(sb, ['check']);
    assert.equal(noMd.code, 1, noMd.stdout);
    assert.deepEqual(identityRow(noMd.stdout, '켠'), { worklogs: 1, names: 1, emails: 1 }, noMd.stdout);
    assert.deepEqual(identityRows(noMd.stdout), [`     worklogs/${DATE}.json  줄 번호 없음 (사용자 이름 모양, 이메일 모양)`]);
  } finally {
    sb.cleanup();
  }

  // 끈 일지: 마크다운에서 이메일을 손으로 지운 경우(화면용 데이터에는 남음)
  const sb2 = sandbox();
  try {
    const web = join(sb2.root, 'work', 'web');
    initRepo(sb2, web, ME);
    session(sb2, web, '10:00', [`${EMAIL} 에게 리뷰 요청`]);
    assert.equal(runCli(sb2, ['--date', DATE]).code, 0);
    const f = files(sb2);
    writeFileSync(f.md, readFileSync(f.md, 'utf8').split(EMAIL).join('담당자'));
    const want = mdPlaces(readFileSync(f.md, 'utf8'));
    assert.equal(want.emails, 0);
    assert.ok(jsonPlaces(readFileSync(f.json, 'utf8')).emails >= 2);

    const c = runCli(sb2, ['check']);
    assert.equal(c.code, 0, `판정·종료 코드는 그대로예요: ${c.stdout}`);
    assert.deepEqual(identityRow(c.stdout, '끈'), { worklogs: 1, names: want.names, emails: 1 }, c.stdout);
    assert.match(c.stdout, /^\[통과\] 남은 의심 0건, 놓친 패턴 0개$/m);
    assert.ok(rowText(c.stdout, '[알림]').startsWith(`[알림] ${IDENTITY_TEXT.offNotice(1, want.names, 1)} cc-worklog --date <날짜> --hide-identity `), '화면용 데이터에만 남아도 [알림]에서 빠지지 않아요');
    assert.deepEqual(identityRows(c.stdout), []);

    // 두 파일 모두에서 지우면 이메일은 0건이에요.
    writeFileSync(f.json, readFileSync(f.json, 'utf8').split(EMAIL).join('담당자'));
    const c2 = runCli(sb2, ['check']);
    assert.equal(c2.code, 0);
    assert.deepEqual(identityRow(c2.stdout, '끈'), { worklogs: 1, names: want.names, emails: 0 }, c2.stdout);
  } finally {
    sb2.cleanup();
  }
});

// ---- I-32 --help 80칸 ----

/** DESIGN 3장 "도움말 출력"에서 80칸을 넘던 11줄을 고친 모양 (글자 그대로, 이어지는 줄 포함) */
const HELP_CHANGED: string[][] = [
  ['cc-worklog — Claude Code 세션과 git log로 비밀 값을 가린 날짜별 일지를 만들어요'],
  ['  cc-worklog redact [--yes] [옵션]        보관본 다시 가리기 (일지도 함께)'],
  ['  --from <날짜>          기간 안에서 재료가 있는 날짜를 모두 만들어요', '                         (이미 있어도 다시 만들어요)'],
  ['                         손으로 고친 일지 .md는 어느 방식으로도 덮어쓰지 않아요'],
  ['  --root <폴더>          이 폴더 아래 저장소는 세션이 없던 날의 커밋도 넣어요', '                         (여러 번 쓸 수 있어요)'],
  ['  --hide-identity        일지에서 경로 속 사용자 이름과 이메일 주소도 가려요', '                         (보관본에는 쓰지 않아요)'],
  ['  --claude-dir <폴더>    Claude Code 폴더', '                         (기본: CLAUDE_CONFIG_DIR 또는 ~/.claude)'],
  ['  --data-dir <폴더>      cc-worklog 데이터 폴더', '                         (기본: CC_WORKLOG_HOME 또는 ~/.cc-worklog)'],
  ['  -y, --yes              redact 명령에서 확인을 묻지 않고 바로 다시 써요', '                         (되돌릴 수 없어요)'],
  // AI 요약 회차(DESIGN 2026-10-22): 설정 파일 예에 "summary": false를 더해 쉼표 뒤에서 끊었어요(첫 키 자리 9칸째).
  ['설정 파일   <데이터 폴더>/config.json', '  예) { "roots": ["C:/work"], "dayStartHour": 3, "hideIdentity": false,', '        "summary": false }'],
  ['  --summary              일지에 세션마다 AI가 쓴 작업 내용 한 줄을 더해요', '                         (가린 대화 글을 Claude Code로 Anthropic에 보내요)', '                         Claude Code 사용량을 써요 (실행마다 claude 50번까지)'],
  ['사용자 패턴 <데이터 폴더>/patterns.json', '  예) [{ "name": "사내 토큰", "pattern": "CORP-[0-9]{8}",', '         "samples": ["CORP-12345678"] }]'],
];

test('I-32: --help(-h)의 모든 줄이 80칸(표시 폭) 안이고, 넘던 11줄은 DESIGN "도움말 출력" 글자 그대로예요', () => {
  const sb = sandbox();
  try {
    for (const flag of ['--help', '-h']) {
      const r = runCli(sb, [flag]);
      assert.equal(r.code, 0, r.stderr);
      const L = lines(r.stdout);
      // AI 요약 회차(PRD A28, DESIGN 2026-10-22)에 --summary 세 줄과 설정 파일 예 둘째 줄을 더해 54줄이에요(80칸 안, 가장 긴 줄은 그대로 79칸).
      assert.equal(L.length, 54, 'DESIGN의 54줄이에요');
      const over = L.filter((l) => displayWidth(l) > 80);
      assert.deepEqual(over, [], `80칸을 넘는 줄: ${over.join(' / ')}`);
      assert.equal(Math.max(...L.map(displayWidth)), 79, '가장 긴 줄은 79칸이에요');
      for (const block of HELP_CHANGED) {
        const i = L.indexOf(block[0]!);
        assert.ok(i >= 0, `도움말에 "${block[0]}" 줄이 있어요`);
        assert.deepEqual(L.slice(i, i + block.length), block);
      }
      // 설정 파일·사용자 패턴 예시는 줄을 나눠도 올바른 JSON이에요(예시 값은 README와 같아요).
      const example = (label: string) => {
        const i = L.findIndex((l) => l.startsWith(label));
        const body: string[] = [];
        for (let j = i + 1; j < L.length && /^ +\S/.test(L[j]!); j++) body.push(L[j]!.trim());
        return JSON.parse(body.join(' ').replace(/^예\) /, '')) as unknown;
      };
      assert.deepEqual(example('설정 파일'), { roots: ['C:/work'], dayStartHour: 3, hideIdentity: false, summary: false });
      assert.deepEqual(example('사용자 패턴'), [{ name: '사내 토큰', pattern: 'CORP-[0-9]{8}', samples: ['CORP-12345678'] }]);
    }
  } finally {
    sb.cleanup();
  }
});
