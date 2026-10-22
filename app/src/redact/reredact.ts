// 보관본 다시 가리기 (F2, A16).
// 보관은 늘어난 부분만 더해서, 나중에 더한 사용자 패턴이나 바뀐 내장 규칙이 이미 보관한 줄에는 닿지 않아요.
// 그래서 지금 규칙(내장 규칙 + 사용자 패턴)으로 보관본과 이미 만든 일지(마크다운·화면용 일지 데이터)를 다시 가려요.
// 원본 세션 기록은 열지 않아요(원본이 남았는지 확인하려고 있는지만 봐요). 그래서 원본이 지워진 보관본에도 동작해요.
//
// 두 단계로 나눠요.
//  1. 계획(buildRedactPlan): 읽기만 해요. 파일마다 바뀔 자리 수를 종류별로 세요. 데이터 폴더에 아무것도 쓰지 않아요.
//  2. 다시 쓰기(commitPlan): 확인을 받은 뒤에만 불러요. journal.ts의 순서로 새 내용을 옆 파일에 쓴 뒤 한꺼번에 바꿔요.
//     보관본은 계획 때와 같은 방법으로 다시 계산하고, 계획 때 센 수·크기와 하나라도 다르면 아무것도 바꾸지 않고 멈춰요.
//
// 가림 표시만 늘려요. 줄 수, 커밋·세션 항목, 하루 경계, 이름·이메일 옵션 같은 나머지 내용은 그대로예요.
// 일지 마크다운은 다시 만들지 않고, 화면용 일지 데이터에서 바뀐 글이 마크다운에 찍힌 조각만 새 글로 바꿔요(시간대·손으로 고친 줄을 건드리지 않게).
import { closeSync, fsyncSync, openSync, readdirSync, readFileSync, readSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { emptyIndex, IndexError, loadIndex, type ArchiveIndex } from '../archive/archive.js';
import { dataPaths, type Config } from '../config.js';
import { errorCode, isAccessError, probeWritable, relPosix, renameStrict, walkFiles, writeFileDurable } from '../util/fs.js';
import { parseJsonText } from '../util/json.js';
import { readRawLines } from '../util/lines.js';
import { mdCode, mdEscape, mdUnescape } from '../util/text.js';
import { isHandEdited, markdownHashOf, storedMarkdownHash } from '../worklog/edited.js';
import { redactionLine, renderProjects } from '../worklog/markdown.js';
import { maskedOnlyInData, remakeContext, remakeDayOf, type RemakeContext, type RemakeDay } from '../worklog/mismatch.js';
import type { DayLog } from '../worklog/types.js';
import { EMAIL_LABEL, USER_NAME_LABEL } from './identity.js';
import { markBroken, RecoveryError, removeJournal, removeStaged, STAGED_SUFFIX, writeJournal } from './journal.js';
import { countMarkers } from './marker.js';
import { mergeCounts, totalCount, type Counts, type Redactor } from './redact.js';

export type FileKind = 'archive' | 'worklog-md' | 'worklog-json';

export interface FilePlan {
  kind: FileKind;
  /** 절대 경로 */
  path: string;
  /** 데이터 폴더 기준 / 구분 상대 경로 */
  rel: string;
  /** 바뀔 자리 (종류별) */
  counts: Counts;
  total: number;
  /** 계획 때 파일 크기·수정 시각 (다시 쓰기 전에 그대로인지 봐요) */
  size: number;
  mtimeMs: number;
  /** 보관본: 원본 세션 파일이 지금 남아 있는지 (없으면 되돌릴 수 없어요) */
  originalExists?: boolean;
  /** 보관본: 보관 색인 열쇠(archive/projects 기준 경로). 색인에 없으면 null */
  indexKey?: string | null;
  /** 보관본: 색인에 적힌 보관본 크기(바뀌기 전). 색인에 없으면 null */
  boundary?: number | null;
  /** 보관본: 다시 쓴 뒤 크기, 색인의 보관본 크기에 더할 값 */
  newSize?: number;
  boundaryDelta?: number;
  /** 일지: 새 내용 (계획 때 만든 그대로 써요) */
  content?: string;
}

/**
 * 다시 가리기가 읽거나 쓰지 못한 보관본·일지 파일 (다른 프로그램이 잡고 있음, 권한 없음 등, F2-23).
 * rel은 데이터 폴더 기준 / 구분 상대 경로, code는 오류 코드(EBUSY·EPERM·EACCES 등)예요. 파일 내용은 담지 않아요.
 */
export interface AccessProblem {
  rel: string;
  code: string;
  op: 'read' | 'write';
}

/** 다시 가리기가 읽거나 쓰지 못한 파일이 있어 멈췄어요. 그 자리에서 되돌려서 바뀐 파일은 없어요(F2-23, PRD 5장). */
export class FileAccessError extends Error {
  constructor(readonly problems: AccessProblem[]) {
    super(`읽거나 쓰지 못한 파일 ${problems.length}개`);
  }
}

/**
 * 일지 마크다운과 화면용 일지 데이터 중 한쪽(화면용 데이터)만 가려진 날짜와, 그 날짜 마크다운에 남은 의심 수 (A16, F2-23).
 * 그 일지를 만든 설정(이름·이메일 가리기, 하루 경계)도 함께 담아 다시 만드는 명령에 넘겨요(PRD S3·A16, Q22, 취합 13회차 차이 1).
 */
export interface MismatchedDay extends RemakeDay {
  suspects: number;
}

export interface RedactPlan {
  dataDir: string;
  builtinRules: number;
  userPatterns: string[];
  scanned: { archives: number; worklogDays: number };
  /** 바뀌는 파일만. 보관본(경로순) → 일지(경로순) */
  files: FilePlan[];
  totals: Counts;
  /** 다시 가리기로 고칠 수 없는 남은 의심 (읽을 수 없는 줄, 손으로 고친 일지 줄 등). 검사(S4)가 계속 보여 줘요. */
  unfixable: number;
  /**
   * unfixable 가운데 마크다운과 화면용 데이터 중 한쪽만 가려진 일지에 걸린 것 (날짜별). 이전 판에서 생긴 어긋남이라
   * 다시 가리기로는 고쳐지지 않고, 그 날짜 일지를 다시 만들면(cc-worklog --date 날짜) 고쳐져요(A16, F2-23).
   */
  mismatched: MismatchedDay[];
  /** 다시 만드는 명령을 정할 때 보는 이번 실행의 설정 (지금 하루 경계, 이번 실행에 준 --data-dir·--claude-dir) */
  remake: RemakeContext;
  /**
   * 바뀔 자리를 세면서 읽지 못한 파일과, 바뀔 파일 중 쓸 수 없는 파일. 하나라도 있으면 확인을 묻지 않고 멈춰요(아무 파일도 바꾸지 않아요).
   * 읽지 못한 파일은 바뀔 자리를 셀 수 없어서 "보여 준 수 = 바꾼 수"를 지킬 수 없고, 일부만 다시 쓰면 일부만 바뀐 채 남기 때문이에요(F2-23, 5장).
   */
  inaccessible: AccessProblem[];
  /** 보관 색인에서 바뀔 보관본 크기만 고친 새 내용 */
  index: { path: string; rel: string; content: string; size: number; mtimeMs: number } | null;
}

export class PlanChangedError extends Error {}
export class InterruptedError extends Error {}

// ---- 보관본 ----

interface ArchiveTransform {
  counts: Counts;
  newSize: number;
  boundaryDelta: number;
  unparsable: number;
}

class FileWriter {
  private fd: number;
  private parts: Buffer[] = [];
  private bytes = 0;
  constructor(path: string) {
    this.fd = openSync(path, 'w');
  }
  write(b: Buffer): void {
    this.parts.push(b);
    this.bytes += b.length;
    if (this.bytes >= 1 << 20) this.flush();
  }
  flush(): void {
    if (this.parts.length === 0) return;
    const buf = Buffer.concat(this.parts);
    let off = 0;
    while (off < buf.length) off += writeSync(this.fd, buf, off, buf.length - off);
    this.parts = [];
    this.bytes = 0;
  }
  close(): void {
    try {
      this.flush();
      fsyncSync(this.fd);
    } finally {
      closeSync(this.fd);
    }
  }
  abort(): void {
    try {
      closeSync(this.fd);
    } catch {
      /* 이미 닫혔어요 */
    }
  }
}

const NL = Buffer.from('\n');

/**
 * 보관본 한 파일을 줄마다 다시 가려요. writer가 있으면 새 내용을 써요(없으면 세기만 해요).
 * 바뀌지 않는 줄은 바이트 그대로 두고, 끝에 \n 없이 남은 부분(보관이 쓰다 멈춘 자리)도 그대로 둬요.
 * boundary(색인의 보관본 크기) 안쪽 줄의 크기 변화만 따로 세서 색인을 맞춰요. 그래야 다음 보관이 이어 붙일 자리가 그대로예요.
 */
async function transformArchive(
  path: string,
  size: number,
  redactor: Redactor,
  boundary: number | null,
  writer?: FileWriter,
  stop?: { requested: boolean },
): Promise<ArchiveTransform> {
  const counts: Counts = {};
  let delta = 0;
  let boundaryDelta = 0;
  let lastEnd = 0;
  let unparsable = 0;
  for await (const { raw, start, end } of readRawLines(path)) {
    if (end > size) break; // 계획 뒤에 늘어난 부분은 다루지 않아요(크기가 달라 어차피 멈춰요).
    lastEnd = end;
    if (stop?.requested) throw new InterruptedError('멈춤');
    let out: Buffer = raw;
    let obj: unknown;
    let parsed = true;
    try {
      obj = JSON.parse(raw.toString('utf8'));
    } catch {
      parsed = false;
    }
    if (!parsed) unparsable++;
    else {
      // 검사 명령(check.ts)과 같은 방법으로 줄 전체 값을 다시 가려요.
      const c: Counts = {};
      const next = redactor.redactDeep(obj, c);
      if (totalCount(c) > 0) {
        out = Buffer.from(JSON.stringify(next), 'utf8');
        mergeCounts(counts, c);
      }
    }
    const d = out.length + 1 - (end - start);
    delta += d;
    if (boundary !== null && end <= boundary) boundaryDelta += d;
    if (writer) {
      writer.write(out);
      writer.write(NL);
    }
  }
  if (writer && lastEnd < size) {
    // \n 없이 끝난 부분은 바이트 그대로 옮겨요.
    const fd = openSync(path, 'r');
    try {
      const tail = Buffer.alloc(size - lastEnd);
      let got = 0;
      while (got < tail.length) {
        const r = readSync(fd, tail, got, tail.length - got, lastEnd + got);
        if (r === 0) break;
        got += r;
      }
      writer.write(tail.subarray(0, got));
    } finally {
      closeSync(fd);
    }
  }
  return { counts, newSize: size + delta, boundaryDelta, unparsable };
}

// ---- 일지 ----

type Pair = [string, string];

/** 일지 데이터에서 세션 기록·커밋에서 온 글 칸만 다시 가려요. 날짜·시각·해시·아이디 같은 칸은 건드리지 않아요. */
function redactDayContent(day: DayLog, redactor: Redactor): { day: DayLog; counts: Counts; pairs: Pair[] } {
  const counts: Counts = {};
  const pairs: Pair[] = [];
  const next = structuredClone(day);
  const text = <T>(s: T, render: (x: string) => string): T => {
    if (typeof s !== 'string' || !s) return s;
    const t = redactor.redactString(s, counts);
    if (t !== s) pairs.push([render(s), render(t)]);
    return t as T;
  };
  for (const p of Array.isArray(next.projects) ? next.projects : []) {
    if (!p || typeof p !== 'object') continue;
    if (!p.noRepo) p.name = text(p.name, mdEscape);
    p.path = text(p.path, mdCode);
    for (const s of Array.isArray(p.sessions) ? p.sessions : []) {
      if (!s || typeof s !== 'object') continue;
      s.title = text(s.title, mdEscape);
      s.firstRequest = text(s.firstRequest, mdEscape);
      s.lastRequest = text(s.lastRequest, mdEscape);
      if (Array.isArray(s.branches)) s.branches = s.branches.map((b) => text(b, mdCode));
      s.cwd = text(s.cwd, mdCode);
    }
    for (const c of Array.isArray(p.commits) ? p.commits : []) {
      if (!c || typeof c !== 'object') continue;
      c.branch = text(c.branch, mdCode);
      c.subject = text(c.subject, mdEscape);
    }
  }
  return { day: next, counts, pairs };
}

/** 마크다운에서 옛 조각을 새 조각으로 바꿔요. 긴 조각부터 바꿔요. */
function applyPairs(md: string, pairs: Pair[]): string {
  const uniq = new Map<string, string>();
  for (const [a, b] of pairs) if (a !== b && !uniq.has(a)) uniq.set(a, b);
  let out = md;
  for (const [a, b] of [...uniq.entries()].sort((x, y) => y[0].length - x[0].length)) out = out.split(a).join(b);
  return out;
}

function replaceLineOnce(text: string, oldLine: string, newLine: string): string {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.replace(/\r$/, '') === oldLine);
  if (i === -1) return text;
  lines[i] = lines[i]!.endsWith('\r') ? `${newLine}\r` : newLine;
  return lines.join('\n');
}

