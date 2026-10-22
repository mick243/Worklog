// F2 이름·이메일 가리기 (옵션, 기본 꺼짐). 일지(마크다운·화면)에만 쓰고 보관본에는 쓰지 않아요(A10).
// 경로 모양 안의 사용자 이름(C:\Users\이름, /home/이름, /Users/이름 등)과 이메일 주소만 가려요.
// 문장 속에 따로 나온 이름이나 사람 이름은 가리지 않아요.
import { MARKER_PREFIX } from './marker.js';
import { applyRule, type Counts } from './redact.js';
import type { Rule } from './rules.js';

export const USER_NAME_LABEL = '사용자 이름';
export const EMAIL_LABEL = '이메일';

const NOT_PERSONAL = new Set(['public', 'default', 'shared', 'all users', 'default user']);

const acceptName = (name: string) => !name.includes(MARKER_PREFIX) && !NOT_PERSONAL.has(name.toLowerCase());

export const IDENTITY_RULES: Rule[] = [
  {
    id: 'windows-user-path',
    label: USER_NAME_LABEL,
    pattern: /(?<pre>\b[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/))(?<secret>[^\\/\s"'`<>|:*?[\]]{1,64})/gi,
    accept: acceptName,
  },
  {
    id: 'posix-user-path',
    label: USER_NAME_LABEL,
    pattern: /(?<![A-Za-z0-9.-])(?<pre>(?:\/mnt)?(?:\/[a-zA-Z])?\/(?:Users|home)\/)(?<secret>[^/\\\s"'`<>|:*?[\]]{1,64})/g,
    accept: acceptName,
  },
  {
    id: 'email',
    label: EMAIL_LABEL,
    pattern:
      /(?<![A-Za-z0-9._%+-])(?<secret>[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24})(?![A-Za-z0-9-])/g,
    accept: (s) => !s.includes(MARKER_PREFIX) && !/^git@/i.test(s),
  },
];

export function maskIdentity(s: string, counts?: Counts): string {
  if (!s) return s;
  let out = s;
  for (const rule of IDENTITY_RULES) out = applyRule(out, rule, counts);
  return out;
}

export function detectIdentity(s: string): Counts {
  const c: Counts = {};
  maskIdentity(s, c);
  return c;
}
