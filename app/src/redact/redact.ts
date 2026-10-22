// F2 가리기 엔진. 세션 기록과 커밋 메시지를 읽는 단계에서, 쓰기 전에 비밀 값을 [가림:종류]로 바꿔요.
// 가리기 전 원문은 어디에도 쓰지 않아요(임시 파일·로그·오류 메시지 포함).
import { readFileSync } from 'node:fs';
import { parseJsonText } from '../util/json.js';
import { MARKER_PREFIX, marker } from './marker.js';
import {
  BUILTIN_RULES,
  isSecretName,
  looksLikeSecretValue,
  NAMED_SECRET_LABEL,
  NAMED_SECRET_PATTERN,
  type Rule,
} from './rules.js';

export type Counts = Record<string, number>;

export function bump(counts: Counts | undefined, label: string, n = 1): void {
  if (!counts || n === 0) return;
  counts[label] = (counts[label] ?? 0) + n;
}

export function mergeCounts(into: Counts, from: Counts): Counts {
  for (const [k, v] of Object.entries(from)) bump(into, k, v);
  return into;
}

export function totalCount(c: Counts): number {
  return Object.values(c).reduce((a, b) => a + b, 0);
}

/** 많은 순(같으면 이름순)으로 정렬한 [종류, 개수] 목록 */
export function sortedCounts(c: Counts): Array<[string, number]> {
  return Object.entries(c)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** 정규식 규칙 하나를 적용해요. 거절한 자리는 한 글자 뒤부터 다시 찾아서 겹친 비밀을 놓치지 않아요. */
export function applyRule(s: string, rule: Rule, counts?: Counts): string {
  const re = rule.pattern;
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let changed = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex = m.index + 1;
      continue;
    }
    const g = m.groups ?? {};
    const secret = g.secret ?? m[0];
    if (!secret || secret.includes(MARKER_PREFIX) || (rule.accept && !rule.accept(secret, g))) {
      re.lastIndex = m.index + 1;
      continue;
    }
    out += s.slice(last, m.index) + (g.pre ?? '') + marker(rule.label) + (g.post ?? '');
    last = m.index + m[0].length;
    re.lastIndex = last;
    changed = true;
    bump(counts, rule.label);
  }
  return changed ? out + s.slice(last) : s;
}

/** 이름=값 규칙. 값 자리만 가리고 이름과 따옴표는 남겨요. */
export function applyNamedSecrets(s: string, counts?: Counts): string {
  const re = NAMED_SECRET_PATTERN;
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let changed = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const q = m[1] ?? '';
    const name = m[2] ?? '';
    const sep = m[3] ?? '';
    const dq = m[4];
    const sq = m[5];
    const bare = m[6];
    const quoted = dq !== undefined || sq !== undefined;
    const value = dq ?? sq ?? bare ?? '';
    if (!isSecretName(name) || !looksLikeSecretValue(value, quoted)) {
      re.lastIndex = m.index + 1;
      continue;
    }
    const valueStart = m.index + q.length * 2 + name.length + sep.length + (quoted ? 1 : 0);
    out += s.slice(last, valueStart) + marker(NAMED_SECRET_LABEL);
    last = valueStart + value.length;
    re.lastIndex = last;
    changed = true;
    bump(counts, NAMED_SECRET_LABEL);
  }
  return changed ? out + s.slice(last) : s;
}

/** 아이디·시각처럼 도구가 만든 값이라 가리기를 건너뛰는 칸 */
const SKIP_KEYS = new Set(['uuid', 'parentUuid', 'leafUuid', 'sessionId', 'timestamp', 'tool_use_id', 'agentId', 'id', 'requestId']);

function isShortish(v: string): boolean {
  return v.length <= 300 && (!/\s/.test(v) || v.length <= 100);
}

export interface UserPattern {
  name: string;
  pattern: string;
  flags?: string;
  samples?: string[];
}

export class Redactor {
  readonly builtin: Rule[];
  readonly user: Rule[];
  readonly userSamples: Map<string, string[]>;

  constructor(userPatterns: UserPattern[] = []) {
    this.builtin = BUILTIN_RULES;
    this.user = [];
    this.userSamples = new Map();
    for (const p of userPatterns) {
      const flags = `${(p.flags ?? '').replace(/[^imsu]/g, '')}g`;
      this.user.push({ id: `user:${p.name}`, label: p.name, pattern: new RegExp(p.pattern, flags) });
      this.userSamples.set(p.name, p.samples ?? []);
    }
  }

