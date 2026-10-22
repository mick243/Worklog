// 로컬 화면(S1·S2) 시험: 127.0.0.1에서만 열리고, 데이터 폴더의 결과만 읽으며, 읽기 전용이에요.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ArchiveIndex } from '../src/archive/archive.js';
import { fakeSecrets } from '../src/redact/samples.js';
import { startServer } from '../src/web/server.js';
import {
  assistantText,
  commitAt,
  customTitle,
  encodeProject,
  initRepo,
  kst,
  listFilesRec,
  runCli,
  sandbox,
  userText,
  writeSession,
  type Sandbox,
} from './helpers.js';

const DATE = '2026-10-15';
const f = fakeSecrets();
let sb: Sandbox;
let repoDir: string;

function get(port: number, path: string, opts: { host?: string; method?: string } = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.host ? { host: opts.host } : {} }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(() => {
  sb = sandbox();
  repoDir = join(sb.root, 'work', 'web-app');
  initRepo(sb, repoDir, 'dev.kim@example.test');
  commitAt(sb, repoDir, '화면 커밋', '2026-10-15T11:00:00+09:00');
  const A = { sid: 'web00000-0000-4000-8000-000000000001', cwd: repoDir };
  writeSession(sb, repoDir, A.sid, [
    userText({ ...A, ts: kst(DATE, '10:00') }, `<script>alert(1)</script> 토큰 ${f.githubToken} 확인해 줘`),
    assistantText({ ...A, ts: kst(DATE, '10:05') }, '확인했어요'),
    customTitle(A.sid, '화면 시험 세션'),
  ]);
  const scratch = join(sb.root, 'scratch');
  mkdirSync(scratch);
  writeSession(sb, scratch, 'web00000-0000-4000-8000-000000000002', [
    userText({ sid: 'web00000-0000-4000-8000-000000000002', cwd: scratch, ts: kst('2026-10-16', '09:00') }, '다음 날 메모'),
  ]);
  assert.equal(runCli(sb, ['--date', DATE]).code, 0);
  assert.equal(runCli(sb, ['--date', '2026-10-16']).code, 0);
});

after(() => sb?.cleanup());

