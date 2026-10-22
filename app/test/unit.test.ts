// 단위 시험: 가리기 규칙, 이름·이메일 가리기, 요청 글 고르기, cost-state 읽기, 날짜 경계, 다시 가리기 확인 답, 잠금
process.env.TZ = 'Asia/Seoul';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { askLine, isYes } from '../src/commands/redact.js';
import { acquireLock, BusyError, lockPathFor } from '../src/util/lock.js';
import { detectIdentity, maskIdentity } from '../src/redact/identity.js';
import { countMarkers, marker, neutralizeDeep, neutralizeMarkers } from '../src/redact/marker.js';
import { loadUserPatterns, PatternFileError, Redactor } from '../src/redact/redact.js';
import { BUILTIN_RULES } from '../src/redact/rules.js';
import { builtinSamples, fakeSecrets, negativeSamples } from '../src/redact/samples.js';
import { classifyLine, costFields, SEEN_TYPES_2026_10_20, toArchiveShape, userRequestText } from '../src/session/format.js';
import { truncateKeepingMarkers } from '../src/util/text.js';
import { dayKeyOf, dayRange } from '../src/util/time.js';

const r = new Redactor();

test('내장 가짜 비밀 값은 규칙마다 하나 이상 있고 모두 잡혀요 (10종 이상)', () => {
  const samples = builtinSamples();
  assert.ok(samples.length >= 10, `가짜 값 ${samples.length}종`);
  for (const rule of BUILTIN_RULES) assert.ok(samples.some((s) => s.ruleId === rule.id), `${rule.id} 시험 값 없음`);
  for (const s of samples) {
    const out = r.redactString(s.text);
    assert.ok(!out.includes(s.secret), `${s.label}: 원문이 남았어요`);
    assert.ok(out.includes(marker(s.label)), `${s.label}: 종류 표시가 없어요 → ${out.replace(s.secret, '***')}`);
  }
});

test('가리기는 두 번 해도 같고, 가린 결과에는 남은 의심이 없어요', () => {
  for (const s of builtinSamples()) {
    const once = r.redactString(s.text);
    assert.equal(r.redactString(once), once, s.label);
    assert.deepEqual(r.detect(once), {}, s.label);
  }
});

test('커밋 해시·파일 경로·아이디·일반 문장은 가리지 않아요', () => {
  for (const n of negativeSamples()) assert.equal(r.redactString(n.text), n.text, n.what);
});

test('이름=값 규칙: 여러 모양을 잡고 자리 표시는 건너뛰어요', () => {
  const f = fakeSecrets();
  const cases: Array<[string, string]> = [
    [`"apiKey": "${f.jsonApiKey}"`, f.jsonApiKey],
    [`password: '${f.dbPassword}'`, f.dbPassword],
    [`x-api-key: ${f.jsonApiKey}`, f.jsonApiKey],
    [`client_secret=${f.dbPassword}`, f.dbPassword],
    [`MY_SERVICE_TOKEN="${f.dbPassword} with space"`, `${f.dbPassword} with space`],
  ];
  for (const [text, secret] of cases) {
    const out = r.redactString(text);
    assert.ok(!out.includes(secret), text);
    assert.ok(out.includes(marker('이름=값 비밀 줄')), text);
  }
  const url = `https://example.test/cb?access_token=${f.dbPassword}&state=1`;
  const out = r.redactString(url);
  assert.ok(out.endsWith('&state=1'), out);
  for (const keep of ['API_KEY=${API_KEY}', 'token: <your-token>', 'password=********', 'primaryKey: true', 'apiKey: string', 'keyboard=qwerty123']) {
    assert.equal(r.redactString(keep), keep, keep);
  }
  // 이름보다 앞 단어가 거절돼도 뒤의 비밀은 놓치지 않아요.
  assert.ok(!r.redactString(`foo: TOKEN=${f.dbPassword}`).includes(f.dbPassword));
});

