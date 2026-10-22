// 보관본 다시 가리기 명령 (F2, A16): cc-worklog redact [--yes]
// 지금 규칙(내장 규칙 + 사용자 패턴)으로 보관본과 이미 만든 일지를 다시 가려요. 사용자가 직접 실행할 때만 해요.
//  1. 잠금을 잡고(보관·다른 실행과 동시에 같은 파일을 쓰지 않게), 지난번에 멈춘 다시 가리기가 있으면 마무리해요.
//  2. 바뀔 자리를 세서 보여 줘요(S3). 이때까지 데이터 폴더의 어떤 파일도 바꾸거나 만들지 않아요.
//  3. 바뀔 자리가 0개면 묻지 않고 끝나요(종료 코드 0).
//  4. --yes가 없으면 확인을 물어요. 그냥 Enter·거절·Ctrl+C는 다시 쓰지 않고 종료 코드 1.
//     입력이나 출력이 터미널이 아니면 묻지 않고, 바뀔 자리 수와 --yes 안내만 보여 준 뒤 종료 코드 1.
//  5. 확인하면(또는 --yes) 다시 쓰고 결과를 보여 줘요(종료 코드 0).
// 다시 쓰기 기록이 깨져 있으면(A16, Q21) 1에서 마무리하지 못하고, 기록·남은 임시 파일을 읽지 않은 채 지금 파일로 바뀔 자리를 세요.
// 그 둘은 확인 뒤(--yes 포함)에 지우고 새 기록으로 다시 써요. 바뀔 자리가 0개면 묻지 않고 그 둘만 지워요(종료 코드 0).
// 깨진 기록에서 시작한 다시 쓰기가 확정 전에 되돌려지면 "깨짐" 표시를 다시 남겨요(A16). 확인 전에는 아무것도 만들거나 바꾸지 않아요(5장).
// 읽거나 쓰지 못한 보관본·일지 파일(다른 프로그램이 잡고 있음, 권한 없음 등)이 있으면 말없이 건너뛰지 않아요(F2-23, A16).
//  - 바뀔 자리를 세다 알아보면: 확인을 묻지 않고 멈춰요. 그 파일 위치·원인 코드를 [실패]로 알리고 종료 코드 1, 아무 파일도 바꾸지 않아요.
//  - 확인한 뒤 확정 전에 알아보면(기다리는 동안 잡힌 파일): 그 자리에서 모두 되돌리고 같은 [실패], 종료 코드 1이에요.
//  일부 파일만 쓰지 않는 까닭: 읽지 못한 파일은 바뀔 자리를 셀 수 없어 "보여 준 수 = 바꾼 수"를 지킬 수 없고,
//  쓸 수 있는 파일만 쓰면 일부만 바뀐 채 남아요(같은 날짜 일지의 .md·.json 중 한쪽만 가려질 수 있어요, PRD 5장).
import { createInterface } from 'node:readline';
import { dataPaths, type Config } from '../config.js';
import { anyStaged, clearBrokenJournal, clearBrokenLeftovers, readJournalState, recoverPending, RecoveryError } from '../redact/journal.js';
import { loadUserPatterns, Redactor, totalCount } from '../redact/redact.js';
import { buildRedactPlan, commitPlan, FileAccessError, InterruptedError, PlanChangedError, type CommitHooks } from '../redact/reredact.js';
import { painterFor, progress } from '../term/format.js';
import {
  redactQuestion,
  renderRedactAborted,
  renderRedactBlocked,
  renderRedactInaccessible,
  renderRedactNothing,
  renderRedactPlan,
  renderRedactQuestionIntro,
  renderRedactResult,
  renderRedactStopped,
  renderRedactUnfinished,
  renderRedactYes,
} from '../term/s3-redact.js';
import { writingDataDir } from '../util/fs.js';
import { acquireLock } from '../util/lock.js';

export interface RedactIo {
  /** 확인을 물을 수 있는지 (입력과 출력이 모두 터미널) */
  interactive: boolean;
  color: boolean;
  /** 표준 출력 (요약·바뀔 자리 목록·확인 질문·[취소]) */
  write(s: string): void;
  /** 표준 오류 ([실패]로 끝나는 출력, DESIGN: 오류는 표준 오류) */
  writeErr(s: string): void;
  /** 표준 오류에 색을 입힐지 */
  errColor: boolean;
  /** 한 줄 답을 받아요. Ctrl+C·입력 끝이면 null */
  ask(question: string): Promise<string | null>;
}

