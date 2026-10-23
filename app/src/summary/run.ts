// AI 요약 부르기 (PRD A24·A26·A28): 부를 세션을 고르는 순서, 실행마다 50번 상한, 동시에 2개, 실패 까닭 세기.
// 받은 요약은 받는 대로 가린 뒤 요약 저장 파일에 남겨요(가리기 전 글은 어디에도 쓰지 않아요, A27).
import type { Redactor } from '../redact/redact.js';
import type { SummaryInput } from '../worklog/build.js';
import {
  CALL_CONCURRENCY,
  CALL_LIMIT,
  callClaude,
  callTimeoutMs,
  FAIL_REASONS,
  resolveClaude,
  STOPPING_REASONS,
  type ClaudeCommand,
  type FailReason,
  type StopSignal,
} from './claude.js';
import { errorCode } from '../util/fs.js';
import { buildMaterial } from './material.js';
import { sanitizeReceived, saveSummary, summaryFilePath } from './store.js';

/** 요약을 부를 세션 하나 (날짜 하나) */
export interface Candidate {
  date: string;
  input: SummaryInput;
  /** 그 일지의 하루 범위 (ISO) */
  range: { start: string; end: string };
}

export const candidateKey = (date: string, sessionId: string) => `${date}\u0000${sessionId}`;
export const keyOf = (c: Candidate) => candidateKey(c.date, c.input.sessionId);

/**
 * 부르는 순서 (A24): 날짜가 늦은 일지의 세션부터, 같은 날짜면 그날 마지막 줄 시각이 늦은 세션부터, 같으면 세션 아이디 순이에요.
 * 오늘 일지가 먼저 채워지고, 지난 날짜가 많이 남아도 매일의 새 일지가 밀리지 않게 하려는 거예요.
 */
export function orderCandidates(list: Candidate[]): Candidate[] {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...list].sort(
    (a, b) =>
      cmp(b.date, a.date) || cmp(b.input.mark.lastLineAt ?? '', a.input.mark.lastLineAt ?? '') || cmp(a.input.sessionId, b.input.sessionId),
  );
}

/**
 * 세션 하나가 이번 실행에서 어떻게 끝났는지 (A24·A28). 출력·오류 원문은 담지 않아요.
 *  - ok: 새로 받은 요약 (글은 results에 있어요)
 *  - failed: 못 함. reason이 까닭이에요. 재료를 만들지 못해 실행하지 않은 세션은 그 밖(other)이고, 찾지 못함·로그인 안 됨·사용량 제한이
 *    나온 뒤 부르지 않은 세션은 같은 까닭이에요.
 *  - deferred: 50번 상한으로 미룸 (이번 실행이 claude를 50번 실행했고 이 세션은 꺼내지 않았어요)
 *  - interrupted: Ctrl+C로 멈춰 부르지 않았거나 끊었어요
 */
export interface CandidateOutcome {
  status: 'ok' | 'failed' | 'deferred' | 'interrupted';
  reason?: FailReason;
  /** claude를 실제로 실행했는지 (50번 상한에 세는 수, 성공·실패 모두) */
  executed: boolean;
  /** 가린 대화 글이 Claude Code로 나갔을 수 있는지 (보낸 세션, A28: 실행한 세션 중 보내기 전에 멈춘 것이 확실한 세션만 빼요) */
  sent: boolean;
  /**
   * 이번 실행이 이 세션을 부르려고 꺼냈는지 (재료를 만들어 봤어요: 실행했거나 재료를 만들지 못함).
   * 기본 실행은 꺼낸 세션이 있는 요약 일지만 A18 ③으로 다시 만들어요(commands/make.ts).
   */
  attempted: boolean;
}

export interface CallStats {
  /** claude를 실제로 실행한 수 (상한에 세는 수, 성공·실패 모두) */
  executed: number;
  /** 새로 받은 요약 수 */
  newly: number;
  /**
   * 상한에 닿았는지 (A24 "상한에 닿음"): 이번 실행이 claude를 50번 실행했고, 부를 세션(넘겨받은 후보)이 더 남았어요.
   * 찾지 못함·로그인 안 됨·사용량 제한으로 멈췄거나 Ctrl+C로 멈췄으면 닿은 것이 아니에요.
   */
  capReached: boolean;
  /** 찾지 못함·로그인 안 됨·사용량 제한으로 남은 세션을 부르지 않았으면 그 까닭 */
  halted: FailReason | null;
  /** Ctrl+C로 멈췄는지 */
  interrupted: boolean;
  /** 받은 요약을 요약 저장 파일에 쓰지 못한 파일 (날짜 순서). 받은 요약은 일지에 넣어요(A27). */
  storeWriteFailed: StoreWriteFailure[];
}

/** 받은 요약을 쓰지 못한 요약 저장 파일 하나 (S3 [알림], A27). 파일 내용은 담지 않아요. */
export interface StoreWriteFailure {
  date: string;
  /** 절대 경로 */
  path: string;
  /** 원인 코드(EBUSY 등). 알 수 없으면 없어요. */
  code?: string;
  /** 이 파일에 쓰지 못한 요약 수 (세션 수) */
  sessions: number;
}