test('객체를 가릴 때 칸 이름이 비밀 이름이면 값 전체를 가려요', () => {
  const f = fakeSecrets();
  const out = r.redactDeep({ input: { api_key: f.jsonApiKey, command: `echo ${f.githubToken}` }, sessionId: 'abc' }) as {
    input: { api_key: string; command: string };
    sessionId: string;
  };
  assert.equal(out.input.api_key, marker('이름=값 비밀 줄'));
  assert.equal(out.input.command, `echo ${marker('GitHub 토큰')}`);
  assert.equal(out.sessionId, 'abc');
});

test('이름·이메일 가리기: 경로 속 사용자 이름과 이메일만 가려요', () => {
  const s = 'C:\\Users\\kim\\proj 와 C:/Users/kim/a, /home/lee/x, /Users/park/y, /c/Users/choi/z, 메일 kim@example.test, git@github.com:o/r';
  const out = maskIdentity(s);
  for (const name of ['kim\\', 'kim/', 'lee', 'park', 'choi', 'kim@example.test']) assert.ok(!out.includes(name), `${name} 남음: ${out}`);
  assert.ok(out.includes('git@github.com'), 'git 원격 주소는 남겨요');
  assert.ok(out.includes('C:\\Users\\[가림:사용자 이름]\\proj'));
  assert.deepEqual(detectIdentity(out), {});
  assert.equal(maskIdentity('C:\\Users\\Public\\x 와 https://example.test/home/feed'), 'C:\\Users\\Public\\x 와 https://example.test/home/feed');
});

test('자르기는 가림 표시 가운데를 자르지 않아요', () => {
  const s = `앞부분 ${marker('GitHub 토큰')} 뒷부분이 아주 길어요`;
  const cut = truncateKeepingMarkers(s, 10);
  assert.ok(!cut.includes('[가림:') || cut.includes(marker('GitHub 토큰')), cut);
  assert.ok(cut.endsWith('…'));
  assert.equal(truncateKeepingMarkers('짧아요', 10), '짧아요');
  const cut2 = truncateKeepingMarkers(s, 20);
  assert.equal(countMarkers(cut2)['GitHub 토큰'], 1, cut2);
});

