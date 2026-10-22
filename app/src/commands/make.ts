// 일지 만들기 명령: 보관(F3)을 먼저 하고, 보관본으로 일지(F1)를 만든 뒤 S3를 찍어요.
// 보관 명령도 여기 있어요. 둘 다 데이터 폴더를 쓰니 잠금을 잡고, 지난번에 멈춘 보관본 다시 가리기가 있으면 먼저 마무리해요.
//
// 만들 날짜 (A18, Q25 답):
//  - --date D: 그날 하나. 이미 있으면 다시 만들어요.
//  - --from F [--to T]: 기간 안에서 재료가 있는 날짜를 모두 (이미 있어도) 다시 만들어요.
//  - 날짜 옵션 없음(기본 실행): ① 재료는 있는데 일지 마크다운이 없는 날짜(오늘 포함)와 ② 그날이 끝나기 전에 만든 일지(오늘 일지는 늘)를
//    만들어요. 그날이 끝난 뒤 만든 일지와 만든 시각을 알 수 없는 일지는 그대로 둬요. 보관본의 가장 이른 세션 날짜부터 찾아요.
// 어느 방식이든 손으로 고친 일지 마크다운은 덮어쓰지 않고 .md·.json을 둘 다 그대로 둔 채 건너뛰어 S3 [알림]으로 알려요(A21).
// 보관은 실행마다 한 번이고, 보관본도 한 번만 훑어요(worklog/build.ts의 WorklogBuilder, PRD 5장).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runArchive } from '../archive/archive.js';
import type { MakeRequest } from '../args.js';
import { dataPaths, type Config } from '../config.js';
import { recoverPending } from '../redact/journal.js';
import { loadUserPatterns, mergeCounts, Redactor, type Counts } from '../redact/redact.js';
import { progress } from '../term/format.js';
import { renderRunSummary, type MadeDay } from '../term/s3-summary.js';
import { DataDirWriteError, errorCode, exists, probeWritable, writeFileAtomic, writingDataDir } from '../util/fs.js';
import { parseJsonText } from '../util/json.js';
import { acquireLock } from '../util/lock.js';
import { dayKeyOf, dayRange } from '../util/time.js';
import { WorklogBuilder, type DateSpan } from '../worklog/build.js';
import { isHandEditedFile, markdownHashOf } from '../worklog/edited.js';
import { renderMarkdown } from '../worklog/markdown.js';
import { remakeContext, rerunHideCommand } from '../worklog/mismatch.js';
import type { DayLog } from '../worklog/types.js';

export const VIEW_COMMAND = 'cc-worklog view';

export function worklogFiles(dataDir: string, date: string) {
  const dir = dataPaths(dataDir).worklogsDir;
  return { md: join(dir, `${date}.md`), json: join(dir, `${date}.json`) };
}

export interface MakeOptions {
  /** 시험용: 지금 시각 */
  now?: number;
}

export async function runMake(cfg: Config, req: MakeRequest, opts: MakeOptions = {}): Promise<number> {
  const release = acquireLock(cfg.dataDir, 'make');
  try {
    return await make(cfg, req, opts);
  } finally {
    release();
  }
}

/** 이미 있는 일지 (마크다운이 있는지, 화면용 일지 데이터) */
interface Existing {
  mdExists: boolean;
  day: Partial<DayLog> | null;
}

function readExisting(dataDir: string, date: string): Existing {
  const files = worklogFiles(dataDir, date);
  let day: Partial<DayLog> | null = null;
  try {
    const d = parseJsonText(readFileSync(files.json, 'utf8'));
    if (d && typeof d === 'object' && !Array.isArray(d)) day = d as Partial<DayLog>;
  } catch {
    /* 없거나 깨졌으면 알 수 없어요 */
  }
  return { mdExists: exists(files.md), day };
}

/** 일지 폴더에 마크다운이 있는 날짜 (폴더가 없거나 읽지 못하면 없음) */
function existingMdDates(dataDir: string): string[] {
  try {
    return readdirSync(dataPaths(dataDir).worklogsDir)
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
      .map((n) => n.slice(0, 10));
  } catch {
    return [];
  }
}

/**
 * 그날이 끝나기 전에 만든 일지인지 (A18 ②): 화면용 일지 데이터의 만든 시각이 그 일지의 하루 범위 끝보다 일러요.
 * 화면용 일지 데이터가 없거나 읽을 수 없거나 만든 시각이 없으면 알 수 없어서 false예요(기본 실행은 그대로 둬요).
 */
