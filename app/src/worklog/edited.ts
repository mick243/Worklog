// 손으로 고친 일지 마크다운 알아보기 (PRD F1·A21, 5장).
// 도구가 마지막으로 쓴 마크다운 내용의 해시를 화면용 일지 데이터(worklogs/<날짜>.json)의 markdownHash 칸에 둬요. 새 종류의 파일은 만들지 않고,
// 원문도 따로 남기지 않아요. 지금 마크다운이 그 해시와 조금이라도 다르면(줄 끝 모양만 바뀌어도, 안전 쪽) 손으로 고친 일지예요.
// 이 칸이 없는 일지(이 규칙 전에 만든 일지)는 고쳤는지 알 수 없어서 고치지 않은 것으로 봐요(한쪽만 가려진 일지를 다시 만들어 고치는 길, A16).
import { readFileSync } from 'node:fs';
import { sha256 } from '../util/fs.js';

/** 마크다운 글의 해시 (파일에 쓰는 UTF-8 바이트 그대로) */
export function markdownHashOf(md: string | Buffer): string {
  return sha256(typeof md === 'string' ? Buffer.from(md, 'utf8') : md);
}

/** 화면용 일지 데이터에 남은 해시. 없거나 모양이 다르면 null이에요. */
export function storedMarkdownHash(day: unknown): string | null {
  const h = (day as { markdownHash?: unknown } | null)?.markdownHash;
  return typeof h === 'string' && /^[0-9a-f]{64}$/.test(h) ? h : null;
}

/** 마크다운 내용이 도구가 마지막으로 쓴 내용과 다른지 (해시가 없으면 false) */
export function isHandEdited(mdBytes: Buffer | string, day: unknown): boolean {
  const stored = storedMarkdownHash(day);
  return stored !== null && markdownHashOf(mdBytes) !== stored;
}

/** 마크다운 파일을 읽어 손으로 고쳤는지 봐요. 파일을 읽지 못한 오류(EBUSY 등)는 그대로 던져요. */
export function isHandEditedFile(mdPath: string, day: unknown): boolean {
  if (storedMarkdownHash(day) === null) return false;
  return isHandEdited(readFileSync(mdPath), day);
}