function markerGain(before: Counts, after: Counts): Counts {
  const out: Counts = {};
  for (const [k, v] of Object.entries(after)) {
    const d = v - (before[k] ?? 0);
    if (d > 0) out[k] = d;
  }
  return out;
}

/** 일지 머리의 가린 자리 수를 build.ts와 같은 방법(마크다운 본문의 가림 표시)으로 다시 세요. */
function recountRedactions(day: DayLog): void {
  try {
    const red: Counts = {};
    for (const [k, v] of Object.entries(countMarkers(renderProjects(day)))) {
      if (k !== USER_NAME_LABEL && k !== EMAIL_LABEL) red[k] = v;
    }
    day.redactions = red;
  } catch {
    /* 모양이 다른 옛 일지면 수는 그대로 둬요 */
  }
}

/** 글 파일을 읽어요. 없으면 text·code 모두 null, 읽지 못하면(다른 프로그램이 잡고 있음, 권한 없음 등) code에 오류 코드예요. */
function readTextFile(path: string): { text: string | null; code: string | null } {
  try {
    return { text: readFileSync(path, 'utf8'), code: null };
  } catch (err) {
    const code = errorCode(err);
    return { text: null, code: code === 'ENOENT' ? null : code };
  }
}

function statOf(path: string): { size: number; mtimeMs: number } {
  const st = statSync(path);
  return { size: st.size, mtimeMs: st.mtimeMs };
}