function madeBeforeDayEnded(ex: Existing, date: string, cfg: Config): boolean {
  if (!ex.day) return false;
  const made = typeof ex.day.generatedAt === 'string' ? Date.parse(ex.day.generatedAt) : Number.NaN;
  if (Number.isNaN(made)) return false;
  let end = typeof ex.day.range?.end === 'string' ? Date.parse(ex.day.range.end) : Number.NaN;
  if (Number.isNaN(end)) {
    const h = ex.day.dayStartHour;
    end = dayRange(date, typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 23 ? h : cfg.dayStartHour).end;
  }
  return made < end;
}

async function make(cfg: Config, req: MakeRequest, opts: MakeOptions): Promise<number> {
  const recovered = recoverPending(cfg.dataDir);
  const redactor = new Redactor(loadUserPatterns(dataPaths(cfg.dataDir).patternsFile));
  const prog = progress('읽는 중');
  let archive;
  try {
    archive = await runArchive(cfg, redactor, { onProgress: prog.update });
  } finally {
    prog.done(); // [실패]로 멈출 때도 진행 표시 줄을 지운 뒤 오류를 찍어요
  }

  const today = dayKeyOf(opts.now ?? Date.now(), cfg.dayStartHour);
  const span: DateSpan =
    req.kind === 'date' ? { from: req.date, to: req.date } : req.kind === 'range' ? { from: req.from, to: req.to } : { from: null, to: today };
  const builder = await WorklogBuilder.open(cfg, redactor, span);

  // 만들 날짜 고르기
  const plans: Array<{ date: string; hideIdentity: boolean; existing: Existing }> = [];
  if (req.kind === 'date') {
    plans.push({ date: req.date, hideIdentity: cfg.hideIdentity, existing: readExisting(cfg.dataDir, req.date) });
  } else {
    for (const date of builder.materialDates()) {
      const existing = readExisting(cfg.dataDir, date);
      if (req.kind === 'range' || !existing.mdExists) {
        plans.push({ date, hideIdentity: cfg.hideIdentity, existing });
      } else if (madeBeforeDayEnded(existing, date, cfg)) {
        // 기본 실행이 다시 만드는 일지는 그 일지나 이번 실행 중 한쪽이라도 이름·이메일 가리기가 켜져 있으면 켜요(A18 설정, I-03).
        plans.push({ date, hideIdentity: cfg.hideIdentity || existing.day?.hideIdentity === true, existing });
      }
    }
  }
  // 기본 실행의 "그대로 둔 일지": 일지 폴더에 이미 있던 일지(마크다운) 중 대상 날짜가 아니라서 이번에 건드리지 않은 일지예요
  // (그날이 끝난 뒤 만든 일지, 만든 시각을 알 수 없는 일지, 가장 이른 세션 날짜보다 이른 날짜 등, DESIGN S3 가·나 "이 절의 말").
  const planned = new Set(plans.map((p) => p.date));
  const kept = req.kind === 'default' ? existingMdDates(cfg.dataDir).filter((d) => !planned.has(d)).length : 0;

  const made: MadeDay[] = [];
  const skippedEdited: string[] = [];
  const identityOff: string[] = [];
  const totals = {
    sessionIds: new Set<string>(),
    subagentFileKeys: new Set<string>(),
    commits: 0,
    redactions: {} as Counts,
    identity: {} as Counts,
    repoKeys: new Set<string>(),
  };
  const prog2 = progress('만드는 중', '날짜');
  try {
    let done = 0;
    for (const plan of plans) {
      prog2.update(++done, plans.length);
      const built = await builder.build(plan.date, { hideIdentity: plan.hideIdentity });
      // 재료가 없는 날짜는 만들지 않고, 이미 있던 일지도 지우거나 바꾸지 않아요.
      if (built.empty) continue;
      const files = worklogFiles(cfg.dataDir, plan.date);
      // 손으로 고친 일지 마크다운은 덮어쓰지 않고 .md·.json을 둘 다 그대로 둬요(A21). 마크다운을 읽지 못하면 쓰지도 못해서 [실패]예요.
      if (plan.existing.mdExists) {
        let edited: boolean;
        try {
          edited = isHandEditedFile(files.md, plan.existing.day);
        } catch (err) {
          throw new DataDirWriteError(cfg.dataDir, errorCode(err));
        }
        if (edited) {
          skippedEdited.push(plan.date);
          continue;
        }
      }
      // 같은 날짜의 마크다운과 화면용 데이터는 함께 바뀌어야 해요. 한쪽을 다른 프로그램이 잡고 있거나 읽기 전용이면
      // 둘 다 쓰기 전에 멈춰요. 한쪽만 새 내용으로 바뀐 채 남지 않게 하려는 거예요(F2-23, PRD 5장). 출력은 전과 같은 [실패]예요.
      for (const f of [files.md, files.json]) {
        const code = probeWritable(f);
        if (code) throw new DataDirWriteError(cfg.dataDir, code);
      }
      const md = renderMarkdown(built.day);
      const day: DayLog = { ...built.day, markdownHash: markdownHashOf(md) };
      // 일지 폴더에 쓰지 못하면 [실패] 데이터 폴더에 쓰지 못했어요 (DESIGN S3 오류). 이미 쓴 날짜는 그대로 둬요(A18).
      writingDataDir(cfg.dataDir, () => {
        writeFileAtomic(files.md, md);
        writeFileAtomic(files.json, `${JSON.stringify(day, null, 1)}\n`);
      });
      made.push({ date: plan.date, status: plan.existing.mdExists ? 'remade' : 'new', mdPath: files.md, hideIdentity: plan.hideIdentity });
      // --date·--from으로 이름·이메일 가리기가 켜져 있던 일지를 끈 채 다시 만들었으면 알려요(A21). 기본 실행은 이 경우가 생기지 않아요.
      if (req.kind !== 'default' && plan.existing.mdExists && plan.existing.day?.hideIdentity === true && !plan.hideIdentity) identityOff.push(plan.date);
      // 여러 날의 합계: 세션·서브 에이전트 기록·저장소는 겹치지 않게 세고(여러 날에 걸친 세션은 한 번), 커밋은 날짜가 하나라 더해요(DESIGN S3 가·나 3번).
      for (const p of built.day.projects) for (const s of p.sessions) totals.sessionIds.add(s.sessionId);
      for (const f of built.subagentFileKeys) totals.subagentFileKeys.add(f);
      totals.commits += built.day.totals.commits;
      mergeCounts(totals.redactions, built.day.redactions);
      mergeCounts(totals.identity, built.day.identity);
      for (const k of built.repoKeys) totals.repoKeys.add(k);
    }
  } finally {
    prog2.done();
  }

  const ctx = remakeContext(cfg);
  const dateArgs = req.kind === 'date' ? ['--date', req.date] : req.kind === 'range' ? ['--from', req.from, '--to', req.to] : [];
  const gitOk = builder.gitAvailable;
  process.stdout.write(
    renderRunSummary({
      mode: 'make',
      date: made.length === 1 ? made[0]!.date : req.kind === 'date' ? req.date : today,
      dayStartHour: cfg.dayStartHour,
      archive,
      day: {
        sessions: totals.sessionIds.size,
        subagentFiles: totals.subagentFileKeys.size,
        repos: totals.repoKeys.size,
        commits: totals.commits,
        redactions: totals.redactions,
        identity: totals.identity,
        gitAvailable: gitOk,
        mdPath: made.length === 1 ? made[0]!.mdPath : null,
      },
      make: {
        kind: req.kind,
        span: req.kind === 'range' ? { from: req.from, to: req.to } : null,
        made,
        kept,
        skippedEdited,
        identityOff,
        rerunHideCommand: identityOff.length > 0 ? rerunHideCommand(dateArgs, { ...ctx, cliRoots: cliRootsOf(cfg) }) : null,
        // A20: 이번 실행에 --root도 config.json의 roots도 없을 때만, git을 찾지 못했으면 빼요.
        noRootsHint: cfg.roots.length === 0 && gitOk,
        worklogsDir: dataPaths(cfg.dataDir).worklogsDir,
      },
      hideIdentity: cfg.hideIdentity,
      viewCommand: VIEW_COMMAND,
      projectsDir: cfg.projectsDir,
      recovered,
      rootIssues: builder.rootIssues,
      rootOrigins: cfg.rootOrigins,
      rootDepth: cfg.rootDepth,
    }),
  );
  return 0;
}

/** 이번 실행에 --root로 준 폴더 (절대 경로, config.json의 roots는 빼요. 둘 다에 있으면 --root예요) */
function cliRootsOf(cfg: Config): string[] {
  const origins = cfg.rootOrigins ?? {};
  return cfg.roots.filter((r) => origins[r] === 'cli');
}

export async function runArchiveOnly(cfg: Config): Promise<number> {
  const release = acquireLock(cfg.dataDir, 'archive');
  try {
    return await archiveOnly(cfg);
  } finally {
    release();
  }
}

async function archiveOnly(cfg: Config): Promise<number> {
  const recovered = recoverPending(cfg.dataDir);
  const redactor = new Redactor(loadUserPatterns(dataPaths(cfg.dataDir).patternsFile));
  const prog = progress('읽는 중');
  let archive;
  try {
    archive = await runArchive(cfg, redactor, { onProgress: prog.update });
  } finally {
    prog.done();
  }
  process.stdout.write(
    renderRunSummary({
      mode: 'archive',
      dayStartHour: cfg.dayStartHour,
      archive,
      hideIdentity: cfg.hideIdentity,
      viewCommand: VIEW_COMMAND,
      projectsDir: cfg.projectsDir,
      recovered,
    }),
  );
  return 0;
}