test('사용자 패턴을 읽고 적용해요', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccwl-unit-'));
  try {
    const file = join(dir, 'patterns.json');
    writeFileSync(file, JSON.stringify([{ name: '사내 토큰', pattern: 'CORP-[0-9]{8}', samples: ['CORP-12345678'] }]));
    const patterns = loadUserPatterns(file);
    const rr = new Redactor(patterns);
    assert.equal(rr.redactString('값 CORP-12345678 끝'), `값 ${marker('사내 토큰')} 끝`);
    writeFileSync(file, JSON.stringify([{ name: '깨진', pattern: '([' }]));
    assert.throws(() => loadUserPatterns(file), PatternFileError);
    assert.deepEqual(loadUserPatterns(join(dir, 'none.json')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('사용자 요청 글만 골라요 (도구 결과·명령 출력·메타 줄 제외)', () => {
  const u = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
  assert.equal(userRequestText(u('고쳐 줘')), '고쳐 줘');
  assert.equal(userRequestText(u([{ type: 'text', text: '그림 봐 줘' }, { type: 'image', source: {} }])), '그림 봐 줘');
  assert.equal(userRequestText(u([{ type: 'tool_result', tool_use_id: 'x', content: 'out' }])), null);
  assert.equal(userRequestText(u('hi', { isMeta: true })), null);
  assert.equal(userRequestText(u('hi', { isSidechain: true })), null);
  assert.equal(userRequestText(u('<local-command-stdout>x</local-command-stdout>')), null);
  assert.equal(userRequestText(u('<command-name>/review</command-name><command-args>PR 3</command-args>')), '/review PR 3');
  assert.equal(userRequestText(u('[Request interrupted by user]')), null);
});

test('cost-state에서 추가·삭제 줄 수와 사용 시간을 찾아요', () => {
  assert.deepEqual(costFields({ type: 'cost-state', totalLinesAdded: 5, totalLinesRemoved: 2, totalDuration: 60000, totalAPIDuration: 9 }), {
    linesAdded: 5,
    linesRemoved: 2,
    durationMs: 60000,
  });
  assert.deepEqual(costFields({ type: 'cost-state', state: { lines_added: 1, lines_removed: 0, durationSeconds: 30 } }), {
    linesAdded: 1,
    linesRemoved: 0,
    durationMs: 30000,
  });
  assert.deepEqual(costFields({ type: 'cost-state', totalCostUSD: 1 }), {});
});

test('줄 종류 나누기와 보관 모양: 도구 출력·그림·생각 과정은 빼고 표시만 남겨요', () => {
  assert.equal(classifyLine('{broken').kind, 'broken');
  assert.equal(classifyLine('{"type":"brand-new"}').kind, 'unknown');
  assert.equal(classifyLine('{"type":"attachment"}').kind, 'drop');
  assert.equal(classifyLine('{"type":"user","timestamp":"2026-10-15T00:00:00Z","sessionId":"s"}').kind, 'missing');
  const c = classifyLine(
    JSON.stringify({
      type: 'user',
      timestamp: '2026-10-15T00:00:00Z',
      sessionId: 's',
      cwd: '/x',
      toolUseResult: { stdout: 'BIG' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'BIG' }, { type: 'image', source: { data: 'AAAA' } }] },
    }),
  );
  assert.equal(c.kind, 'keep');
  if (c.kind !== 'keep') return;
  const shaped = JSON.stringify(toArchiveShape(c, 's'));
  assert.ok(!shaped.includes('BIG') && !shaped.includes('AAAA') && !shaped.includes('toolUseResult'), shaped);
  assert.ok(shaped.includes('"omitted":"도구 출력"') && shaped.includes('"omitted":"그림"'), shaped);
});

test('2026-10-20에 처음 본 줄 종류: ai-title·pr-link는 남기고, 나머지 11가지는 아는 줄로 빼요 (A7·A13)', () => {
  const t = classifyLine(JSON.stringify({ type: 'ai-title', aiTitle: '자동 제목', sessionId: 's' }));
  assert.equal(t.kind, 'keep', 'timestamp·cwd가 없어도 남겨요');
  if (t.kind === 'keep') assert.deepEqual(toArchiveShape(t, 's'), { type: 'ai-title', aiTitle: '자동 제목', sessionId: 's' });
  const noSid = classifyLine(JSON.stringify({ type: 'ai-title', aiTitle: '제목' }));
  if (noSid.kind === 'keep') assert.equal(toArchiveShape(noSid, 'file-sid').sessionId, 'file-sid', 'sessionId가 없으면 파일의 세션 아이디를 붙여요');
  const pr = classifyLine(JSON.stringify({ type: 'pr-link', prNumber: 3, prUrl: 'https://github.com/o/r/pull/3', prRepository: 'o/r', timestamp: '2026-10-15T00:00:00Z', sessionId: 's' }));
  assert.equal(pr.kind, 'keep');
  assert.equal(SEEN_TYPES_2026_10_20.length, 12);
  for (const type of SEEN_TYPES_2026_10_20.filter((x) => x !== 'pr-link')) {
    assert.equal(classifyLine(JSON.stringify({ type, sessionId: 's', timestamp: '2026-10-15T00:00:00Z' })).kind, 'drop', type);
  }
  assert.equal(classifyLine('{"type":"brand-new-2027"}').kind, 'unknown', '처음 보는 종류는 여전히 건너뛴 줄로 세요');
});

test('원문 속 가림 표시 모양 글자는 "［가림:"으로 바꿔 도구가 가린 자리로 세지 않아요 (F2)', () => {
  const raw = '원문에 [가림:GitHub 토큰] 과 [가림:종류] 글자가 있어요';
  const n = neutralizeMarkers(raw);
  assert.equal(n, '원문에 ［가림:GitHub 토큰] 과 ［가림:종류] 글자가 있어요');
  assert.deepEqual(countMarkers(n), {});
  assert.equal(neutralizeMarkers(n), n, '두 번 해도 같아요');
  // 바꾼 뒤 가리면 도구가 가린 자리만 세요.
  const f = fakeSecrets();
  const safe = r.redactString(neutralizeMarkers(`${raw} ${f.githubToken}`));
  assert.deepEqual(countMarkers(safe), { 'GitHub 토큰': 1 });
  const deep = neutralizeDeep({ a: ['[가림:x]'], '[가림:k]': 1, n: 2, __proto__x: null }) as Record<string, unknown>;
  assert.deepEqual(deep, { a: ['［가림:x]'], '［가림:k]': 1, n: 2, __proto__x: null });
});

test('보관본 다시 가리기 확인 답: y·yes·예·네만 확인이고, 그냥 Enter를 포함한 나머지는 거절이에요', () => {
  for (const yes of ['y', 'Y', ' yes ', 'YES', '예', '네']) assert.equal(isYes(yes), true, yes);
  for (const no of ['', ' ', 'n', 'no', '아니요', 'yy', 'y e s']) assert.equal(isYes(no), false, JSON.stringify(no));
});

test('확인 질문(readline): 입력한 줄을 돌려주고, 그냥 Enter는 빈 글, Ctrl+C·입력 끝은 null이에요', async () => {
  const ask = async (keys: string | null) => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const p = askLine('다시 쓸까요? [y/N] ', input, output);
    if (keys === null) input.end();
    else input.write(keys);
    return p;
  };
  assert.equal(await ask('y\r'), 'y');
  assert.equal(await ask('\r'), '');
  assert.equal(await ask('\x03'), null);
  assert.equal(await ask(null), null);
});

test('객체를 다시 가려도 "__proto__" 칸이 사라지지 않아요', () => {
  const line = `{"type":"user","__proto__":{"note":"x"},"text":"${fakeSecrets().githubToken}"}`;
  const out = JSON.stringify(r.redactDeep(JSON.parse(line)));
  assert.equal(out, line.replace(fakeSecrets().githubToken, marker('GitHub 토큰')));
});

test('잠금: 살아 있는 실행이 쥐면 막고, 끝난 실행이 남긴 잠금은 치우고 가져가요', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccwl-lock-'));
  const path = lockPathFor(dir);
  try {
    writeFileSync(path, JSON.stringify({ pid: process.ppid, command: 'make' }));
    assert.throws(() => acquireLock(dir, 'redact'), (e: unknown) => e instanceof BusyError && /PID \d+, make/.test(e.message));
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    writeFileSync(path, JSON.stringify({ pid: dead, command: 'redact' }));
    const release = acquireLock(dir, 'archive');
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { pid: number }).pid, process.pid);
    release();
    assert.ok(!existsSync(path), '풀면 잠금 파일을 지워요');
    assert.ok(!path.startsWith(dir), '잠금 파일은 데이터 폴더 밖에 있어요');
  } finally {
    rmSync(path, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('하루 경계는 새벽 3시예요', () => {
  assert.equal(dayKeyOf(Date.parse('2026-10-16T02:59:00+09:00'), 3), '2026-10-15');
  assert.equal(dayKeyOf(Date.parse('2026-10-16T03:00:00+09:00'), 3), '2026-10-16');
  const { start, end } = dayRange('2026-10-15', 3);
  assert.equal(new Date(start).toISOString(), '2026-10-14T18:00:00.000Z');
  assert.equal(new Date(end).toISOString(), '2026-10-15T18:00:00.000Z');
});