test('S1·S2: 127.0.0.1에서만 열고, 날짜 목록과 하루 일지를 보여 줘요', async () => {
  const { server, port } = await startServer({ dataDir: sb.dataDir, port: 0, hideIdentity: false });
  try {
    assert.equal((server.address() as AddressInfo).address, '127.0.0.1');

    const s1 = await get(port, '/');
    assert.equal(s1.status, 200);
    assert.match(s1.body, /<title>작업일지 — cc-worklog<\/title>/);
    assert.match(s1.body, /일지 2일 · 2026-10-15 ~ 2026-10-16/);
    assert.match(s1.body, /href="\/day\/2026-10-15"/);
    assert.match(s1.body, /보관됨/);
    assert.match(s1.body, /href="\/styles\/tokens\.css"/);
    assert.ok(!/<script/i.test(s1.body), '페이지에 스크립트가 없어요');
    assert.match(String(s1.headers['content-security-policy']), /default-src 'none'/);

    const s2 = await get(port, `/day/${DATE}`);
    assert.equal(s2.status, 200);
    assert.match(s2.body, /2026-10-15 \(목\)/);
    assert.match(s2.body, /화면 시험 세션/);
    assert.match(s2.body, /web-app/);
    assert.match(s2.body, /<span class="redacted" title="가린 자리">\[가림:GitHub 토큰\]<\/span>/);
    assert.match(s2.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, '요청 글은 글자 그대로 보여 줘요');
    assert.ok(!s2.body.includes('<script>'), '요청 속 태그가 실행되면 안 돼요');
    assert.ok(!s2.body.includes(f.githubToken));
    assert.match(s2.body, /같은 내용의 마크다운 파일/);
    assert.ok(s2.body.includes(join(sb.dataDir, 'worklogs', `${DATE}.md`).replace(/\\/g, '\\')), '마크다운 파일 위치');
    assert.match(s2.body, /href="\/day\/2026-10-16"/, '다음 날짜');
    assert.match(s2.body, /커밋/);

    const css = await get(port, '/styles/tokens.css');
    assert.equal(css.status, 200);
    assert.match(css.body, /--color-bg/);

    const empty = await get(port, '/day/2026-01-01');
    assert.equal(empty.status, 404);
    assert.match(empty.body, /이 날짜의 일지가 없어요/);

    assert.equal((await get(port, '/day/../../etc')).status, 404);
    assert.equal((await get(port, '/styles/../../package.json')).status, 404);
    assert.equal((await get(port, '/', { host: 'evil.example:80' })).status, 403, '다른 주소로 위장한 요청은 막아요');
    assert.equal((await get(port, '/', { method: 'POST' })).status, 405, '읽기 전용');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('S1: 원본이 지워지면 "보관본만 남음"으로 보여 줘요 (마지막 실행 기준)', async () => {
  rmSync(sb.projectsDir, { recursive: true, force: true });
  mkdirSync(sb.projectsDir, { recursive: true });
  assert.equal(runCli(sb, ['archive']).code, 0);
  const { server, port } = await startServer({ dataDir: sb.dataDir, port: 0, hideIdentity: false });
  try {
    const s1 = await get(port, '/');
    assert.match(s1.body, /보관본만 남음/);
    // 보관 상태의 기준 시각은 맨 위 기준 줄에 있어요(I-12, 취합이 예전 "보관 상태는 … 실행 기준이에요" 줄을 옮김).
    assert.match(s1.body, /화면은 마지막 실행\(\d{2}-\d{2} \d{2}:\d{2}\) 기준이에요/);
    assert.ok(!s1.body.includes('보관 상태는'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/**
 * 한 번도 보관하지 못하게 만들어요: 보관본이 들어갈 폴더 자리에 같은 이름의 파일을 둬요.
 * (읽기 전용 파일과 달리 관리자 계정에서도 실패해요)
 */
function blockArchiveDir(s: Sandbox, cwd: string): string {
  const p = join(s.dataDir, 'archive', 'projects', encodeProject(cwd));
  mkdirSync(join(s.dataDir, 'archive', 'projects'), { recursive: true });
  writeFileSync(p, 'not a folder');
  return p;
}

test('F3: 보관에 실패한 세션이 있을 때만 S3 [경고]와 S1·S2의 "삭제 임박"·"보관 실패"가 나오고, 일지가 없는 날짜의 실패 세션은 S1 배너 한 줄로 나와요', { skip: isRoot ? '관리자 계정은 읽기 전용 파일도 쓸 수 있어 실패를 흉내 낼 수 없어요' : false }, async () => {
  const s = sandbox();
  const locked: string[] = [];
  try {
    mkdirSync(s.claudeDir, { recursive: true });
    writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 30 }));
    const cwd = join(s.root, 'notes');
    mkdirSync(cwd);
    const B = { sid: 'f3f00000-0000-4000-8000-00000000000b', cwd };
    const C = { sid: 'f3f00000-0000-4000-8000-00000000000c', cwd };
    const D = { sid: 'f3f00000-0000-4000-8000-00000000000d', cwd };
    const b = writeSession(s, cwd, B.sid, [userText({ ...B, ts: kst(DATE, '09:00') }, '오래된 세션'), assistantText({ ...B, ts: kst(DATE, '09:05') }, '답')]);
    const c = writeSession(s, cwd, C.sid, [userText({ ...C, ts: kst('2026-10-16', '09:00') }, '최근 세션'), assistantText({ ...C, ts: kst('2026-10-16', '09:05') }, '답')]);
    writeSession(s, cwd, D.sid, [userText({ ...D, ts: kst(DATE, '13:00') }, '잘 보관되는 세션'), assistantText({ ...D, ts: kst(DATE, '13:05') }, '답')]);
    const old = new Date(Date.now() - 25 * 86_400_000);
    utimesSync(b, old, old);
    // 세션 없이 커밋만 있는 날
    const repo = join(s.root, 'repo');
    initRepo(s, repo, 'dev.kim@example.test');
    commitAt(s, repo, '커밋만 있는 날', '2026-10-14T11:00:00+09:00');
    assert.equal(runCli(s, ['--date', '2026-10-14', '--root', repo]).code, 0);
    for (const d of [DATE, '2026-10-16']) {
      const r = runCli(s, ['--date', d]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(!r.stdout.includes('[경고]'), '보관에 성공한 실행에는 경고가 없어요');
    }
    // 원본이 늘었는데 보관본을 쓸 수 없게 만들어요(읽기 전용).
    appendFileSync(b, `${userText({ ...B, ts: kst(DATE, '09:30') }, '더 쓴 줄')}\n`);
    utimesSync(b, old, old);
    appendFileSync(c, `${userText({ ...C, ts: kst('2026-10-16', '09:30') }, '더 쓴 줄')}\n`);
    for (const sid of [B.sid, C.sid]) {
      const p = listFilesRec(join(s.dataDir, 'archive', 'projects')).find((x) => x.endsWith(`${sid}.jsonl`))!;
      chmodSync(p, 0o444);
      locked.push(p);
    }
    // 일지를 만들지 않은 날짜(10-13)의 세션: 한 번도 보관하지 못해요.
    const blocked = join(s.root, 'blocked');
    mkdirSync(blocked);
    const E = { sid: 'f3f00000-0000-4000-8000-00000000000e', cwd: blocked };
    writeSession(s, blocked, E.sid, [userText({ ...E, ts: kst('2026-10-13', '09:00') }, '일지 없는 날 세션'), assistantText({ ...E, ts: kst('2026-10-13', '09:05') }, '답')]);
    blockArchiveDir(s, blocked);
    const r = runCli(s, ['archive']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[경고\] 삭제 임박: 보관에 실패한 세션 1개가 7일 안에 지워질 수 있어요/);
    assert.match(r.stdout, /\[경고\] 보관하지 못한 파일 3개/);
    assert.ok(!/이번에 보관했어요/.test(r.stdout));
    // 보관 색인: 마지막 실행에서 보관에 실패했는지 (한 번도 보관하지 못한 파일도 자리가 있어요, PRD 5장)
    const idx = JSON.parse(readFileSync(join(s.dataDir, 'archive', 'index.json'), 'utf8')) as ArchiveIndex;
    const entryOf = (sid: string) => Object.values(idx.files).find((e) => e.sessionId === sid)!;
    assert.equal(entryOf(B.sid).failed, true);
    assert.equal(entryOf(C.sid).failed, true);
    assert.equal(entryOf(D.sid).failed, false);
    assert.equal(entryOf(E.sid).failed, true);
    assert.equal(entryOf(E.sid).archiveBytes, 0, '보관본은 없어요');

    const { server, port } = await startServer({ dataDir: s.dataDir, port: 0, hideIdentity: false });
    try {
      const s1 = await get(port, '/');
      const row = (date: string) => {
        const i = s1.body.indexOf(`class="date-row__link" href="/day/${date}"`);
        assert.ok(i >= 0, date);
        return s1.body.slice(i, s1.body.indexOf('</tr>', i));
      };
      // 섞인 날은 가장 급한 것 하나와 그 개수 (삭제 임박 > 보관 실패 > 보관됨 > 보관본만 남음)
      assert.match(row(DATE), /삭제 임박 1개 · D-5/);
      assert.match(row('2026-10-16'), /보관 실패/);
      assert.match(row('2026-10-14'), /세션 없음/);
      assert.ok(!s1.body.includes('보관 안 됨'), '옛 이름은 쓰지 않아요');
      // 배너: 날짜 2개(링크) + 일지가 없는 날짜의 보관 실패 세션 1개(링크 없이 한 줄)
      const banner = s1.body.slice(s1.body.indexOf('<div class="banner'), s1.body.indexOf('</div>', s1.body.indexOf('<div class="banner')));
      assert.match(banner, /삭제 임박/);
      assert.match(banner, /보관하지 못한 세션이 있는 날짜가 2개 있어요/);
      assert.match(banner, /일지가 없는 날짜의 보관 실패 세션 1개도 있어요/);
      assert.ok(!banner.includes('2026-10-13'), '일지가 없는 날짜는 링크로 나열하지 않아요');
      assert.ok(!s1.body.includes('href="/day/2026-10-13"'));
      assert.match((await get(port, `/day/${DATE}`)).body, /삭제 임박/);
      const s2 = (await get(port, '/day/2026-10-16')).body;
      assert.match(s2, /<strong class="banner__title">.*보관 실패<\/strong>/);
      assert.match(s2, /class="badge badge--pending">.*보관 실패<\/span>/);
      assert.ok(!s2.includes('보관 안 됨'));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  } finally {
    for (const p of locked) chmodSync(p, 0o644);
    s.cleanup();
  }
});

test('S1: 일지가 없으면 빈 상태 안내를 보여 줘요', async () => {
  const dir = join(sb.root, 'empty-data');
  const { server, port } = await startServer({ dataDir: dir, port: 0, hideIdentity: false });
  try {
    const s1 = await get(port, '/');
    assert.equal(s1.status, 200);
    assert.match(s1.body, /아직 만든 일지가 없어요/);
    assert.ok(!s1.body.includes('class="banner'), '보관 실패가 없으면 배너도 없어요');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('S1: 일지가 하나도 없어도 보관 실패 세션은 배너 한 줄로 알려요 (보관만 실행한 경우)', async () => {
  const s = sandbox();
  try {
    const cwd = join(s.root, 'only-archive');
    mkdirSync(cwd);
    const A = { sid: 'f3f00000-0000-4000-8000-0000000000aa', cwd };
    writeSession(s, cwd, A.sid, [userText({ ...A, ts: kst(DATE, '09:00') }, '보관만 한 세션'), assistantText({ ...A, ts: kst(DATE, '09:05') }, '답')]);
    blockArchiveDir(s, cwd);
    const r = runCli(s, ['archive']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[경고\] 보관하지 못한 파일 1개/);
    const { server, port } = await startServer({ dataDir: s.dataDir, port: 0, hideIdentity: false });
    try {
      const s1 = await get(port, '/');
      assert.equal(s1.status, 200);
      assert.match(s1.body, /아직 만든 일지가 없어요/);
      assert.match(s1.body, /<div class="banner banner--pending"/, '삭제 임박이 없으면 보관 실패 모양이에요');
      assert.match(s1.body, /보관 실패<\/strong>/);
      assert.match(s1.body, /일지가 없는 날짜의 보관 실패 세션이 1개 있어요/);
      assert.match(s1.body, /cc-worklog archive/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
    // 다음 실행에서 보관에 성공하면 배너가 사라져요 (마지막 실행 기준).
    rmSync(join(s.dataDir, 'archive', 'projects', encodeProject(cwd)));
    const ok = runCli(s, ['archive']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /새로 1개/, '처음 보관에 성공하면 "새로"로 세요');
    assert.ok(!ok.stdout.includes('[경고]'));
    const again = await startServer({ dataDir: s.dataDir, port: 0, hideIdentity: false });
    try {
      assert.ok(!(await get(again.port, '/')).body.includes('class="banner'));
    } finally {
      again.server.closeAllConnections();
      await new Promise<void>((done) => again.server.close(() => done()));
    }
  } finally {
    s.cleanup();
  }
});
