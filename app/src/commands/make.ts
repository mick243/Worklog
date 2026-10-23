// 일지 만들기 명령: 보관(F3)을 먼저 하고, 보관본으로 일지(F1)를 만든 뒤 S3를 찍어요.
// 보관 명령도 여기 있어요. 둘 다 데이터 폴더를 쓰니 잠금을 잡고, 지난번에 멈춘 보관본 다시 가리기가 있으면 먼저 마무리해요.
//
// 만들 날짜 (A18, Q25 답):
//  - --date D: 그날 하나. 이미 있으면 다시 만들어요.
//  - --from F [--to T]: 기간 안에서 재료가 있는 날짜를 모두 (이미 있어도) 다시 만들어요.
//  - 날짜 옵션 없음(기본 실행): ① 재료는 있는데 일지 마크다운이 없는 날짜(오늘 포함)와 ② 그날이 끝나기 전에 만든 일지(오늘 일지는 늘)를
//    만들어요. 요약을 켠 실행이면 ③ 요약을 켜고 만든 일지 중 요약이 빈 요약 대상 세션이 남았고 그 세션을 이번 실행이 실제로 부르는(꺼낸)
//    일지도 다시 만들어요(A18 ③, A24). 그날이 끝난 뒤 만든 일지와 만든 시각을 알 수 없는 일지는 그대로 둬요. 보관본의 가장 이른 세션 날짜부터 찾아요.
// 어느 방식이든 손으로 고친 일지 마크다운은 덮어쓰지 않고 .md·.json을 둘 다 그대로 둔 채 건너뛰어 S3 [알림]으로 알려요(A21).
// 보관은 실행마다 한 번이고, 보관본도 한 번만 훑어요(worklog/build.ts의 WorklogBuilder, PRD 5장).
//
// AI 요약 한 줄 (A24~A28): 요약을 켠 일지 만들기(--summary 또는 config.json의 "summary": true)에서만 claude를 불러요.
// 요약을 끄면(기본) 어느 방식에서도 claude 실행이 0회이고 네트워크 요청이 0건이에요. 그래서 세 단계로 나눠요.
//  ㉮ 만들 날짜마다 일지를 만들어 두고(아직 쓰지 않아요) 손으로 고친 일지를 거른 뒤, 요약을 켠 일지의 세션마다 요약 저장 파일에서
//     그날 줄이 늘지 않은 세션의 요약을 다시 쓰고, 나머지 요약 대상 세션을 부를 후보로 모아요.
//  ㉯ 요약을 켠 실행이면 후보를 날짜가 늦은 것부터 꺼내 claude를 50번 실행할 때까지 불러요(동시에 2개, 한 번에 60초). 받는 대로 요약 저장 파일에 남겨요.
//     그다음 ③ 일지 중 이번에 꺼낸 세션이 없는 일지는 빼요(바뀔 것이 없어서예요).
//  ㉰ 요약 줄을 넣어 날짜마다 .md·.json을 써요(한쪽만 바뀌지 않게, 5장).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runArchive } from '../archive/archive.js';
import type { MakeRequest } from '../args.js';
import { dataPaths, type Config } from '../config.js';
import { recoverPending } from '../redact/journal.js';
import { loadUserPatterns, mergeCounts, Redactor, type Counts } from '../redact/redact.js';
import { makeWorkDir, removeWorkDir, StopSignal } from '../summary/claude.js';
import { candidateKey, emptyRun, keyOf, orderCandidates, runSummaryCalls, savedCount, tallyOutcomes, type CallOptions, type Candidate, type SummaryRun } from '../summary/run.js';
import { readSummaryFile, sameMark, sameRange, summaryFilePath } from '../summary/store.js';
import { painter, progress } from '../term/format.js';
import { renderRunSummary, renderSummaryInterrupted, SUMMARY_TEXT, type MadeDay, type StoreProblem, type SummaryRunInfo } from '../term/s3-summary.js';
import { DataDirWriteError, errorCode, exists, probeWritable, writeFileAtomic, writingDataDir } from '../util/fs.js';
import { parseJsonText } from '../util/json.js';
import { acquireLock } from '../util/lock.js';
import { dayKeyOf, dayRange } from '../util/time.js';
import { applySummaries, WorklogBuilder, type BuildResult, type DateSpan, type SummaryInput } from '../worklog/build.js';
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
  /** 시험용: 요약을 멈추는 신호 (Ctrl+C와 같아요). 없으면 새로 만들어 Ctrl+C(SIGINT)에 이어요. */
  stop?: StopSignal;
  /** 시험용: 재료 만들기를 감싸요 (보관본을 읽지 못한 세션을 흉내 낼 때, summary/run.ts의 CallOptions.material) */
  material?: CallOptions['material'];
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
      .map((n) => n.slice(0, 10))
      .sort();
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