function detectMarkdown(md: string, redactor: Redactor): number {
  let n = 0;
  for (const line of md.split('\n')) n += totalCount(redactor.detect(mdUnescape(line.replace(/\r$/, ''))));
  return n;
}

interface WorklogPlanResult {
  files: FilePlan[];
  days: number;
  unfixable: number;
  mismatched: MismatchedDay[];
}

function planWorklogs(dataDir: string, redactor: Redactor, problems: AccessProblem[]): WorklogPlanResult {
  const dir = dataPaths(dataDir).worklogsDir;
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.(md|json)$/.test(n));
  } catch (err) {
    // 일지 폴더가 아직 없으면 다시 가릴 일지가 없어요. 그 밖에 폴더를 읽지 못하면 말없이 넘기지 않고 알려요(F2-23).
    const code = errorCode(err);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') problems.push({ rel: relPosix(dataDir, dir), code, op: 'read' });
    names = [];
  }
  const dates = [...new Set(names.map((n) => n.slice(0, 10)))].sort();
  const files: FilePlan[] = [];
  const mismatched: MismatchedDay[] = [];
  let unfixable = 0;

  for (const date of dates) {
    const mdPath = join(dir, `${date}.md`);
    const jsonPath = join(dir, `${date}.json`);
    const md = names.includes(`${date}.md`) ? readTextFile(mdPath) : { text: null, code: null };
    const js = names.includes(`${date}.json`) ? readTextFile(jsonPath) : { text: null, code: null };
    // 같은 날짜의 마크다운과 화면용 데이터는 함께 바뀌거나 함께 그대로여야 해요. 한쪽이라도 읽지 못하면 그 날짜는 세지 않고
    // 읽지 못한 파일을 알려요. 예전에는 읽지 못한 파일을 말없이 빼고 나머지 한쪽만 다시 써서 둘이 달라졌어요(F2-23).
    if (md.code !== null || js.code !== null) {
      if (md.code !== null) problems.push({ rel: relPosix(dataDir, mdPath), code: md.code, op: 'read' });
      if (js.code !== null) problems.push({ rel: relPosix(dataDir, jsonPath), code: js.code, op: 'read' });
      continue;
    }
    const mdText = md.text;
    const jsonText = js.text;

    let oldDay: DayLog | null = null;
    if (jsonText !== null) {
      try {
        const d = parseJsonText(jsonText) as DayLog;
        if (d && d.schema === 1 && Array.isArray(d.projects)) oldDay = d;
      } catch {
        oldDay = null;
      }
      if (!oldDay) unfixable++; // 검사도 "읽을 수 없는 일지 파일"로 세요
    }

    const dayFiles: FilePlan[] = [];
    let newDay: DayLog | null = null;
    let jsonCounts: Counts = {};
    let pairs: Pair[] = [];
    if (oldDay) {
      const r = redactDayContent(oldDay, redactor);
      pairs = r.pairs;
      if (totalCount(r.counts) > 0) {
        newDay = r.day;
        jsonCounts = r.counts;
        recountRedactions(newDay);
      }
      unfixable += totalCount(redactor.detectDeep(newDay ?? oldDay));
    }

    let mdPlan: FilePlan | null = null;
    if (mdText !== null) {
      let newMd = mdText;
      if (newDay && oldDay && pairs.length > 0) {
        newMd = applyPairs(mdText, pairs);
        try {
          const before = redactionLine(oldDay);
          const after = redactionLine(newDay);
          if (before !== after) newMd = replaceLineOnce(newMd, before, after);
        } catch {
          /* 가린 자리 수 칸이 없는 옛 모양이면 머리 줄은 그대로 둬요 */
        }
      }
      const gain = markerGain(countMarkers(mdText), countMarkers(newMd));
      if (newMd !== mdText && totalCount(gain) > 0) {
        const st = statOf(mdPath);
        mdPlan = { kind: 'worklog-md', path: mdPath, rel: relPosix(dataDir, mdPath), counts: gain, total: totalCount(gain), ...st, content: newMd };
        // 손으로 고친 일지인지 알아보는 해시(PRD A21, 5장): 도구가 마지막으로 쓴 마크다운 그대로였으면(손대지 않음) 새 마크다운의 해시로 바꿔
        // 다시 가리기 뒤에도 손대지 않은 일지로 남게 해요. 손으로 고친 일지면 해시를 그대로 둬서 다시 가리기 뒤에도 손으로 고친 일지로 남아요
        // (다음 일지 만들기가 메모를 덮어쓰지 않게). 해시가 없는 옛 일지는 그대로 없어요(고치지 않은 것으로 봐요).
        if (newDay && storedMarkdownHash(oldDay) !== null && !isHandEdited(mdText, oldDay)) newDay.markdownHash = markdownHashOf(newMd);
      }
      const left = detectMarkdown(newMd, redactor);
      unfixable += left;
      // 화면용 데이터만 가려진 채 남은 일지(이전 판에서 생긴 어긋남)의 마크다운 의심은 다시 가리기로 고쳐지지 않아요.
      // 날짜를 모아 S3 [알림]에서 그 날짜 일지를 다시 만들라고 안내해요(A16).
      const dayNow = newDay ?? oldDay;
      if (left > 0 && dayNow && maskedOnlyInData(dayNow, countMarkers(newMd))) mismatched.push({ ...remakeDayOf(date, dayNow), suspects: left });
    }
    if (newDay) {
      const st = statOf(jsonPath);
      dayFiles.push({
        kind: 'worklog-json',
        path: jsonPath,
        rel: relPosix(dataDir, jsonPath),
        counts: jsonCounts,
        total: totalCount(jsonCounts),
        ...st,
        content: `${JSON.stringify(newDay, null, 1)}\n`,
      });
    }
    if (mdPlan) dayFiles.push(mdPlan);

    // 바뀔 파일은 지금 쓸 수 있는지 미리 열어 봐요(아무것도 쓰지 않아요). 다른 프로그램이 잡고 있거나 읽기 전용이면
    // 확인을 묻기 전에 알리고 멈춰요. 그래야 확인한 뒤 한쪽만 바뀌는 일이 없어요(F2-23).
    for (const f of dayFiles) {
      const code = probeWritable(f.path);
      if (code) problems.push({ rel: f.rel, code, op: 'write' });
    }
    files.push(...dayFiles);
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, days: dates.length, unfixable, mismatched };
}

