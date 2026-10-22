// F2 비밀 값 가리기 규칙.
// 알려진 형식의 키·토큰, 개인 키 블록, JWT, 접속 주소 속 비밀번호, 이름에 KEY·SECRET·TOKEN·PASSWORD 등이 든 이름=값을
// 정해진 규칙으로 찾아요. AI나 네트워크는 쓰지 않아요.
// 순서가 중요해요: 구체적인 형식부터 가리고, 마지막에 이름=값 규칙을 돌려요.
import { MARKER_PREFIX } from './marker.js';

export interface Rule {
  id: string;
  /** 가림 표시에 들어갈 종류 이름 */
  label: string;
  /** 찾기 정규식. 이름 붙은 묶음 pre / secret / post 를 쓰고, secret 자리만 가려요. 반드시 g 플래그. */
  pattern: RegExp;
  /** secret 값을 한 번 더 걸러요. false면 그 자리는 가리지 않아요. */
  accept?: (secret: string, groups: Record<string, string | undefined>) => boolean;
}

const notMarker = (s: string) => !s.includes(MARKER_PREFIX);

export const BUILTIN_RULES: Rule[] = [
  {
    id: 'private-key',
    label: '개인 키 블록',
    pattern:
      /(?<secret>-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$))/g,
  },
  {
    id: 'jwt',
    label: 'JWT',
    pattern: /(?<secret>\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g,
  },
  {
    id: 'url-password',
    label: '접속 주소 비밀번호',
    pattern: /(?<pre>\b[a-zA-Z][a-zA-Z0-9+.-]{1,20}:\/\/[^\s:/@'"`<>]{1,100}:)(?<secret>[^\s@/'"`<>]{1,200})(?<post>@)/g,
    accept: notMarker,
  },
  {
    id: 'aws-access-key',
    label: 'AWS 액세스 키',
    pattern: /(?<secret>\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})(?![A-Z0-9])/g,
  },
  {
    id: 'aws-secret-key',
    label: 'AWS 비밀 키',
    pattern: /(?<pre>\baws_?secret_?(?:access_?)?key["']?\s*[:=]\s*["']?)(?<secret>[A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
  },
  {
    id: 'github-token',
    label: 'GitHub 토큰',
    pattern: /(?<secret>\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255}))/g,
  },
  {
    id: 'gitlab-token',
    label: 'GitLab 토큰',
    pattern: /(?<secret>\bglpat-[A-Za-z0-9_-]{20,})/g,
  },
  {
    id: 'anthropic-key',
    label: 'Anthropic API 키',
    pattern: /(?<secret>\bsk-ant-[A-Za-z0-9_-]{20,})/g,
  },
  {
    id: 'openai-key',
    label: 'OpenAI API 키',
    pattern: /(?<secret>\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,})/g,
  },
  {
    id: 'google-api-key',
    label: 'Google API 키',
    pattern: /(?<secret>\bAIza[0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])/g,
  },
  {
    id: 'slack-webhook',
    label: 'Slack 웹훅 주소',
    pattern: /(?<secret>https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]{20,})/g,
  },
  {
    id: 'slack-token',
    label: 'Slack 토큰',
    pattern: /(?<secret>\b(?:xox[abposre]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,}))/g,
  },
  {
    id: 'stripe-key',
    label: 'Stripe 키',
    pattern: /(?<secret>\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{24,}))/g,
  },
  {
    id: 'npm-token',
    label: 'npm 토큰',
    pattern: /(?<secret>\bnpm_[A-Za-z0-9]{36})(?![A-Za-z0-9])/g,
  },
  {
    id: 'huggingface-token',
    label: 'Hugging Face 토큰',
    pattern: /(?<secret>\bhf_[A-Za-z0-9]{30,})/g,
  },
  {
    id: 'supabase-secret',
    label: 'Supabase 비밀 키',
    pattern: /(?<secret>\bsb_secret_[A-Za-z0-9_-]{20,})/g,
  },
  {
    id: 'basic-auth',
    label: 'Basic 인증',
    pattern: /(?<pre>\bAuthorization["']?\s*[:=]\s*["']?Basic\s+)(?<secret>[A-Za-z0-9+/]{8,}={0,2})/gi,
  },
  {
    id: 'bearer',
    label: 'Bearer 토큰',
    pattern: /(?<pre>\bBearer\s+)(?<secret>[A-Za-z0-9\-._~+/]{16,}=*)/g,
  },
];

// ---- 이름=값 규칙 ----

const SECRET_NAME_PARTS = new Set([
  'key',
  'keys',
  'secret',
  'secrets',
  'token',
  'tokens',
  'password',
  'passwords',
  'passwd',
  'pwd',
  'pass',
  'passphrase',
  'credential',
  'credentials',
  'auth',
  'apikey',
  'privatekey',
  'accesskey',
  'secretkey',
  'accesstoken',
  'authtoken',
  'refreshtoken',
  'sessiontoken',
  'clientsecret',
  'apisecret',
  'appsecret',
]);

/** 이름에 KEY·SECRET·TOKEN·PASSWORD 같은 낱말이 따로 들어 있는지 봐요. keyboard, tokenizer 같은 낱말은 아니에요. */
export function isSecretName(name: string): boolean {
  const parts = name
    .replace(/["']/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_.\-\s]+/)
    .filter(Boolean);
  return parts.some((p) => SECRET_NAME_PARTS.has(p));
}

const PLACEHOLDER_VALUES = new Set([
  'true',
  'false',
  'null',
  'nil',
  'none',
  'undefined',
  'string',
  'number',
  'boolean',
  'unknown',
  'object',
  'bigint',
  'symbol',
  'any',
  'void',
  'never',
  'str',
  'int',
  'bool',
  'bytes',
  'optional',
  'required',
  'secret',
  'password',
  'token',
  'redacted',
  'hidden',
  'masked',
  'changeme',
  'example',
  'bearer',
  'basic',
]);

/** 이름=값의 값이 실제 비밀처럼 보이는지 봐요. 자리 표시(${VAR}, <your-key>, ***)나 타입 이름은 빼요. */
export function looksLikeSecretValue(value: string, quoted: boolean): boolean {
  const v = value.trim();
  if (v.length < (quoted ? 4 : 6)) return false;
  if (v.includes(MARKER_PREFIX)) return false;
  if (PLACEHOLDER_VALUES.has(v.toLowerCase())) return false;
  if (/^(?:\$|%|\{\{|<|process\.env|os\.environ|import\.meta|env\.|secrets\.)/i.test(v)) return false;
  if (/^your[_-]/i.test(v)) return false;
  if (/^(.)\1+$/.test(v)) return false; // ****** , xxxxxx
  return true;
}

export const NAMED_SECRET_LABEL = '이름=값 비밀 줄';

/**
 * NAME=value, name: value, "name": "value" 모양을 찾아요.
 * 1: 이름 앞 따옴표, 2: 이름, 3: 구분자, 4: "값", 5: '값', 6: 따옴표 없는 값
 */
export const NAMED_SECRET_PATTERN =
  /(?<![A-Za-z0-9_.-])(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,60})\1(\s*(?::=|=|:)\s*)(?:"([^"\n]{1,300})"|'([^'\n]{1,300})'|([^\s"'`,;{}()<>[\]&]{1,300}))/g;
