// F2 완료 기준 시험:
// 가짜 비밀 값 10종 이상이 든 시험 기록으로 일지와 보관본을 만들면 결과물 어디에도 원문이 없고,
// 검사 명령은 종류별 가린 개수와 "남은 의심 0건, 통과"를 보여 줘요. 커밋 해시, 파일 경로, 일반 문장은 가려지지 않고,
// 원문에 가림 표시와 같은 모양의 글자가 들어 있어도 검사의 가린 개수와 화면의 가림 표시에 들지 않아요.
// 이름·이메일 가리기 옵션을 켜면 일지에서 경로 속 사용자 이름 부분과 이메일 주소만 더 가려지고, 끄면(기본) 그대로 남아요.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { countMarkers } from '../src/redact/marker.js';
import { fakeSecrets } from '../src/redact/samples.js';
import { startServer } from '../src/web/server.js';
import type { DayLog } from '../src/worklog/types.js';
import {
  rowText,
  assistantText,
  assistantToolUse,
  commitAt,
  customTitle,
  initRepo,
  kst,
  lastPrompt,
  listFilesRec,
  readJson,
  runCli,
  sandbox,
  toolResult,
  userText,
  writeSession,
  type Sandbox,
} from './helpers.js';

const DATE = '2026-10-15';
const ME = 'dev.kim@example.test';
const f = fakeSecrets();
const SECRETS: Record<string, string> = {
  githubToken: f.githubToken,
  githubPat: f.githubPat,
  awsAccessKey: f.awsAccessKey,
  awsSecretKey: f.awsSecretKey,
  jwt: f.jwt,
  openaiKey: f.openaiKey,
  anthropicKey: f.anthropicKey,
  slackToken: f.slackToken,
  slackWebhook: f.slackWebhook,
  googleKey: f.googleKey,
  stripeKey: f.stripeKey,
  npmToken: f.npmToken,
  hfToken: f.hfToken,
  supabaseKey: f.supabaseKey,
  gitlabToken: f.gitlabToken,
  urlPassword: f.urlPassword,
  dbPassword: f.dbPassword,
  jsonApiKey: f.jsonApiKey,
  bearer: f.bearer,
  basicAuth: f.basicAuth,
  privateKeyBody: f.privateKey.split('\n')[1]!,
};
const NORMAL_SENTENCE = '로그인 토큰 만료 처리를 고쳤어요';
const FAKE_PATH_WIN = 'C:\\Users\\testuser\\proj\\src\\keys\\token-store.ts';
const FAKE_PATH_POSIX = '/home/testuser/app/config/secret-manager.ts';
const FAKE_EMAIL = 'someone.kim@example.test';

let sb: Sandbox;
let repoDir: string;
let commitHash: string;

before(() => {
  sb = sandbox();
  repoDir = join(sb.root, 'work', 'svc');
  initRepo(sb, repoDir, ME);
  commitHash = commitAt(sb, repoDir, `${NORMAL_SENTENCE} (토큰 ${f.githubPat} 제거)`, '2026-10-15T11:00:00+09:00');

  const A = { sid: 'f2000000-0000-4000-8000-000000000001', cwd: repoDir };
  writeSession(sb, repoDir, A.sid, [
    userText(
      { ...A, ts: kst(DATE, '10:00') },
      `배포가 안 돼요. GitHub 토큰 ${f.githubToken}, AWS 키 ${f.awsAccessKey}, 파일 ${FAKE_PATH_WIN} 와 ${FAKE_PATH_POSIX} 를 봐 주세요. 담당 ${FAKE_EMAIL}`,
    ),
    assistantText({ ...A, ts: kst(DATE, '10:01') }, `JWT ${f.jwt} 와 OpenAI 키 ${f.openaiKey} 가 보여요. ${NORMAL_SENTENCE}`),
    assistantToolUse({ ...A, ts: kst(DATE, '10:02') }, 'toolu_1', 'Bash', {
      command: `export ANTHROPIC_API_KEY=${f.anthropicKey} && curl -H "Authorization: Bearer ${f.bearer}" ${f.slackWebhook}`,
      api_key: f.jsonApiKey,
    }),
    toolResult({ ...A, ts: kst(DATE, '10:03') }, 'toolu_1', `${f.privateKey}\nAWS_SECRET_ACCESS_KEY=${f.awsSecretKey}`),
    assistantToolUse({ ...A, ts: kst(DATE, '10:04') }, 'toolu_2', 'Write', {
      file_path: FAKE_PATH_WIN,
      content: `const k = "${f.stripeKey}";`,
    }),
    userText(
      { ...A, ts: kst(DATE, '10:05') },
      `설정은 DATABASE_URL=postgres://app:${f.urlPassword}@db.local/app 이고 DB_PASSWORD=${f.dbPassword}, aws_secret_access_key = ${f.awsSecretKey}, Authorization: Basic ${f.basicAuth}`,
    ),
    userText({ ...A, ts: kst(DATE, '10:06') }, `npm ${f.npmToken} hf ${f.hfToken} sb ${f.supabaseKey} gl ${f.gitlabToken} slack ${f.slackToken} google ${f.googleKey}`),
    customTitle(A.sid, `배포 키 ${f.googleKey} 정리`),
    lastPrompt(A.sid, `마지막으로 ${f.stripeKey} 확인`),
  ]);
});