// ---- 계획 ----

export interface PlanOptions {
  onProgress?: (done: number, total: number) => void;
}

/** 파일 시스템 오류(오류 코드가 있는 오류)인지. 그 밖의 오류(코드 실수 등)는 그대로 던져요. */
const isFsError = (err: unknown) => /^E[A-Z]+$/.test(String((err as NodeJS.ErrnoException)?.code ?? ''));

/**
 * 바뀔 자리를 세요. 데이터 폴더의 어떤 파일도 바꾸거나 만들지 않아요(임시 파일 포함).
 * 읽지 못한 파일과 바뀔 파일 중 쓸 수 없는 파일은 plan.inaccessible에 모아요(말없이 건너뛰지 않아요, F2-23).
 */
export async function buildRedactPlan(cfg: Config, redactor: Redactor, opts: PlanOptions = {}): Promise<RedactPlan> {
  const paths = dataPaths(cfg.dataDir);
  const problems: AccessProblem[] = [];
  const relData = (p: string) => relPosix(cfg.dataDir, p);
  let index: ArchiveIndex;
  try {
    index = loadIndex(cfg.dataDir, cfg.cleanupPeriodDays);
  } catch (err) {
    // 색인 파일을 열지 못했어요(다른 프로그램이 잡고 있음 등). 내용이 깨진 경우(code 없음)는 전처럼 [실패]로 멈춰요.
    if (!(err instanceof IndexError) || !err.code) throw err;
    problems.push({ rel: relData(paths.indexFile), code: err.code, op: 'read' });
    index = emptyIndex(cfg.cleanupPeriodDays);
  }
  const archives = walkFiles(
    paths.archiveProjectsDir,
    (n) => n.toLowerCase().endsWith('.jsonl'),
    (dir, code) => problems.push({ rel: relData(dir), code, op: 'read' }),
  );
  const files: FilePlan[] = [];
  const totals: Counts = {};
  let unfixable = 0;
  let done = 0;

  for (const path of archives) {
    const key = relPosix(paths.archiveProjectsDir, path);
    const entry = index.files[key];
    let st: { size: number; mtimeMs: number };
    let t: ArchiveTransform;
    try {
      st = statOf(path);
      t = await transformArchive(path, st.size, redactor, entry ? entry.archiveBytes : null);
    } catch (err) {
      // 다른 프로그램이 잡고 있거나 권한이 없어 읽지 못했어요. 바뀔 자리를 셀 수 없으니 말없이 건너뛰지 않고 알려요(F2-23).
      if (!isFsError(err)) throw err;
      problems.push({ rel: relData(path), code: errorCode(err), op: 'read' });
      opts.onProgress?.(++done, archives.length);
      continue;
    }
    unfixable += t.unparsable;
    const total = totalCount(t.counts);
    if (total > 0) {
      const w = probeWritable(path);
      if (w) problems.push({ rel: relData(path), code: w, op: 'write' });
      let originalExists = false;
      try {
        originalExists = statSync(join(cfg.projectsDir, ...key.split('/'))).isFile();
      } catch {
        originalExists = false;
      }
      files.push({
        kind: 'archive',
        path,
        rel: relData(path),
        counts: t.counts,
        total,
        ...st,
        originalExists,
        indexKey: entry ? key : null,
        boundary: entry ? entry.archiveBytes : null,
        newSize: t.newSize,
        boundaryDelta: t.boundaryDelta,
      });
    }
    opts.onProgress?.(++done, archives.length);
  }

  // 보관 색인: 바뀌는 보관본의 크기만 고쳐요(다음 보관이 이어 붙일 자리를 맞추려고).
  let indexPlan: RedactPlan['index'] = null;
  const indexed = files.filter((f) => f.indexKey);
  if (indexed.length > 0) {
    for (const f of indexed) {
      const e = index.files[f.indexKey!]!;
      e.archiveBytes += f.boundaryDelta ?? 0;
    }
    indexPlan = {
      path: paths.indexFile,
      rel: relData(paths.indexFile),
      content: `${JSON.stringify(index, null, 1)}\n`,
      ...statOf(paths.indexFile),
    };
    const code = probeWritable(paths.indexFile);
    if (code) problems.push({ rel: indexPlan.rel, code, op: 'write' });
  }

  const w = planWorklogs(cfg.dataDir, redactor, problems);
  files.push(...w.files);
  unfixable += w.unfixable;
  for (const f of files) mergeCounts(totals, f.counts);

  return {
    dataDir: cfg.dataDir,
    builtinRules: redactor.builtin.length + 1, // 형식 규칙 + 이름=값 규칙
    userPatterns: redactor.user.map((r) => r.label),
    scanned: { archives: archives.length, worklogDays: w.days },
    files,
    totals,
    unfixable,
    mismatched: w.mismatched,
    remake: remakeContext(cfg),
    inaccessible: problems,
    index: indexPlan,
  };
}

