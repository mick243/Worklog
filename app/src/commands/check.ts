// 검사 명령 (F2): ① 내장 가짜 비밀 값으로 패턴마다 잡히는지 시험하고 ② 이미 만든 일지·보관본을 다시 훑어 남은 의심 문자열을 세요.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataPaths, type Config } from '../config.js';
import { detectIdentity, EMAIL_LABEL, USER_NAME_LABEL } from '../redact/identity.js';
import { pendingNotice } from '../redact/journal.js';
import { countMarkers, marker } from '../redact/marker.js';
import { loadUserPatterns, Redactor, type Counts } from '../redact/redact.js';
import { builtinSamples, negativeSamples } from '../redact/samples.js';
import { progress } from '../term/format.js';
import { renderCheckReport, UNREADABLE, type CheckReport } from '../term/s4-check.js';
import { errorCode, relPosix, walkFiles } from '../util/fs.js';
import { parseJsonText } from '../util/json.js';
import { readLines } from '../util/lines.js';
import { mdUnescape } from '../util/text.js';
import { maskedOnlyInData, remakeContext, remakeDayOf } from '../worklog/mismatch.js';
import type { DayLog } from '../worklog/types.js';

/** 파일 시스템 오류(오류 코드가 있는 오류)인지 */
const isFsError = (err: unknown) => /^E[A-Z]+$/.test(String((err as NodeJS.ErrnoException)?.code ?? ''));

function addFindings(into: Finding[], file: string, line: number, c: Counts) {
  for (const [kind, n] of Object.entries(c)) for (let i = 0; i < n; i++) into.push({ file, line, kind });
}

/**
 * 검사가 읽지 못한 일지·보관본·보관 색인·폴더 (다른 프로그램이 잡고 있음, 권한 없음 등). 남은 의심으로 세서 검사는 실패하지만,
 * 일반 비밀 값 의심과 구분해 "읽지 못함"과 원인 코드로 보여 주고 다음: 줄도 따로예요(PRD S4, 취합 13회차 차이 5).
 * 파일 내용은 담지 않아요.
 */
function addUnreadable(into: CheckReport['findings'], file: string, code: string) {
  into.push({ file, line: 0, kind: UNREADABLE, code });
}

type Finding = { file: string; line: number; kind: string };

/** 파일 하나를 훑으며 찾은 것이에요. 끝까지 읽었을 때만 검사 보고에 더해요(collectFile). */
export interface FileScan {
  /** 남은 의심 (비밀 값·읽을 수 없는 줄 등) */
  findings: Finding[];
  /**
   * 그 파일에서 찾은 사용자 이름·이메일 자리. 일지 파일만 채워요. 검사는 이것을 날짜마다 모아
   * 마크다운 자리 기준으로 다시 세요(identityOfDay, PRD A23).
   */
  identity: Finding[];
  /** 가림 표시 수 */
  markers: Counts;
}

/**
 * 파일 하나를 훑어 검사 보고에 더해요. scan이 끝까지 읽었을 때만 찾은 의심·이름·이메일·가림 표시를 더해요.
 * 파일 시스템 오류로 열지 못했거나 읽다 중간에 멈췄으면(바이트 범위 잠금, 네트워크 드라이브 끊김 등) 그 파일에서 앞서 찾은 것은
 * 모두 버리고 "읽지 못함" 1건만 남겨요. 다시 검사하면 다시 나오고, 이래야 남은 의심 수와 목록이 맞아요
 * (PRD S4 "읽지 못한 파일·폴더는 하나를 한 건으로", 취합 15회차 차이 2). 파일 시스템 오류가 아닌 오류는 그대로 던져요.
 * 돌려주는 값은 끝까지 읽었는지예요.
 */
export async function collectFile(
  report: Pick<CheckReport, 'findings' | 'identity'>,
  rel: string,
  markersInto: Counts,
  scan: (part: FileScan) => Promise<void> | void,
): Promise<boolean> {
  const part: FileScan = { findings: [], identity: [], markers: {} };
  try {
    await scan(part);
  } catch (err) {
    if (!isFsError(err)) throw err;
    addUnreadable(report.findings, rel, errorCode(err));
    return false;
  }
  for (const f of part.findings) report.findings.push(f);
  for (const f of part.identity) report.identity.findings.push(f);
  for (const [k, v] of Object.entries(part.markers)) markersInto[k] = (markersInto[k] ?? 0) + v;
  return true;
}