after(() => sb?.cleanup());

function assertNoSecrets(text: string, where: string) {
  for (const [name, secret] of Object.entries(SECRETS)) {
    const mdEscaped = secret.replace(/[\\`*_<>]/g, (c) => `\\${c}`);
    const jsonEscaped = JSON.stringify(secret).slice(1, -1);
    assert.ok(!text.includes(secret) && !text.includes(mdEscaped) && !text.includes(jsonEscaped), `${where} 에 ${name} 원문이 남았어요`);
  }
}

test('F2: 가짜 비밀 값 10종 이상 → 일지·보관본·출력 어디에도 원문이 없어요', () => {
  assert.ok(Object.keys(SECRETS).length >= 10);
  const r = runCli(sb, ['--date', DATE]);
  assert.equal(r.code, 0, r.stderr);
  assertNoSecrets(r.stdout + r.stderr, '터미널 출력');
  const files = listFilesRec(sb.dataDir);
  assert.ok(files.some((p) => p.endsWith('.md')) && files.some((p) => p.endsWith('.jsonl')), '일지와 보관본이 있어야 해요');
  for (const file of files) assertNoSecrets(readFileSync(file, 'utf8'), file);
});

test('F2: 커밋 해시·파일 경로·일반 문장은 가려지지 않고, 이름·이메일은 기본으로 그대로예요', () => {
  const md = readFileSync(join(sb.dataDir, 'worklogs', `${DATE}.md`), 'utf8');
  assert.ok(md.includes(commitHash.slice(0, 7)), '커밋 해시');
  assert.ok(md.includes(repoDir), '저장소 경로');
  assert.ok(md.includes(NORMAL_SENTENCE), '일반 문장');
  const day = readJson<DayLog>(join(sb.dataDir, 'worklogs', `${DATE}.json`));
  const req = day.projects[0]!.sessions[0]!.firstRequest!;
  assert.ok(req.includes('[가림:GitHub 토큰]') && req.includes('[가림:AWS 액세스 키]'), req);
  // 요청은 앞부분만 잘라 넣어서 경로가 잘릴 수 있어요. 보관본에서 확인해요.
  const archive = listFilesRec(join(sb.dataDir, 'archive', 'projects'))
    .filter((p) => p.endsWith('.jsonl'))
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n');
  assert.ok(archive.includes(JSON.stringify(FAKE_PATH_WIN).slice(1, -1)), '보관본에 파일 경로가 그대로 있어요');
  assert.ok(archive.includes(FAKE_PATH_POSIX) && archive.includes(FAKE_EMAIL), '보관본에는 이름·이메일 가리기를 쓰지 않아요');
  assert.ok(day.hideIdentity === false && Object.keys(day.identity).length === 0);
});

test('F2: 검사 명령은 종류별 가린 개수와 "남은 의심 0건" 통과를 보여 줘요', () => {
  const r = runCli(sb, ['check']);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /\[통과\] 남은 의심 0건, 놓친 패턴 0개/);
  assert.match(r.stdout, /^ {3}남은 의심 +0건$/m);
  assert.match(r.stdout, /잡힘 19 · 놓침 0/);
  // 가린 자리 줄은 종류가 많으면 80칸을 넘어서 디자인이 줄을 나눌 수 있어요. 한 줄인지가 아니라 종류별 수가 맞는지 봐요.
  const archiveRow = rowText(r.stdout, '가린 자리 (보관본)');
  const worklogRow = rowText(r.stdout, '가린 자리 (일지)');
  const archiveMarkers = countMarkers(
    listFilesRec(join(sb.dataDir, 'archive', 'projects'))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n'),
  );
  const worklogMarkers = countMarkers(readFileSync(join(sb.dataDir, 'worklogs', `${DATE}.md`), 'utf8'));
  for (const label of ['GitHub 토큰', 'AWS 액세스 키', 'JWT', 'OpenAI API 키', 'Anthropic API 키', 'Bearer 토큰', 'Slack 웹훅 주소', '이름=값 비밀 줄', '접속 주소 비밀번호']) {
    assert.ok(archiveMarkers[label]! > 0, label);
    assert.ok(archiveRow.includes(`${label} ${archiveMarkers[label]}`), `보관본 ${label}: ${archiveRow}`);
  }
  for (const [label, n] of Object.entries(worklogMarkers)) assert.ok(worklogRow.includes(`${label} ${n}`), `일지 ${label}: ${worklogRow}`);
  assert.ok(worklogMarkers['GitHub 토큰']! > 0);
  assertNoSecrets(r.stdout, '검사 출력');
});

test('F2: 이름·이메일 가리기를 켜면 일지에서 경로 속 사용자 이름과 이메일만 더 가려요', () => {
  const sb2 = { ...sb, dataDir: join(sb.root, 'data-hide') };
  const r = runCli(sb2, ['--date', DATE, '--hide-identity']);
  assert.equal(r.code, 0, r.stderr);
  const day = readJson<DayLog>(join(sb2.dataDir, 'worklogs', `${DATE}.json`));
  // S3 이름·이메일 칸: 80칸을 넘으면 디자인이 줄을 나눌 수 있어서, 켜짐·종류별 수·보관본 미적용 안내가 있는지만 봐요.
  const idRow = rowText(r.stdout, '이름·이메일');
  assert.ok(idRow.includes('켜짐'), idRow);
  assert.ok(Object.keys(day.identity).length > 0, '이름·이메일을 가린 자리가 있어야 해요');
  for (const [label, n] of Object.entries(day.identity)) assert.ok(idRow.includes(`${label} ${n}개`), `${label}: ${idRow}`);
  assert.ok(idRow.includes('보관본'), idRow);
  const s = day.projects[0]!.sessions[0]!;
  // 요청 앞부분 100자 안에 들어간 경로 속 이름은 가려져요.
  const off = readJson<DayLog>(join(sb.dataDir, 'worklogs', `${DATE}.json`)).projects[0]!.sessions[0]!;
  assert.ok(off.firstRequest!.includes('testuser'), '끄면 그대로');
  assert.ok(!s.firstRequest!.includes('testuser'), s.firstRequest!);
  assert.ok(s.firstRequest!.includes('C:\\Users\\[가림:사용자 이름]\\proj'), s.firstRequest!);
  assert.ok(day.projects[0]!.path!.includes(repoDir.split(/[\\/]/).pop()!), '경로의 나머지 부분은 남아요');
  assert.ok(day.projects[0]!.commits[0]!.subject.includes(NORMAL_SENTENCE), '일반 문장은 남아요');
  const md = readFileSync(join(sb2.dataDir, 'worklogs', `${DATE}.md`), 'utf8');
  assert.ok(!md.includes('testuser'));
  assert.match(md, /이름·이메일 가리기: 켜짐/);
  // 보관본에는 쓰지 않아요
  const archive = listFilesRec(join(sb2.dataDir, 'archive', 'projects'))
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n');
  assert.ok(archive.includes('testuser') && archive.includes(FAKE_EMAIL));
  // 검사: 켠 일지에서 남은 이름·이메일 0건
  const c = runCli(sb2, ['check']);
  assert.equal(c.code, 0, c.stdout);
  assert.match(c.stdout, /이름·이메일 \(일지만\) {2}켠 일지 \d+개 — 사용자 이름 0건 · 이메일 0건/);
});

test('F2: 이메일도 옵션을 켜면 일지에서 가려요', () => {
  // 요청 앞부분 100자에는 이메일이 안 들어가서, 이메일이 든 커밋으로 따로 확인해요.
  commitAt(sb, repoDir, `리뷰 요청 ${FAKE_EMAIL}`, '2026-10-15T12:00:00+09:00');
  const sb3 = { ...sb, dataDir: join(sb.root, 'data-hide2') };
  runCli(sb3, ['--date', DATE]);
  const offMd = readFileSync(join(sb3.dataDir, 'worklogs', `${DATE}.md`), 'utf8');
  assert.ok(offMd.includes(FAKE_EMAIL), '끄면 그대로');
  runCli(sb3, ['--date', DATE, '--hide-identity']);
  const onMd = readFileSync(join(sb3.dataDir, 'worklogs', `${DATE}.md`), 'utf8');
  assert.ok(!onMd.includes(FAKE_EMAIL) && onMd.includes('리뷰 요청 [가림:이메일]'), onMd);
});

test('F2: 결과물에 비밀 값이 남아 있으면 검사가 실패하고, 값 대신 위치만 알려요', () => {
  const sb4 = { ...sb, dataDir: join(sb.root, 'data-leak') };
  runCli(sb4, ['--date', DATE]);
  const planted = join(sb4.dataDir, 'worklogs', '2026-01-01.md');
  writeFileSync(planted, `# 심어 둔 파일\n\n첫 줄은 괜찮아요\n토큰 ${f.githubToken}\n`);
  const r = runCli(sb4, ['check']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\[실패\] 남은 의심 1건/);
  assert.match(r.stdout, /worklogs\/2026-01-01\.md {2}줄 4 \(GitHub 토큰 모양\)/);
  assert.ok(!r.stdout.includes(f.githubToken), '검사 출력에 값이 나오면 안 돼요');
});

function httpGet(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  });
}