export function emptyStats(): CallStats {
  return { executed: 0, newly: 0, capReached: false, halted: null, interrupted: false, storeWriteFailed: [] };
}

/** 받아서 요약 저장 파일에 남긴 요약 수 (새로 받음 − 쓰지 못함). Ctrl+C [취소]의 "받은 요약 N개는 저장해 뒀어요"예요. */
export function savedCount(stats: CallStats): number {
  return stats.newly - stats.storeWriteFailed.reduce((n, f) => n + f.sessions, 0);
}

/** S3에 보여 줄 수 (후보 몇 개의 결과를 모은 것) */
export interface OutcomeTally {
  newly: number;
  failed: Record<FailReason, number>;
  deferred: number;
  sent: number;
}

/** 후보들의 결과를 까닭별로 모아요. 결과가 없는 후보(부르지 않은 실행)는 세지 않아요. */
export function tallyOutcomes(keys: Iterable<string>, outcomes: ReadonlyMap<string, CandidateOutcome>): OutcomeTally {
  const t: OutcomeTally = { newly: 0, failed: Object.fromEntries(FAIL_REASONS.map((r) => [r, 0])) as Record<FailReason, number>, deferred: 0, sent: 0 };
  for (const k of keys) {
    const o = outcomes.get(k);
    if (!o) continue;
    if (o.sent) t.sent++;
    if (o.status === 'ok') t.newly++;
    else if (o.status === 'deferred') t.deferred++;
    else if (o.status === 'failed' && o.reason) t.failed[o.reason]++;
  }
  return t;
}

export interface CallOptions {
  dataDir: string;
  /** 요약 호출용 빈 작업 폴더 (summary/claude.ts의 makeWorkDir) */
  workDir: string;
  dayStartHour: number;
  redactor: Redactor;
  stop: StopSignal;
  limit?: number;
  concurrency?: number;
  timeoutMs?: number;
  /** 시험용: 실행할 claude (없으면 PATH나 CC_WORKLOG_CLAUDE에서 찾아요) */
  command?: ClaudeCommand | null;
  /** 시험용: 재료 만들기를 감싸요 (보관본을 읽지 못한 경우를 흉내 낼 때). build는 원래의 재료 만들기예요. */
  material?: (c: Candidate, build: () => Promise<string>) => Promise<string>;
  /** 진행 표시 (끝난 세션 수, 부를 세션 수) */
  onProgress?: (done: number, total: number) => void;
}

export interface SummaryRun {
  /** (날짜, 세션) → 가린 요약 한 줄 */
  results: Map<string, string>;
  /** (날짜, 세션) → 이번 실행에서 어떻게 끝났는지 (넘겨받은 후보 모두) */
  outcomes: Map<string, CandidateOutcome>;
  stats: CallStats;
}

export function emptyRun(): SummaryRun {
  return { results: new Map(), outcomes: new Map(), stats: emptyStats() };
}

/**
 * 순서대로 놓인 세션(ordered)을 앞에서부터 꺼내 불러요. 동시에 2개예요.
 * 상한(50)은 claude를 실제로 실행한 수예요(A24). 재료(가린 보관본의 그날 글)를 만들지 못해 실행하지 않은 세션은 세지 않고
 * 그 밖의 실패로 센 뒤 다음 세션을 꺼내, 실행 수가 50이 될 때까지 채워요. 50번째를 시작하면 더 꺼내지 않고, 시작한 호출은 끝나기를 기다려요.
 * 찾지 못함·로그인 안 됨·사용량 제한이 한 번 나오면 남은 세션은 부르지 않고 같은 까닭으로 세요. 시간 초과와 그 밖은 계속 불러요(A28).
 * 50번을 다 실행했는데 꺼내지 않은 세션이 남았으면 그 세션들은 "50번 상한으로 미룸"이고 상한에 닿은 거예요.
 */