/** 요약을 켜고 만든 일지에서 요약이 빈 요약 대상 세션 (화면용 일지 데이터에 남은 값, 원문 없음, A18 ③·A24) */
function emptySummarySessions(day: Partial<DayLog> | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!day || day.summaryEnabled !== true || !Array.isArray(day.projects)) return out;
  for (const p of day.projects) {
    for (const s of Array.isArray(p?.sessions) ? p.sessions : []) {
      if (s && typeof s.sessionId === 'string' && s.summaryTarget === true && !(typeof s.summary === 'string' && s.summary)) out.add(s.sessionId);
    }
  }
  return out;
}

/** 만들 날짜 하나 */
interface Plan {
  date: string;
  hideIdentity: boolean;
  /** 이 일지를 요약을 켠 일지로 만드는지 (A28: 이름·이메일 가리기와 같은 규칙) */
  summary: boolean;
  existing: Existing;
  /** A18 ③: 요약이 빈 세션을 이어서 채우려고 다시 만드는 요약 일지. 이번 실행이 꺼낸 세션이 없으면 쓰지 않고 그대로 둬요. */
  continuation: boolean;
}

/** ㉮에서 만들어 둔 일지 (아직 쓰지 않았어요) */
interface Prepared {
  plan: Plan;
  built: BuildResult;
  inputs: Map<string, SummaryInput>;
  /** 세션 → 요약 저장 파일에서 다시 쓰는 요약 (그날 줄이 늘지 않았어요, A27) */
  reused: Map<string, string>;
  /** 이번에 부를 후보 (요약을 켠 실행만) */
  candidates: Candidate[];
  /** 그 날짜 요약 저장 파일을 읽지 못했거나 깨졌으면 (S3 [알림], A27) */
  storeProblem?: StoreProblem;
}