  /** 글 하나를 가려요. counts에 종류별 가린 개수를 더해요. */
  redactString(s: string, counts?: Counts): string {
    if (!s) return s;
    let out = s;
    for (const rule of this.builtin) out = applyRule(out, rule, counts);
    for (const rule of this.user) out = applyRule(out, rule, counts);
    return applyNamedSecrets(out, counts);
  }

  /**
   * 객체 안의 모든 글을 가려요. 칸 이름이 비밀 이름(apiKey, password 등)이면 값 전체를 가려요.
   * 원본 객체는 바꾸지 않고 새 객체를 돌려줘요.
   */
  redactDeep(value: unknown, counts?: Counts, keyName?: string): unknown {
    if (typeof value === 'string') {
      if (keyName && isSecretName(keyName) && isShortish(value) && looksLikeSecretValue(value, true)) {
        bump(counts, NAMED_SECRET_LABEL);
        return marker(NAMED_SECRET_LABEL);
      }
      return this.redactString(value, counts);
    }
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v, counts));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const next = SKIP_KEYS.has(k) ? v : this.redactDeep(v, counts, k);
        // "__proto__" 칸도 다른 칸처럼 그대로 남겨요(대입하면 칸이 사라지고 프로토타입이 바뀌어요).
        if (k === '__proto__') Object.defineProperty(out, k, { value: next, enumerable: true, writable: true, configurable: true });
        else out[k] = next;
      }
      return out;
    }
    return value;
  }

  /** 남은 의심 문자열을 세요. 가리기를 한 번 더 돌려 바뀌는 자리를 세는 것과 같아요. */
  detect(s: string): Counts {
    const c: Counts = {};
    this.redactString(s, c);
    return c;
  }

  detectDeep(value: unknown): Counts {
    const c: Counts = {};
    this.redactDeep(value, c);
    return c;
  }
}

/** 사용자 패턴 파일을 읽지 못함. CLI가 [실패] 한 줄(까닭) + 파일 경로 + 다음: 줄로 보여 줘요(DESIGN S3 오류). 패턴 내용·시험 값은 넣지 않아요. */
export class PatternFileError extends Error {
  constructor(
    readonly reason: string,
    readonly path: string,
  ) {
    super(`사용자 패턴 파일을 읽지 못했어요 (${reason})`);
  }
}

/** 사용자 패턴 파일(patterns.json)을 읽어요. 없으면 빈 목록이에요. */
export function loadUserPatterns(path: string): UserPattern[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  let data: unknown;
  try {
    // 맨 앞 UTF-8 BOM은 떼고 읽어요(Windows PowerShell 5.1 등이 붙여요, X-01).
    data = parseJsonText(raw);
  } catch {
    // JSON 오류 메시지에는 파일 내용 조각이 들어갈 수 있어서 그대로 보여 주지 않아요.
    throw new PatternFileError('올바른 JSON이 아니에요', path);
  }
  const list = Array.isArray(data) ? data : (data as { patterns?: unknown })?.patterns;
  if (!Array.isArray(list)) throw new PatternFileError('배열이거나 { "patterns": [...] } 모양이어야 해요', path);
  const out: UserPattern[] = [];
  list.forEach((item, i) => {
    const p = item as Partial<UserPattern>;
    if (typeof p?.name !== 'string' || !p.name.trim() || p.name.length > 40 || /[\]\n]/.test(p.name)) {
      throw new PatternFileError(`${i + 1}번째 패턴의 name이 없거나 너무 길어요. 40자 이하, ]와 줄바꿈 금지`, path);
    }
    if (typeof p.pattern !== 'string' || !p.pattern) throw new PatternFileError(`${i + 1}번째 패턴에 pattern이 없어요`, path);
    try {
      new RegExp(p.pattern, `${(p.flags ?? '').replace(/[^imsu]/g, '')}g`);
    } catch {
      throw new PatternFileError(`${i + 1}번째 패턴의 정규식이 올바르지 않아요`, path);
    }
    const samples = Array.isArray(p.samples) ? p.samples.filter((s): s is string => typeof s === 'string') : [];
    out.push({ name: p.name.trim(), pattern: p.pattern, flags: typeof p.flags === 'string' ? p.flags : '', samples });
  });
  return out;
}