export interface RedactOptions {
  yes: boolean;
  io?: RedactIo;
  /** 시험용: 다시 쓰는 중간에 멈춘 경우를 흉내 내요 */
  hooks?: CommitHooks;
}

/** 터미널에서 한 줄 답을 받아요. Ctrl+C나 입력 끝이면 null이에요. (시험에서 입출력을 바꿔 끼울 수 있게 스트림을 받아요) */
export function askLine(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output, terminal: true });
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(v);
    };
    rl.on('SIGINT', () => finish(null));
    rl.on('close', () => finish(null));
    rl.question(question, (answer) => finish(answer));
  });
}

export function terminalIo(): RedactIo {
  return {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    write: (s) => {
      process.stdout.write(s);
    },
    writeErr: (s) => {
      process.stderr.write(s);
    },
    errColor: Boolean(process.stderr.isTTY) && !process.env.NO_COLOR,
    ask: (q) => askLine(q),
  };
}

/** 확인 답: y·yes·예·네만 확인으로 봐요. 그냥 Enter를 포함한 나머지는 모두 거절이에요. */
export function isYes(answer: string): boolean {
  return /^(y|yes|예|네)$/i.test(answer.trim());
}

export async function runRedact(cfg: Config, opts: RedactOptions): Promise<number> {
  const io = opts.io ?? terminalIo();
  const p = painterFor(io.color);
  const release = acquireLock(cfg.dataDir, 'redact');
  try {
    const recovered = recoverPending(cfg.dataDir);
    const redactor = new Redactor(loadUserPatterns(dataPaths(cfg.dataDir).patternsFile));
    const prog = progress('훑는 중');
    const plan = await buildRedactPlan(cfg, redactor, { onProgress: prog.update });
    prog.done();

    // 다시 쓰기 기록이 깨졌으면(A16, Q21): 기록과 남은 임시 파일은 읽지 않고 위에서 지금 파일로 바뀔 자리를 다시 셌어요.
    // 지우는 것은 확인 뒤(--yes 포함)에만, 바뀔 자리가 0개면 묻지 않고 해요. 거절·확인 불가면 아무것도 지우거나 만들지 않아요(5장).
    // 깨진 기록에서 시작한 지난번 다시 가리기를 위에서 되돌려 "깨짐" 표시를 다시 남긴 경우도 같아요(recovered.broken).
    const broken = recovered.broken;

    // 읽거나 쓰지 못한 파일이 있으면 묻지 않고 멈춰요. 깨진 기록과 남은 임시 파일도 그대로 둬요(확인 전, 5장).
    if (plan.inaccessible.length > 0) {
      io.write(renderRedactBlocked(plan, p, recovered));
      io.writeErr(renderRedactInaccessible(plan.inaccessible, 'plan', painterFor(io.errColor), broken));
      return 1;
    }

    if (totalCount(plan.totals) === 0) {
      const cleared = broken ? writingDataDir(cfg.dataDir, () => clearBrokenJournal(cfg.dataDir)) : undefined;
      io.write(renderRedactNothing(plan, p, recovered, cleared));
      return 0;
    }
    io.write(renderRedactPlan(plan, p, recovered));

    if (opts.yes) {
      io.write(renderRedactYes());
    } else if (!io.interactive) {
      io.write(renderRedactStopped('not-interactive', p, broken));
      return 1;
    } else {
      io.write(renderRedactQuestionIntro());
      const answer = await io.ask(redactQuestion(plan));
      if (answer === null) {
        io.write(renderRedactStopped('aborted', p, broken));
        return 1;
      }
      if (!isYes(answer)) {
        io.write(renderRedactStopped('rejected', p, broken));
        return 1;
      }
    }
    // 확인을 받았어요. 남은 임시 파일을 지우고, 깨진 기록은 commitPlan이 "준비 중" 기록(깨진 기록에서 시작했다는 칸 포함)으로 덮어써요.
    // 확정 뒤에 또 멈추면 보통 때처럼 다음 실행이 마저 끝내고, 확정 전에 멈추거나 되돌려지면 "깨짐" 표시가 다시 남아요(A16).
    const clearedStaged = broken ? writingDataDir(cfg.dataDir, () => clearBrokenLeftovers(cfg.dataDir)) : undefined;

    // 새 내용을 쓰는 동안 Ctrl+C가 오면 되돌리고 멈춰요. 이름 바꾸기를 시작한 뒤에는 끝까지 가요.
    const stop = { requested: false };
    const onSignal = () => {
      stop.requested = true;
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    // 아래 catch는 commitPlan이 던진 오류만 받아요(다 쓴 뒤 결과를 찍다 생긴 오류를 "바뀐 파일 없음"으로 잘못 알리지 않게).
    let result: Awaited<ReturnType<typeof commitPlan>>;
    try {
      result = await commitPlan(plan, redactor, { hooks: opts.hooks, stop, fromBroken: broken });
    } catch (err) {
      // 다시 쓰다 멈춘 [실패]는 확정 전·뒤 모두 표준 오류로 보내요(DESIGN S3 다. 오류). 되돌리기·마저 끝내기는 commitPlan과 다음 실행이 이미 해요.
      const ep = painterFor(io.errColor);
      if (err instanceof FileAccessError) {
        // 확정 전에 읽거나 쓰지 못한 파일을 알아봤어요. commitPlan이 새 내용 파일과 기록 파일을 모두 되돌렸어요(바뀐 파일 없음).
        // 깨진 기록에서 시작했으면 깨진 기록(또는 "깨짐" 표시)이 남아 알림이 이어져요(A16). 그 자리의 [실패] 문구는 보통 때와 같아요(PRD S3).
        io.writeErr(renderRedactInaccessible(err.problems, 'commit', ep));
        return 1;
      }
      if (err instanceof InterruptedError) {
        io.writeErr(renderRedactStopped('interrupted', ep));
        return 1;
      }
      if (err instanceof PlanChangedError) {
        // 확정 전에 멈춤: commitPlan이 새 내용 파일과 기록 파일을 지웠어요(깨진 기록에서 시작했으면 "깨짐" 표시로 바꿨어요).
        // 원인 자리는 "확인한 뒤 파일이 바뀌었어요" 같은 까닭이에요. [실패] 문구는 보통 때와 같아요(A16).
        io.writeErr(renderRedactAborted(err.message, 'retry', ep));
        return 1;
      }
      if (err instanceof RecoveryError) {
        // 확정 뒤에 멈춤: 원래 이름으로 바꾸다 실패했어요. 기록 파일이 남아 다음 실행이 마저 끝내요.
        io.writeErr(renderRedactUnfinished(err.message, ep));
        return 1;
      }
      // 그 밖의 쓰기 오류(ENOSPC 등): 기록 파일이 없으면 commitPlan이 확정 전에 모두 되돌린 거예요(바뀐 파일 없음).
      // 깨진 기록에서 시작했으면 되돌린 뒤 "깨짐" 표시가 남아요(또는 "준비 중" 기록을 쓰기 전에 실패해 깨진 기록이 그대로예요). 이것도 바뀐 파일 없음이에요.
      // 되돌린 뒤 "깨짐" 표시마저 쓰지 못했으면(markBroken, 디스크 가득 참 등) fromBroken "준비 중" 기록이 남아요. 새 내용 파일이
      // 남지 않았으면 이것도 바뀐 파일 없음이라 보통 [실패]예요(PRD S3 "그 자리의 [실패] 문구는 보통 때와 같아요"). 알림은 그 기록으로 이어져요.
      // 그 밖에 기록 파일이 남았으면(확정 기록을 쓰다 실패한 경우, 새 내용 파일을 지우지 못한 경우 등) 이 문장으로 말할 수 없어서 일반 [실패]로 넘겨요.
      const after = readJournalState(cfg.dataDir);
      const unmarked = after.state === 'preparing' && after.journal.fromBroken === true && !anyStaged(cfg.dataDir, after.journal.files);
      if (after.state === 'none' || (broken && (after.state === 'broken' || unmarked))) {
        const e = err as NodeJS.ErrnoException;
        io.writeErr(renderRedactAborted(e?.code ?? e?.name ?? 'Error', 'write-error', ep));
        return 1;
      }
      throw err;
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
    io.write(renderRedactResult(result, plan, p, clearedStaged));
    return 0;
  } finally {
    release();
  }
}