export async function runSummaryCalls(ordered: Candidate[], opts: CallOptions): Promise<SummaryRun> {
  const stats = emptyStats();
  const results = new Map<string, string>();
  const outcomes = new Map<string, CandidateOutcome>();
  const limit = opts.limit ?? CALL_LIMIT;
  const cmd = opts.command === undefined ? resolveClaude() : opts.command;
  if (!cmd) {
    // claude를 찾지 못했어요. 한 번도 실행하지 않고 모든 세션을 "찾지 못함"으로 세요(A28). 꺼낸 세션은 없어요.
    for (const c of ordered) outcomes.set(keyOf(c), { status: 'failed', reason: 'not-found', executed: false, sent: false, attempted: false });
    stats.halted = 'not-found';
    return { results, outcomes, stats };
  }
  const timeoutMs = opts.timeoutMs ?? callTimeoutMs();
  const build = async (c: Candidate) => (await buildMaterial(c.input, c.date, opts.dayStartHour, opts.redactor)).text;
  const makeMaterial = (c: Candidate) => (opts.material ? opts.material(c, () => build(c)) : build(c));
  const writeFailed = new Map<string, StoreWriteFailure>();
  /** 다음에 꺼낼 자리 */
  let next = 0;
  /** 시작한 실행 수 (상한에 세는 수) */
  let started = 0;
  /** 재료를 만드는 중이라 실행 자리를 잡아 둔 수 (만들지 못하면 돌려줘요) */
  let reserved = 0;
  let finished = 0;
  const total = Math.min(limit, ordered.length);
  /** 찾지 못함·로그인 안 됨·사용량 제한이 처음 나온 까닭 (worker 안에서 바꿔서 객체에 둬요) */
  const halt: { reason: FailReason | null } = { reason: null };

  const worker = async () => {
    // 한 번에 하나씩: 자리를 잡고(started + reserved < limit) 꺼낸 뒤 재료를 만들어요. 재료를 만들지 못하면 자리를 돌려주고 다음 세션을 꺼내요.
    while (next < ordered.length && !halt.reason && !opts.stop.requested && started + reserved < limit) {
      const c = ordered[next++]!;
      const key = keyOf(c);
      reserved++;
      let material: string;
      try {
        material = await makeMaterial(c);
      } catch {
        // 보관본을 읽지 못했어요(다른 프로그램이 잡고 있음 등). 실행하지 않았으니 상한에 세지 않고, 보내지 않았고, 그 밖의 실패로 세요(A24).
        reserved--;
        outcomes.set(key, { status: 'failed', reason: 'other', executed: false, sent: false, attempted: true });
        continue;
      }
      reserved--;
      if (halt.reason || opts.stop.requested) {
        // 재료를 만드는 사이에 다른 호출이 멈출 까닭을 알렸어요. 부르지 않아요(결과를 남기지 않아 아래에서 꺼내지 않은 세션과 함께 세요).
        break;
      }
      started++;
      const out = await callClaude(cmd, material, { cwd: opts.workDir, timeoutMs, stop: opts.stop });
      opts.onProgress?.(++finished, total);
      if (out.ok) {
        stats.executed++;
        const text = sanitizeReceived(out.text, opts.redactor);
        if (!text) {
          // 빈 결과 (A28 그 밖). 답이 왔으니 보낸 거예요.
          outcomes.set(key, { status: 'failed', reason: 'other', executed: true, sent: true, attempted: true });
          continue;
        }
        try {
          saveSummary(opts.dataDir, c.date, { sessionId: c.input.sessionId, range: c.range, mark: c.input.mark, summary: text, createdAt: new Date().toISOString() });
        } catch (err) {
          // 요약 저장 파일에 쓰지 못해도 멈추지 않고 일지에는 넣어요. S3 [알림]으로 알려요(A27). 그 세션은 저장 파일에 없어서
          // 요약을 켜고 그 날짜를 다시 만들 때 다시 불러요.
          const f = writeFailed.get(c.date) ?? { date: c.date, path: summaryFilePath(opts.dataDir, c.date), sessions: 0 };
          f.sessions++;
          const code = errorCode(err);
          if (/^E[A-Z0-9]+$/.test(code)) f.code ??= code;
          writeFailed.set(c.date, f);
        }
        results.set(key, text);
        stats.newly++;
        outcomes.set(key, { status: 'ok', executed: true, sent: true, attempted: true });
        continue;
      }
      if (out.ran) stats.executed++;
      if (out.reason === 'interrupted') {
        outcomes.set(key, { status: 'interrupted', executed: out.ran, sent: out.sent, attempted: true });
        continue;
      }
      outcomes.set(key, { status: 'failed', reason: out.reason, executed: out.ran, sent: out.sent, attempted: true });
      if (STOPPING_REASONS.has(out.reason) && !halt.reason) halt.reason = out.reason;
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? CALL_CONCURRENCY) }, () => worker()));

  stats.interrupted = opts.stop.requested;
  stats.halted = halt.reason;
  // 꺼내지 않은 세션 (재료를 만든 뒤 멈춰 부르지 않은 세션 포함)
  const untaken = ordered.filter((c) => !outcomes.has(keyOf(c)));
  for (const c of untaken) {
    const key = keyOf(c);
    if (stats.interrupted) outcomes.set(key, { status: 'interrupted', executed: false, sent: false, attempted: false });
    // 남은 세션은 부르지 않고 같은 까닭으로 세요(같은 실패를 세션 수만큼 되풀이하지 않게, A28).
    else if (halt.reason) outcomes.set(key, { status: 'failed', reason: halt.reason, executed: false, sent: false, attempted: false });
    else outcomes.set(key, { status: 'deferred', executed: false, sent: false, attempted: false });
  }
  stats.capReached = !stats.interrupted && !halt.reason && started >= limit && untaken.length > 0;
  stats.storeWriteFailed = [...writeFailed.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { results, outcomes, stats };
}