// ---- 다시 쓰기 ----

export interface CommitHooks {
  /** 새 내용 파일을 n개 쓴 뒤 (시험에서 중간에 멈춘 경우를 흉내 낼 때 써요) */
  afterStage?: (n: number) => void;
  /** 원래 이름으로 n개 바꾼 뒤 */
  afterRename?: (n: number) => void;
}

export interface CommitResult {
  files: FilePlan[];
  totals: Counts;
}

function sameCounts(a: Counts, b: Counts): boolean {
  const ka = Object.keys(a).filter((k) => a[k]);
  const kb = Object.keys(b).filter((k) => b[k]);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

function assertUnchanged(path: string, size: number, mtimeMs: number): void {
  let st: { size: number; mtimeMs: number };
  try {
    st = statOf(path);
  } catch {
    throw new PlanChangedError('확인한 뒤 파일이 없어졌어요');
  }
  if (st.size !== size || st.mtimeMs !== mtimeMs) throw new PlanChangedError('확인한 뒤 파일이 바뀌었어요');
}

/** 바뀔 파일(보관본·일지·보관 색인)을 지금 읽기·쓰기로 열 수 있는지 봐요. 아무것도 쓰지 않아요. 열 수 없는 파일을 돌려줘요. */
function probeTargets(plan: RedactPlan): AccessProblem[] {
  const out: AccessProblem[] = [];
  for (const f of plan.files) {
    const code = probeWritable(f.path);
    if (code) out.push({ rel: f.rel, code, op: 'write' });
  }
  if (plan.index) {
    const code = probeWritable(plan.index.path);
    if (code) out.push({ rel: plan.index.rel, code, op: 'write' });
  }
  return out;
}

/**
 * 새 내용을 쓰다 난 오류가 그 파일을 읽거나 쓰지 못해서(다른 프로그램이 잡고 있음, 권한 없음)인지 보고, 그렇다면 파일 위치를 담은
 * FileAccessError로 바꿔요. 원래 파일을 지금 열 수 없으면 읽지 못한 것, 열 수 있으면 새 내용 파일을 쓰지 못한 것으로 봐요.
 * 디스크 가득 참(ENOSPC) 같은 다른 오류는 그대로 돌려줘요(DESIGN S3 확정 전 쓰기 오류).
 */
function accessErrorFor(f: FilePlan, err: unknown): unknown {
  if (!isAccessError(err)) return err;
  const src = probeWritable(f.path);
  return new FileAccessError([src ? { rel: f.rel, code: src, op: 'read' } : { rel: f.rel, code: errorCode(err), op: 'write' }]);
}

/**
 * 확인을 받은 뒤 계획대로 다시 써요. 계획 때 센 수와 실제로 바꾼 수가 다르면 아무것도 바꾸지 않고 PlanChangedError를 던져요.
 * 멈춤 신호(stop.requested)가 오면 새 내용 파일을 쓰는 동안에만 되돌리고 멈춰요. 이름 바꾸기를 시작한 뒤에는 끝까지 가요.
 * fromBroken: 깨진 다시 쓰기 기록에서 시작했어요. "준비 중" 기록에 그 사실을 적고(깨진 기록을 원자적으로 덮어써요),
 * 확정 전에 되돌리면 기록을 지우지 않고 "깨짐" 표시로 바꿔 남겨요. 지난번에 일부만 바뀌었을 수 있는 상태가 그대로라서예요(A16).
 * 읽거나 쓰지 못한 파일이 있으면(다른 프로그램이 잡고 있음 등) 확정 전에 모두 되돌리고 FileAccessError를 던져요(F2-23).
 * 바뀔 파일은 기록 파일을 쓰기 전과 확정 바로 전에 두 번 열어 봐서, 확인을 기다리거나 새 내용을 쓰는 동안 잡힌 파일도 확정 전에 알아봐요.
 * 그래서 확정 뒤 이름 바꾸기에서 실패하는 일(같은 날짜 일지 중 한쪽만 바뀐 채 다음 실행을 기다리는 일)이 드물어요.
 */
export async function commitPlan(
  plan: RedactPlan,
  redactor: Redactor,
  opts: { hooks?: CommitHooks; stop?: { requested: boolean }; fromBroken?: boolean } = {},
): Promise<CommitResult> {
  const dataDir = plan.dataDir;
  const stop = opts.stop ?? { requested: false };
  const targets = [...plan.files.map((f) => f.rel), ...(plan.index ? [plan.index.rel] : [])];
  const totals: Counts = {};

  // 확인을 기다리는 동안 다른 프로그램이 파일을 잡았으면 아무것도 쓰지 않고 멈춰요(기록 파일도 쓰지 않아요).
  // 깨진 기록에서 시작했으면 그 기록이 그대로 남아 알림도 이어져요(A16).
  const lockedBefore = probeTargets(plan);
  if (lockedBefore.length > 0) throw new FileAccessError(lockedBefore);

  writeJournal(dataDir, {
    schema: 1,
    state: 'preparing',
    createdAt: new Date().toISOString(),
    files: targets,
    ...(opts.fromBroken ? { fromBroken: true as const } : {}),
  });
  try {
    let n = 0;
    for (const f of plan.files) {
      if (stop.requested) throw new InterruptedError('멈춤');
      assertUnchanged(f.path, f.size, f.mtimeMs);
      const staged = `${f.path}${STAGED_SUFFIX}`;
      if (f.kind === 'archive') {
        let writer: FileWriter;
        let t: ArchiveTransform;
        try {
          writer = new FileWriter(staged);
        } catch (err) {
          throw accessErrorFor(f, err);
        }
        try {
          t = await transformArchive(f.path, f.size, redactor, f.boundary ?? null, writer, stop);
          writer.close();
        } catch (err) {
          writer.abort();
          throw accessErrorFor(f, err);
        }
        if (!sameCounts(t.counts, f.counts) || t.newSize !== f.newSize || t.boundaryDelta !== f.boundaryDelta) {
          throw new PlanChangedError('확인한 뒤 보관본 내용이 바뀌었어요');
        }
        assertUnchanged(f.path, f.size, f.mtimeMs);
      } else {
        try {
          writeFileDurable(staged, f.content!);
        } catch (err) {
          throw accessErrorFor(f, err);
        }
      }
      mergeCounts(totals, f.counts);
      opts.hooks?.afterStage?.(++n);
    }
    if (plan.index) {
      if (stop.requested) throw new InterruptedError('멈춤');
      assertUnchanged(plan.index.path, plan.index.size, plan.index.mtimeMs);
      writeFileDurable(`${plan.index.path}${STAGED_SUFFIX}`, plan.index.content);
      opts.hooks?.afterStage?.(++n);
    }
    // 확정 바로 전에 한 번 더 열어 봐요. 새 내용을 쓰는 동안 잡힌 파일이 있으면 확정하지 않고 되돌려요.
    const lockedNow = probeTargets(plan);
    if (lockedNow.length > 0) throw new FileAccessError(lockedNow);
  } catch (err) {
    removeStaged(dataDir, targets);
    // 깨진 기록에서 시작했으면 "깨짐" 표시를 다시 남겨요(쓰지 못하면 fromBroken "준비 중" 기록이 그대로 남아 같은 뜻이에요).
    if (opts.fromBroken) markBroken(dataDir);
    else removeJournal(dataDir);
    throw err;
  }

  // 여기부터는 되돌리지 않고 끝까지 가요. 멈추면 다음 실행이 기록 파일을 보고 마저 끝내요.
  writeJournal(dataDir, { schema: 1, state: 'committed', createdAt: new Date().toISOString(), files: targets });
  let n = 0;
  const all = [...plan.files.map((f) => f.path), ...(plan.index ? [plan.index.path] : [])];
  for (const target of all) {
    try {
      renameStrict(`${target}${STAGED_SUFFIX}`, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'Error';
      throw new RecoveryError(`다시 쓰기를 마저 끝내지 못했어요 (${relPosix(dataDir, target)}, ${code})`);
    }
    opts.hooks?.afterRename?.(++n);
  }
  removeJournal(dataDir);
  return { files: plan.files, totals };
}
