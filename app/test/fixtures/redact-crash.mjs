// 시험용: 보관본 다시 가리기를 중간에 멈춘 경우를 흉내 내요.
// 사용: node redact-crash.mjs <claudeDir> <dataDir> <stage|rename|interrupt|enospc|enospc-nomark> <n>
//  - stage: 새 내용 파일을 n개 쓴 뒤 프로세스를 강제로 끝내요(SIGKILL). 정리 코드는 하나도 돌지 않아요.
//  - rename: 원래 이름으로 n개 바꾼 뒤 강제로 끝내요.
//  - interrupt: 새 내용 파일을 n개 쓴 뒤 Ctrl+C(SIGINT)를 받은 것처럼 해요.
//  - enospc: 새 내용 파일을 n개 쓴 뒤 디스크가 가득 찬 쓰기 오류(ENOSPC)가 난 것처럼 해요(확정 전 쓰기 오류).
//  - enospc-nomark: enospc와 같지만, 오류 직전에 다시 쓰기 기록 파일을 읽기 전용으로 바꿔(POSIX는 데이터 폴더도)
//    되돌린 뒤 "깨짐" 표시(markBroken)도 쓰지 못하게 해요(6회차). Windows는 읽기 전용 파일 위로 이름을 바꿀 수 없어서,
//    POSIX는 읽기 전용 폴더에 임시 파일을 만들 수 없어서 실패해요. 끝나면 권한을 되돌려요.
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../../dist/src/config.js';
import { runRedact } from '../../dist/src/commands/redact.js';
import { JOURNAL_NAME } from '../../dist/src/redact/journal.js';

const [claudeDir, dataDir, phase, nText] = process.argv.slice(2);
const n = Number(nText);
const cfg = resolveConfig({ claudeDir, dataDir });
const journal = join(dataDir, JOURNAL_NAME);
const posix = process.platform !== 'win32';
const kill = () => process.kill(process.pid, 'SIGKILL');
const diskFull = () => {
  throw Object.assign(new Error('디스크 가득 참 흉내'), { code: 'ENOSPC' });
};
const blockJournalWrites = () => {
  chmodSync(journal, 0o444);
  if (posix) chmodSync(dataDir, 0o555);
};
const unblockJournalWrites = () => {
  if (posix) chmodSync(dataDir, 0o755);
  try {
    chmodSync(journal, 0o644);
  } catch {
    /* 기록 파일이 없어요 */
  }
};
const hooks =
  phase === 'stage'
    ? { afterStage: (i) => i === n && kill() }
    : phase === 'rename'
      ? { afterRename: (i) => i === n && kill() }
      : phase === 'enospc'
        ? { afterStage: (i) => i === n && diskFull() }
        : phase === 'enospc-nomark'
          ? {
              afterStage: (i) => {
                if (i !== n) return;
                blockJournalWrites();
                diskFull();
              },
            }
          : { afterStage: (i) => i === n && process.emit('SIGINT') };
let out = '';
let err = '';
let code;
try {
  code = await runRedact(cfg, {
    yes: true,
    hooks,
    io: { interactive: false, color: false, errColor: false, write: (s) => (out += s), writeErr: (s) => (err += s), ask: async () => null },
  });
} catch (e) {
  // runRedact가 [실패]를 찍지 않고 오류를 던졌어요(cli.ts의 일반 [실패]로 가는 경우). 시험이 알아볼 수 있게 표시만 남겨요.
  err += `(redact-crash) runRedact가 오류를 던졌어요: ${e?.code ?? e?.name ?? 'Error'}\n`;
  code = 99;
} finally {
  if (phase === 'enospc-nomark') unblockJournalWrites();
}
process.stdout.write(out);
process.stderr.write(err);
process.exitCode = code;