async function make(cfg: Config, req: MakeRequest, opts: MakeOptions): Promise<number> {
  const recovered = recoverPending(cfg.dataDir);
  // 지난 실행이 남긴 요약 호출용 빈 작업 폴더가 있으면 지워요(PRD 5장 셋째 예외). 요약을 끈 실행도 지우기만 하고 claude는 부르지 않아요.
  removeWorkDir(cfg.dataDir);
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
  const plans: Plan[] = [];
  const plan = (date: string, hideIdentity: boolean, summary: boolean, existing: Existing, continuation = false) =>
    plans.push({ date, hideIdentity, summary, existing, continuation });
  if (req.kind === 'date') {
    plan(req.date, cfg.hideIdentity, cfg.summary, readExisting(cfg.dataDir, req.date));
  } else {
    for (const date of builder.materialDates()) {
      const existing = readExisting(cfg.dataDir, date);
      if (req.kind === 'range' || !existing.mdExists) {
        plan(date, cfg.hideIdentity, cfg.summary, existing);
      } else if (madeBeforeDayEnded(existing, date, cfg)) {
        // 기본 실행이 다시 만드는 일지는 그 일지나 이번 실행 중 한쪽이라도 이름·이메일 가리기가 켜져 있으면 켜요(A18 설정, I-03).
        // 요약도 같은 규칙이에요(A28). 요약을 끈 실행이면 claude를 부르지 않고 저장해 둔 요약만 써요.
        plan(date, cfg.hideIdentity || existing.day?.hideIdentity === true, cfg.summary || existing.day?.summaryEnabled === true, existing);
      } else if (cfg.summary && emptySummarySessions(existing.day).size > 0) {
        // A18 ③: 요약을 켜고 만든 일지에 요약이 빈 세션이 남았어요. 그날이 끝난 뒤 만든 일지여도 이어서 채우려고 후보에 넣어요.
        // 이번 실행이 그 세션을 꺼내지 않았으면 ㉯ 뒤에서 빼요(바뀔 것이 없어 다시 만들지 않아요).
        plan(date, cfg.hideIdentity || existing.day?.hideIdentity === true, true, existing, true);
      }
    }
  }

  const skippedEdited: string[] = [];
  const prepared: Prepared[] = [];
  const prog2 = progress('만드는 중', '날짜');
  try {
    // ㉮ 일지를 만들어 두고 요약 후보 모으기
    let done = 0;
    for (const p of plans) {
      prog2.update(++done, plans.length);
      const built = await builder.build(p.date, { hideIdentity: p.hideIdentity });
      // 재료가 없는 날짜는 만들지 않고, 이미 있던 일지도 지우거나 바꾸지 않아요.
      if (built.empty) continue;
      const files = worklogFiles(cfg.dataDir, p.date);
      // 손으로 고친 일지 마크다운은 덮어쓰지 않고 .md·.json을 둘 다 그대로 둬요(A21). 마크다운을 읽지 못하면 쓰지도 못해서 [실패]예요.
      // 손으로 고친 요약 일지는 A18 ③으로도 다시 만들지 않아요(그날이 끝난 뒤 만든 일지를 그대로 두는 것과 같아서 [알림]에도 넣지 않아요).
      if (p.existing.mdExists) {
        let edited: boolean;
        try {
          edited = isHandEditedFile(files.md, p.existing.day);
        } catch (err) {
          throw new DataDirWriteError(cfg.dataDir, errorCode(err));
        }
        if (edited) {
          if (!p.continuation) skippedEdited.push(p.date);
          continue;
        }
      }
      // 같은 날짜의 마크다운과 화면용 데이터는 함께 바뀌어야 해요. 한쪽을 다른 프로그램이 잡고 있거나 읽기 전용이면 둘 다 쓰기 전에
      // 멈춰요(F2-23, PRD 5장). claude를 부르기 전에 미리 알아봐요(쓰기 바로 전에도 한 번 더 봐요).
      if (!p.continuation) {
        for (const f of [files.md, files.json]) {
          const code = probeWritable(f);
          if (code) throw new DataDirWriteError(cfg.dataDir, code);
        }
      }
      const prep: Prepared = { plan: p, built, inputs: new Map(), reused: new Map(), candidates: [] };
      if (p.summary) {
        prep.inputs = builder.summaryInputs(p.date);
        const store = readSummaryFile(cfg.dataDir, p.date);
        // 읽지 못하거나 깨진 요약 저장 파일은 저장한 요약이 없는 것으로 보고 S3에 알려요(A27).
        if (store.problem) prep.storeProblem = { path: summaryFilePath(cfg.dataDir, p.date), code: store.code };
        const range = built.day.range;
        for (const proj of built.day.projects) {
          for (const s of proj.sessions) {
            const input = prep.inputs.get(s.sessionId);
            if (!input?.target) continue; // 그날 본 세션의 요청·답변 글이 없는 세션은 부르지 않아요(서브 에이전트 기록만 있는 등)
            const saved = store.entries.get(s.sessionId);
            // 같은 세션·같은 하루 범위의 저장된 요약이 있고 표지(그날 줄 수·마지막 줄 시각)가 같으면 다시 부르지 않아요(A27).
            if (saved && sameRange(saved.range, range) && sameMark(saved.mark, input.mark)) prep.reused.set(s.sessionId, saved.summary);
            else if (cfg.summary) prep.candidates.push({ date: p.date, input, range });
            // 요약을 끈 실행은 부르지 않아요. 새 세션·줄이 늘어난 세션은 요약 줄을 비워 두고, 다음에 요약을 켠 실행이 이어서 채워요(A28).
          }
        }
      }
      prepared.push(prep);
    }
  } finally {
    prog2.done();
  }

  // ㉯ 요약 부르기 (요약을 켠 실행만)
  // 부를 후보는 ㉮에서 모은 모든 요약 대상 세션이에요. 다시 만들지 않을 수도 있는 ③ 일지의 빈 세션도 넣어서 순서대로 꺼내요.
  // 상한(50)은 claude를 실제로 실행한 수라, 재료를 만들지 못한 세션이 있으면 그만큼 다음 세션을 더 꺼내요(A24). 그래서 어느 ③ 일지를
  // 다시 만들지는 부른 뒤에 정해요(아래). 꺼내지 않은 ③ 일지의 빈 세션도 "부를 세션"이라, 50번을 다 쓰고 그런 세션만 남아도 상한에 닿은 거예요.
  let run: SummaryRun = emptyRun();
  const calls = orderCandidates(prepared.flatMap((x) => x.candidates));
  if (cfg.summary && calls.length > 0) {
    const stop = opts.stop ?? new StopSignal();
    // Ctrl+C면 부르던 claude도 끝내고, 받은 요약은 요약 저장 파일에 남긴 채 일지는 쓰지 않고 멈춰요(A26).
    const onInt = () => stop.request();
    process.on('SIGINT', onInt);
    const prog3 = progress(SUMMARY_TEXT.progressLabel, SUMMARY_TEXT.progressUnit);
    try {
      const workDir = makeWorkDir(cfg.dataDir);
      run = await runSummaryCalls(calls, {
        dataDir: cfg.dataDir,
        workDir,
        dayStartHour: cfg.dayStartHour,
        redactor,
        stop,
        onProgress: prog3.update,
        material: opts.material,
      });
    } finally {
      prog3.done();
      process.off('SIGINT', onInt);
      removeWorkDir(cfg.dataDir);
    }
    if (run.stats.interrupted) {
      // 요약 대신 [취소] 안내만 표준 오류로 찍고 종료 코드 1이에요(PRD S3·A26, DESIGN S3 가·나 오류, 사용자가 멈춘 것이라 [실패]가 아니에요).
      // 일지는 하나도 쓰지 않아요(쓰던 날짜가 한쪽만 바뀌거나 요약 줄이 일부만 든 채 남지 않게). `화면`·`검사`·`보냄` 줄도 없어요.
      process.stderr.write(renderSummaryInterrupted(savedCount(run.stats), painter(process.stderr)));
      return 1;
    }
  }
  const { results, outcomes, stats } = run;

  // ③ 일지 고르기 (A18 ③·A24): 이번 실행이 부르려고 꺼낸 세션(실행했거나 재료를 만들지 못함)이 있거나, 저장해 둔 요약으로 새로 채울 세션이
  // 있는 일지만 다시 만들어요. 꺼낸 세션이 없으면 바뀔 것이 없어 그대로 둬요. 재료를 만들지 못해 더 꺼낸 세션이 이런 일지에 있어도
  // 그 일지는 다시 만들어져 받은 요약이 들어가요(취합 20회차 차이 1).
  const final = prepared.filter((x) => {
    if (!x.plan.continuation) return true;
    const before = emptySummarySessions(x.plan.existing.day);
    return x.candidates.some((c) => outcomes.get(keyOf(c))?.attempted === true) || [...x.reused.keys()].some((sid) => before.has(sid));
  });
  // S3의 요약한·못 한 세션 수는 이번에 쓰는 일지의 세션만 세요(요약한 + 못 한 = 요약 대상). 다시 만들지 않은 ③ 일지의 빈 세션은 남은 세션 줄에 들어요.
  // 다만 멈춘 까닭이 이번에 쓰는 일지의 수에 없으면 그 까닭으로 부르지 않은 세션을 S3가 그 까닭으로 세요(아래 haltedOutside, summaryCounts).
  const writtenKeys = final.flatMap((x) => x.candidates.map(keyOf));
  const tally = tallyOutcomes(writtenKeys, outcomes);
  // 찾지 못함·로그인 안 됨·사용량 제한으로 멈췄으면 그 까닭으로 부르지 않은 세션 중 이번에 쓰지 않는 일지(다시 만들지 않은 ③ 일지)에 있는 수도
  // S3에 넘겨요(취합 22회차 차이 1). claude를 찾지 못하면 한 세션도 꺼내지 않아 ③ 일지를 다시 만들지 않아서, 부를 세션이 모두 그런 일지에 있으면
  // 이번에 쓴 일지의 수에 그 까닭이 없어요. 어떻게 셀지는 term/s3-summary.ts의 summaryCounts가 정해요. ③ 고르기·일지 쓰기는 그대로예요.
  const writtenKeySet = new Set(writtenKeys);
  const haltedOutside = stats.halted
    ? calls.filter((c) => {
        const o = outcomes.get(keyOf(c));
        return !writtenKeySet.has(keyOf(c)) && o?.status === 'failed' && o.reason === stats.halted;
      }).length
    : 0;

  // ㉰ 쓰기
  const made: MadeDay[] = [];
  const identityOff: string[] = [];
  const droppedSummary: string[] = [];
  const written = new Set<string>();
  let reusedCount = 0;
  /** 요약 대상 세션 수 (이번에 쓴 요약 일지의 세션 중 그날 요청·답변 글이 있는 세션, 요약을 켠 실행만 보여 줘요) */
  let targets = 0;
  let remainingSessions = 0;
  let remainingDays = 0;
  const totals = {
    sessionIds: new Set<string>(),
    subagentFileKeys: new Set<string>(),
    commits: 0,
    redactions: {} as Counts,
    identity: {} as Counts,
    repoKeys: new Set<string>(),
  };
  for (const x of final) {
    const { plan: p, built } = x;
    const files = worklogFiles(cfg.dataDir, p.date);
    if (p.summary) {
      const texts = new Map(x.reused);
      for (const c of x.candidates) {
        const t = results.get(candidateKey(c.date, c.input.sessionId));
        if (t) texts.set(c.input.sessionId, t);
      }
      applySummaries(built.day, redactor, x.inputs, texts);
      reusedCount += x.reused.size;
      targets += x.reused.size + x.candidates.length;
    }
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
    written.add(p.date);
    made.push({ date: p.date, status: p.existing.mdExists ? 'remade' : 'new', mdPath: files.md, hideIdentity: p.hideIdentity });
    // --date·--from으로 이름·이메일 가리기가 켜져 있던 일지를 끈 채 다시 만들었으면 알려요(A21). 기본 실행은 이 경우가 생기지 않아요.
    if (req.kind !== 'default' && p.existing.mdExists && p.existing.day?.hideIdentity === true && !p.hideIdentity) identityOff.push(p.date);
    // 요약을 켜고 만든 일지를 요약을 끈 채 다시 만들었으면 요약 줄이 빠져요. 잃는 것이 없어 경고 대신 S3에 수와 다시 만드는 법을 알려요(A28).
    if (!p.summary && p.existing.mdExists && p.existing.day?.summaryEnabled === true) droppedSummary.push(p.date);
    const empty = emptySummarySessions(day).size;
    if (empty > 0) {
      remainingSessions += empty;
      remainingDays++;
    }
    // 여러 날의 합계: 세션·서브 에이전트 기록·저장소는 겹치지 않게 세고(여러 날에 걸친 세션은 한 번), 커밋은 날짜가 하나라 더해요(DESIGN S3 가·나 3번).
    for (const proj of day.projects) for (const s of proj.sessions) totals.sessionIds.add(s.sessionId);
    for (const f of built.subagentFileKeys) totals.subagentFileKeys.add(f);
    totals.commits += day.totals.commits;
    mergeCounts(totals.redactions, day.redactions);
    mergeCounts(totals.identity, day.identity);
    for (const k of built.repoKeys) totals.repoKeys.add(k);
  }

  // 기본 실행의 "그대로 둔 일지": 일지 폴더에 이미 있던 일지(마크다운) 중 대상 날짜가 아니라서 이번에 건드리지 않은 일지예요
  // (그날이 끝난 뒤 만든 일지, 만든 시각을 알 수 없는 일지, 가장 이른 세션 날짜보다 이른 날짜 등, DESIGN S3 가·나 "이 절의 말").
  // 이번 실행이 꺼낸 세션이 없어 다시 만들지 않은 ③ 일지도 여기에 들어요.
  const planned = new Set([...plans.filter((p) => !p.continuation).map((p) => p.date), ...final.map((x) => x.plan.date)]);
  const mdDates = req.kind === 'default' ? existingMdDates(cfg.dataDir) : [];
  const kept = mdDates.filter((d) => !planned.has(d)).length;
  // 기본 실행이면 이번에 다시 만들지 않은 요약 일지에 남은 빈 세션도 더해 전체 남은 수예요. 손으로 고친 일지의 세션은 이어서 채우지 않아서 세지 않아요(A24·A28).
  if (req.kind === 'default') {
    for (const date of mdDates) {
      if (written.has(date)) continue;
      const ex = readExisting(cfg.dataDir, date);
      const empty = emptySummarySessions(ex.day).size;
      if (empty === 0) continue;
      try {
        if (isHandEditedFile(worklogFiles(cfg.dataDir, date).md, ex.day)) continue;
      } catch {
        continue;
      }
      remainingSessions += empty;
      remainingDays++;
    }
  }

  const summaryInfo: SummaryRunInfo = {
    on: cfg.summary,
    targets,
    newly: tally.newly,
    reused: reusedCount,
    failed: tally.failed,
    deferred: tally.deferred,
    // 상한에 닿음 (A24): 50번을 다 실행했고 부를 세션이 더 남음. 남은 세션이 다시 만들지 않은 ③ 일지에만 있어도 닿은 거예요(취합 20회차 차이 2).
    capReached: stats.capReached,
    sent: tally.sent,
    remaining: remainingSessions > 0 ? { sessions: remainingSessions, days: remainingDays } : null,
    droppedDays: droppedSummary,
    // 이번에 쓴 일지의 요약 저장 파일만 알려요(이번 실행이 꺼낸 세션이 없어 다시 만들지 않은 ③ 일지는 빼요).
    storeProblems: final
      .map((x) => x.storeProblem)
      .filter((x): x is StoreProblem => !!x)
      .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0)),
    storeWriteFailed: stats.storeWriteFailed,
    showRemaining: cfg.summary || req.kind === 'default',
    halted: stats.halted ? { reason: stats.halted, outside: haltedOutside } : null,
  };

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
        rerunHideCommand:
          identityOff.length > 0 ? rerunHideCommand(dateArgs, { ...ctx, cliRoots: cliRootsOf(cfg), summary: cfg.summaryFromCli === true }) : null,
        // A20: 이번 실행에 --root도 config.json의 roots도 없을 때만, git을 찾지 못했으면 빼요.
        noRootsHint: cfg.roots.length === 0 && gitOk,
        worklogsDir: dataPaths(cfg.dataDir).worklogsDir,
      },
      summary: summaryInfo,
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