const literalCount = (text: string) => text.split('［가림:').length - 1;
const markerSum = (text: string) => Object.values(countMarkers(text)).reduce((a, b) => a + b, 0);

test('F2: 원문에 가림 표시와 같은 모양의 글자가 있어도 검사의 가린 개수·화면의 가림 표시·다시 가리기에 들지 않아요', async () => {
  const s = sandbox();
  try {
    const repo = join(s.root, 'work', 'lit');
    initRepo(s, repo, ME);
    // 원문(커밋 메시지·세션 대화·제목)에 글자 그대로 [가림:…]이 들어 있어요. 진짜 비밀 값은 2개(일지), 1개(보관본)예요.
    commitAt(s, repo, `표시 설명 [가림:종류] 와 ${f.githubPat}`, '2026-10-15T11:00:00+09:00');
    const A = { sid: 'f2110000-0000-4000-8000-000000000001', cwd: repo };
    writeSession(s, repo, A.sid, [
      userText({ ...A, ts: kst(DATE, '10:00') }, `글자 [가림:GitHub 토큰] 와 진짜 ${f.githubToken} 그리고 CORP-12345678`),
      assistantText({ ...A, ts: kst(DATE, '10:01') }, '[가림:이름=값 비밀 줄] 모양은 도구 표시예요'),
      customTitle(A.sid, '[가림:Anthropic API 키] 설명서'),
    ]);
    const r = runCli(s, ['--date', DATE]);
    assert.equal(r.code, 0, r.stderr);
    // 가림 칸은 일지에 든 수, 이번 보관에서 새로 가린 값은 보관 칸 아래예요(DESIGN S3 가·나 4·5번, I-09).
    assert.equal(rowText(r.stdout, '가림'), '가림 일지에 2개 GitHub 토큰 2');
    assert.match(rowText(r.stdout, '보관'), /\(보관하며 새로 가린 값 1개\)$/);

    const mdPath = join(s.dataDir, 'worklogs', `${DATE}.md`);
    const archiveText = () =>
      listFilesRec(join(s.dataDir, 'archive', 'projects'))
        .map((p) => readFileSync(p, 'utf8'))
        .join('\n');
    let md = readFileSync(mdPath, 'utf8');
    // 도구가 가린 자리만 [가림:…]이고, 원문 글자는 ［가림:…]으로 구분돼 남아요(뜻은 읽을 수 있어요).
    assert.deepEqual(countMarkers(md), { 'GitHub 토큰': 2 });
    assert.equal(literalCount(md), 3, md);
    assert.ok(md.includes('［가림:Anthropic API 키] 설명서') && md.includes('［가림:종류]'));
    assert.deepEqual(countMarkers(archiveText()), { 'GitHub 토큰': 1 });
    assert.equal(literalCount(archiveText()), 3);
    const day = readJson<DayLog>(join(s.dataDir, 'worklogs', `${DATE}.json`));
    assert.deepEqual(day.redactions, { 'GitHub 토큰': 2 });

    // 검사: 가린 개수에 원문 글자가 들지 않고 통과해요.
    let c = runCli(s, ['check']);
    assert.equal(c.code, 0, c.stdout);
    assert.equal(rowText(c.stdout, '가린 자리 (일지)'), '가린 자리 (일지) GitHub 토큰 2');
    assert.equal(rowText(c.stdout, '가린 자리 (보관본)'), '가린 자리 (보관본) GitHub 토큰 1');

    // 화면(S2): 칩은 도구가 가린 자리 2개 + 설명 줄의 예시 1개뿐이고, 원문 글자는 칩이 아닌 글자로 보여요.
    const chips = (body: string) => body.split('<span class="redacted"').length - 1;
    let srv = await startServer({ dataDir: s.dataDir, port: 0, hideIdentity: false });
    try {
      const body = await httpGet(srv.port, `/day/${DATE}`);
      assert.equal(chips(body), 2 + 1, body);
      assert.ok(body.includes('［가림:Anthropic API 키] 설명서'));
      assert.ok(!body.includes('title="가린 자리">［'), '원문 글자는 칩으로 감싸지 않아요');
    } finally {
      srv.server.closeAllConnections();
      await new Promise<void>((done) => srv.server.close(() => done()));
    }

    // 다시 가리기: 새 패턴으로 늘어난 자리만 세고, 원문 글자는 그대로예요.
    writeFileSync(join(s.dataDir, 'patterns.json'), JSON.stringify([{ name: '사내 토큰', pattern: 'CORP-[0-9]{8}' }]));
    const before = { md: markerSum(md), archive: markerSum(archiveText()) };
    const rr = runCli(s, ['redact', '--yes']);
    assert.equal(rr.code, 0, rr.stdout + rr.stderr);
    md = readFileSync(mdPath, 'utf8');
    assert.deepEqual(countMarkers(md), { 'GitHub 토큰': 2, '사내 토큰': 1 });
    assert.deepEqual(countMarkers(archiveText()), { 'GitHub 토큰': 1, '사내 토큰': 1 });
    assert.equal(literalCount(md), 3);
    assert.equal(literalCount(archiveText()), 3);
    // 확인 출력의 파일별 수 = 실제로 늘어난 가림 표시 수
    const shown = (rel: string) => Number(new RegExp(`^ +(\\d+) +${rel.replace(/[.]/g, '\\.')}$`, 'm').exec(rr.stdout)?.[1]);
    assert.equal(shown(`worklogs/${DATE}.md`), markerSum(md) - before.md, rr.stdout);
    assert.equal(markerSum(archiveText()) - before.archive, 1);
    c = runCli(s, ['check']);
    assert.equal(c.code, 0, c.stdout);
    assert.equal(rowText(c.stdout, '가린 자리 (일지)'), '가린 자리 (일지) GitHub 토큰 2 · 사내 토큰 1');
    srv = await startServer({ dataDir: s.dataDir, port: 0, hideIdentity: false });
    try {
      assert.equal(chips(await httpGet(srv.port, `/day/${DATE}`)), 3 + 1);
    } finally {
      srv.server.closeAllConnections();
      await new Promise<void>((done) => srv.server.close(() => done()));
    }
  } finally {
    s.cleanup();
  }
});