/** 날짜 하나의 일지 두 파일에서 찾은 사용자 이름·이메일 (끝까지 읽은 파일만, 아니면 null) */
interface DayIdentityScan {
  /** 이름·이메일 가리기가 켜진 일지인지 (이번 검사의 --hide-identity 포함) */
  idOn: boolean;
  /** 일지 마크다운에서 찾은 자리 (줄 번호와 함께) */
  md: Finding[] | null;
  /** 화면용 일지 데이터(.json)에서 찾은 자리 (줄 번호 없음) */
  json: { file: string; found: Finding[] } | null;
}

/**
 * 날짜 하나에 남은 사용자 이름·이메일을 PRD A23 단위로 세요(I-29).
 *  - "건"은 일지 마크다운에서 찾은 자리예요. 화면용 일지 데이터는 마크다운과 같은 내용이라 수에 더하지 않아요
 *    (첫 요청·마지막 요청 칸, 세션마다의 작업 폴더처럼 같은 글이 여러 칸에 있어 부풀어 보였어요).
 *  - 다만 같은 날짜 마크다운에 어떤 종류(사용자 이름 / 이메일)가 0건인데 화면용 데이터에는 남아 있으면, 그 화면용 데이터 파일을
 *    그 종류 1건(줄 번호 없음)으로 세요. 마크다운이 없거나 끝까지 읽지 못한 날짜, 마크다운만 가려진 일지, 손으로 마크다운에서 지운 경우,
 *    마크다운에 나오지 않는 칸에만 있는 경우예요. 그래서 켠 일지의 통과·실패와 끈 일지의 [알림]이 나오는지는 예전과 같아요.
 * 돌려주는 목록이 수와 위치 목록(켠 일지)의 바탕이에요.
 */
function identityOfDay(d: DayIdentityScan): Finding[] {
  const counted = [...(d.md ?? [])];
  if (d.json) {
    const inMd = new Set(counted.map((f) => f.kind));
    const jsonKinds = [...new Set(d.json.found.map((f) => f.kind))].sort();
    for (const kind of jsonKinds) if (!inMd.has(kind)) counted.push({ file: d.json.file, line: 0, kind });
  }
  return counted;
}

/** 일지 파일 이름(worklogs/YYYY-MM-DD.md|json)에서 날짜를 꺼내요. */
const DATE_OF_FILE = /(?:^|\/)(\d{4}-\d{2}-\d{2})\.(?:md|json)$/;

function walkStrings(v: unknown, fn: (s: string) => void) {
  if (typeof v === 'string') fn(v);
  else if (Array.isArray(v)) v.forEach((x) => walkStrings(x, fn));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => walkStrings(x, fn));
}

export async function buildCheckReport(cfg: Config): Promise<CheckReport> {
  const paths = dataPaths(cfg.dataDir);
  const patterns = loadUserPatterns(paths.patternsFile);
  const redactor = new Redactor(patterns);

  // ① 패턴 시험
  const builtin = builtinSamples().map((s) => {
    const out = redactor.redactString(s.text);
    return { label: s.label, caught: !out.includes(s.secret) && out.includes(marker(s.label)) };
  });
  const negatives = negativeSamples().map((n) => ({ what: n.what, intact: redactor.redactString(n.text) === n.text }));
  const user = patterns.map((p) => {
    const samples = p.samples ?? [];
    const caught = samples.filter((s) => {
      const out = redactor.redactString(s);
      return !out.includes(s) && out.includes(marker(p.name));
    }).length;
    return { name: p.name, samples: samples.length, caught };
  });

  // ② 결과물 재검사
  const report: CheckReport = {
    dataDir: cfg.dataDir,
    builtin,
    negatives,
    user,
    scanned: { worklogs: 0, archives: 0 },
    markers: { worklog: {}, archive: {} },
    findings: [],
    identity: { counted: false, worklogs: 0, userNames: 0, emails: 0, findings: [] },
    identityOff: { worklogs: 0, userNames: 0, emails: 0 },
    passed: false,
    mismatched: [],
    identityDays: [],
    remake: remakeContext(cfg),
    // 멈춘 다시 가리기는 읽기만 해서 마저 끝내지 않아요. 기록 파일·임시 파일도 지우지 않아요(A16).
    journal: pendingNotice(cfg.dataDir),
  };

  let worklogNames: string[] = [];
  try {
    worklogNames = readdirSync(paths.worklogsDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.(md|json)$/.test(n)).sort();
  } catch (err) {
    // 일지 폴더가 없으면 검사할 일지가 없어요. 있는데 읽지 못하면 말없이 넘기지 않아요.
    const code = errorCode(err);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') addUnreadable(report.findings, relPosix(cfg.dataDir, paths.worklogsDir), code);
    worklogNames = [];
  }
  const archives = walkFiles(
    paths.archiveProjectsDir,
    (n) => n.toLowerCase().endsWith('.jsonl'),
    (dir, code) => addUnreadable(report.findings, relPosix(cfg.dataDir, dir), code),
  );
  const prog = progress('훑는 중');
  const total = worklogNames.length + archives.length;
  /** 날짜별 마크다운의 가림 표시 수와 남은 의심 수 (한쪽만 가려진 일지 알아보기, 끝까지 읽은 마크다운만) */
  const mdByDate = new Map<string, { markers: Counts; found: number }>();
  /** 날짜별 화면용 일지 데이터에 남은 그 일지의 설정 (없거나 깨졌으면 null). 날짜마다 한 번만 읽어요. */
  const settingsByDate = new Map<string, { hideIdentity?: boolean; dayStartHour?: number } | null>();
  const settingsOf = (date: string) => {
    if (!settingsByDate.has(date)) {
      let s: { hideIdentity?: boolean; dayStartHour?: number } | null = null;
      try {
        const day = parseJsonText(readFileSync(join(paths.worklogsDir, `${date}.json`), 'utf8'));
        if (day && typeof day === 'object') s = day as { hideIdentity?: boolean; dayStartHour?: number };
      } catch {
        /* JSON이 없거나 깨졌으면 설정값만 봐요 */
      }
      settingsByDate.set(date, s);
    }
    return settingsByDate.get(date) ?? null;
  };
  let done = 0;
  const onDates = new Set<string>();
  const offDates = new Set<string>();
  /** 날짜별 일지 두 파일의 사용자 이름·이메일 (PRD A23: 다 훑은 뒤 마크다운 자리 기준으로 세요) */
  const idByDate = new Map<string, DayIdentityScan>();

  for (const name of worklogNames) {
    const full = join(paths.worklogsDir, name);
    const rel = relPosix(cfg.dataDir, full);
    const date = name.slice(0, 10);
    // 이름·이메일 가리기가 켜진 일지(이번 실행의 --hide-identity 포함)는 남은 이름·이메일을 위치와 함께 세어 판정에 넣어요.
    // 끈 일지도 값 없이 수만 세어 [알림]으로 알리고, 판정·종료 코드에는 넣지 않아요(PRD F2·S4·A19).
    // 두 일지 모두 "건"은 마크다운에서 찾은 자리예요(PRD A23, identityOfDay). 여기서는 파일마다 찾아 두기만 해요.
    const idOn = cfg.hideIdentity || settingsOf(date)?.hideIdentity === true;
    // 켠 일지·끈 일지의 수는 날짜 수예요(DESIGN S4 5번). .md·.json 중 하나만 남은 날짜도 세요.
    (idOn ? onDates : offDates).add(date);
    if (idOn) report.identity.counted = true;
    const day = idByDate.get(date) ?? { idOn, md: null, json: null };
    idByDate.set(date, day);
    // 파일 하나의 이름·이메일은 끝까지 읽었을 때만 받아 둬요(collectFile이 이 자리에 채워요). 의심(findings)은 보고에 바로 더해요.
    const stage = { findings: report.findings, identity: { counted: false, worklogs: 0, userNames: 0, emails: 0, findings: [] as Finding[] } };
    if (name.endsWith('.md')) {
      report.scanned.worklogs++;
      const md = { markers: {} as Counts, found: 0 };
      // 다른 프로그램이 잡고 있거나 권한이 없어 읽지 못했으면 말없이 건너뛰지 않고 위치를 알려요(검사는 실패해요).
      // 읽다 중간에 멈췄으면 앞 줄에서 찾은 의심·이름·이메일은 세지 않고 읽지 못함 1건만이에요(collectFile).
      const complete = await collectFile(stage, rel, report.markers.worklog, async (part) => {
        let lineNo = 0;
        for await (const { line } of readLines(full)) {
          lineNo++;
          countMarkers(line, part.markers);
          countMarkers(line, md.markers);
          const plain = mdUnescape(line);
          const c = redactor.detect(plain);
          md.found += Object.values(c).reduce((a, b) => a + b, 0);
          addFindings(part.findings, rel, lineNo, c);
          addFindings(part.identity, rel, lineNo, detectIdentity(plain));
        }
      });
      if (complete) {
        mdByDate.set(date, md);
        day.md = stage.identity.findings;
      }
    } else {
      // 화면용 JSON: 글 칸마다 다시 훑어요 (줄 번호 대신 파일 단위로 알려요).
      // 파일을 열지 못했으면 "읽지 못함"과 원인 코드, 내용이 올바른 JSON이 아니면 전처럼 "읽을 수 없는 일지 파일" 모양이에요.
      const complete = await collectFile(stage, rel, {}, (part) => {
        const text = readFileSync(full, 'utf8');
        let data: unknown;
        try {
          data = parseJsonText(text);
        } catch {
          part.findings.push({ file: rel, line: 0, kind: '읽을 수 없는 일지 파일' });
          return;
        }
        addFindings(part.findings, rel, 0, redactor.detectDeep(data));
        const c: Counts = {};
        walkStrings(data, (s) => {
          for (const [k, v] of Object.entries(detectIdentity(s))) c[k] = (c[k] ?? 0) + v;
        });
        addFindings(part.identity, rel, 0, c);
      });
      if (complete) day.json = { file: rel, found: stage.identity.findings };
    }
    prog.update(++done, total);
  }
  report.identity.worklogs = onDates.size;
  report.identityOff!.worklogs = offDates.size;
  // 남은 이름·이메일을 날짜마다 마크다운 자리 기준으로 세요(PRD A23, I-29). 켠 일지는 위치와 함께 판정에 넣고(수에 든 자리만 목록에),
  // 끈 일지는 값·위치 없이 수만 [알림]으로 알려요(A19). 남은 의심(비밀 값) 수는 그대로 파일마다 찾은 자리를 더해요.
  for (const [, day] of [...idByDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const counted = identityOfDay(day);
    if (day.idOn) {
      report.identity.findings.push(...counted);
      continue;
    }
    for (const f of counted) {
      if (f.kind === USER_NAME_LABEL) report.identityOff!.userNames++;
      else if (f.kind === EMAIL_LABEL) report.identityOff!.emails++;
    }
  }

  for (const file of archives) {
    report.scanned.archives++;
    const rel = relPosix(cfg.dataDir, file);
    // 읽다 중간에 멈춘 보관본도 앞 줄에서 찾은 의심은 세지 않고 읽지 못함 1건만이에요(collectFile).
    await collectFile(report, rel, report.markers.archive, async (part) => {
      let lineNo = 0;
      for await (const { line } of readLines(file)) {
        lineNo++;
        countMarkers(line, part.markers);
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          part.findings.push({ file: rel, line: lineNo, kind: '읽을 수 없는 줄' });
          continue;
        }
        addFindings(part.findings, rel, lineNo, redactor.detectDeep(obj));
      }
    });
    prog.update(++done, total);
  }

  // 마크다운에 남은 의심이 있는데 화면용 데이터에는 그 자리가 가려져 있으면 한쪽만 가려진 일지예요(이전 판의 다시 가리기가 남긴 어긋남).
  // 다시 가리기로는 고쳐지지 않아서, 그 날짜와 그 날짜 일지를 다시 만드는 명령을 다음: 줄로 알려요(PRD S4·A16, F2-23).
  for (const [date, md] of [...mdByDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (md.found === 0) continue;
    try {
      const day = parseJsonText(readFileSync(join(paths.worklogsDir, `${date}.json`), 'utf8')) as DayLog;
      // 그 일지를 만든 설정(이름·이메일 가리기, 하루 경계)도 담아 다시 만드는 명령에 넘겨요(PRD S4·A16, Q22, 취합 13회차 차이 1).
      if (day && day.schema === 1 && Array.isArray(day.projects) && maskedOnlyInData(day, md.markers)) report.mismatched!.push(remakeDayOf(date, day));
    } catch {
      /* 화면용 데이터가 없거나 깨졌으면 알 수 없어요 */
    }
  }
  // 보관 색인도 훑어요 (경로·시각만 있어야 해요).
  // 색인이 없으면 건너뛰어요. 있는데 읽지 못하거나(다른 프로그램이 잡고 있음, 권한 없음) 깨졌으면 말없이 넘기지 않고 위치를 알려요.
  // 읽지 못했으면 "읽지 못함"과 원인 코드, 내용이 깨졌으면 전처럼 "읽을 수 없는 보관 색인" 모양이에요.
  const indexRel = relPosix(cfg.dataDir, paths.indexFile);
  await collectFile(report, indexRel, {}, (part) => {
    let text: string;
    try {
      text = readFileSync(paths.indexFile, 'utf8');
    } catch (err) {
      const code = errorCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw err;
    }
    let idx: unknown;
    try {
      idx = parseJsonText(text);
    } catch {
      part.findings.push({ file: indexRel, line: 0, kind: '읽을 수 없는 보관 색인' });
      return;
    }
    addFindings(part.findings, indexRel, 0, redactor.detectDeep(idx));
  });

  // 이름·이메일 옵션이 켜진 일지에 사용자 이름·이메일이 남은 날짜마다, 그 일지를 다시 만드는 명령에 넣을 설정을 담아요.
  // 한쪽만 가려진 일지와 같은 규칙의 명령이고(그 일지의 하루 경계, 이번 실행에 준 폴더), 이름·이메일을 가리려고 다시 만드는 것이라
  // --hide-identity는 늘 붙여요(PRD S4·A10·A16, 취합 15회차 차이 1). 화면용 일지 데이터가 없거나 깨졌으면 기본 하루 경계(3)로 봐요.
  const idDates = new Set<string>();
  for (const f of report.identity.findings) {
    const m = DATE_OF_FILE.exec(f.file);
    if (m) idDates.add(m[1]!);
  }
  report.identityDays = [...idDates].sort().map((date) => ({ ...remakeDayOf(date, settingsOf(date) ?? {}), hideIdentity: true }));
  prog.done();
  // 훑는 동안 다른 실행(다시 가리기)이 파일을 바꾸기 시작했을 수도 있어서 끝날 때 한 번 더 봐요. 둘 중 하나라도 걸리면 알려요.
  const atEnd = pendingNotice(cfg.dataDir);
  if (atEnd === 'broken' || !report.journal) report.journal = atEnd;

  for (const f of report.identity.findings) {
    if (f.kind === USER_NAME_LABEL) report.identity.userNames++;
    else if (f.kind === EMAIL_LABEL) report.identity.emails++;
  }

  const idLeft = report.identity.counted ? report.identity.userNames + report.identity.emails : 0;
  report.passed =
    builtin.every((b) => b.caught) &&
    negatives.every((n) => n.intact) &&
    user.every((u) => u.caught === u.samples) &&
    report.findings.length === 0 &&
    idLeft === 0;
  return report;
}

export async function runCheck(cfg: Config): Promise<number> {
  const report = await buildCheckReport(cfg);
  process.stdout.write(renderCheckReport(report));
  return report.passed ? 0 : 1;
}
