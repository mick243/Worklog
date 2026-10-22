// 검사 명령(S4)이 쓰는 내장 가짜 비밀 값 모음이에요.
// 모두 형식만 흉내 낸 가짜 값이고, 진짜 키가 아니에요.
// 소스 파일에 키 모양 글자가 통째로 들어가지 않게(비밀 값 스캐너가 오해하지 않게) 조각을 이어 붙여 만들어요.

export interface Sample {
  ruleId: string;
  /** 이 값이 가려진 뒤 남아야 하는 종류 이름 */
  label: string;
  /** 가짜 비밀 값이 든 문장 */
  text: string;
  /** 가려져서 사라져야 하는 부분 */
  secret: string;
}

const j = (...parts: string[]) => parts.join('');
const rep = (s: string, n: number) => s.repeat(n);

/** 가짜 비밀 값들. 시험(test)에서도 이 값을 써요. */
export function fakeSecrets() {
  return {
    privateKey: j('-----BEGIN', ' RSA PRIVATE', ' KEY-----\n', 'MIIE', rep('FaKe', 10), '\n', rep('a1B2', 16), '\n-----END', ' RSA PRIVATE', ' KEY-----'),
    jwt: j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiJmYWtlLXVzZXIifQ', '.', rep('ZmFrZVNpZw', 3)),
    urlPassword: j('Fa', 'ke-', 'Pa55', 'word'),
    awsAccessKey: j('AK', 'IA', 'FAKE', rep('7Q', 6)),
    awsSecretKey: j(rep('fAkE/kEy+', 4), 'AbCd'),
    githubToken: j('gh', 'p_', rep('Fk3x', 9)),
    githubPat: j('github', '_pat_', rep('Fk3x9', 6)),
    gitlabToken: j('gl', 'pat-', rep('fK9-', 5)),
    anthropicKey: j('sk-', 'ant-', 'api03-', rep('Fk9_', 20)),
    openaiKey: j('sk-', 'proj-', rep('FkAb12', 8)),
    googleKey: j('AI', 'za', 'Sy', rep('Fk3_', 8), 'x'),
    slackWebhook: j('https://hooks.', 'slack.com/services/', 'T0FAKE00/B0FAKE00/', rep('fAkE', 6)),
    slackToken: j('xo', 'xb-', '1234567890-', rep('FakeTok', 3)),
    stripeKey: j('sk', '_live_', rep('Fk3', 8)),
    npmToken: j('np', 'm_', rep('Fk3x', 9)),
    hfToken: j('h', 'f_', rep('FkAb', 9)),
    supabaseKey: j('sb_', 'secret_', rep('Fk3x', 6)),
    basicAuth: j('ZmFrZTpm', 'YWtlLXBhc3M='),
    bearer: rep('fAkE.t0k-', 3),
    dbPassword: j('hunt', 'er2-', 'fake'),
    jsonApiKey: j('fake', '-api-', 'value-', '0042'),
  };
}

export function builtinSamples(): Sample[] {
  const f = fakeSecrets();
  return [
    { ruleId: 'private-key', label: '개인 키 블록', text: `키 파일 내용:\n${f.privateKey}`, secret: f.privateKey },
    { ruleId: 'jwt', label: 'JWT', text: `응답 토큰은 ${f.jwt} 였어요`, secret: f.jwt },
    {
      ruleId: 'url-password',
      label: '접속 주소 비밀번호',
      text: `DATABASE_URL=postgres://app:${f.urlPassword}@db.example.local:5432/app`,
      secret: f.urlPassword,
    },
    { ruleId: 'aws-access-key', label: 'AWS 액세스 키', text: `access key id ${f.awsAccessKey} 로 접속`, secret: f.awsAccessKey },
    { ruleId: 'aws-secret-key', label: 'AWS 비밀 키', text: `aws_secret_access_key = ${f.awsSecretKey}`, secret: f.awsSecretKey },
    { ruleId: 'github-token', label: 'GitHub 토큰', text: `토큰은 ${f.githubToken} 이에요`, secret: f.githubToken },
    { ruleId: 'gitlab-token', label: 'GitLab 토큰', text: `glab auth ${f.gitlabToken}`, secret: f.gitlabToken },
    { ruleId: 'anthropic-key', label: 'Anthropic API 키', text: `키: ${f.anthropicKey}`, secret: f.anthropicKey },
    { ruleId: 'openai-key', label: 'OpenAI API 키', text: `openai 키 ${f.openaiKey}`, secret: f.openaiKey },
    { ruleId: 'google-api-key', label: 'Google API 키', text: `maps key ${f.googleKey}`, secret: f.googleKey },
    { ruleId: 'slack-webhook', label: 'Slack 웹훅 주소', text: `웹훅 ${f.slackWebhook} 로 보내요`, secret: f.slackWebhook },
    { ruleId: 'slack-token', label: 'Slack 토큰', text: `slack bot ${f.slackToken}`, secret: f.slackToken },
    { ruleId: 'stripe-key', label: 'Stripe 키', text: `stripe ${f.stripeKey}`, secret: f.stripeKey },
    { ruleId: 'npm-token', label: 'npm 토큰', text: `//registry.npmjs.org/:_authToken ${f.npmToken}`, secret: f.npmToken },
    { ruleId: 'huggingface-token', label: 'Hugging Face 토큰', text: `hf login ${f.hfToken}`, secret: f.hfToken },
    { ruleId: 'supabase-secret', label: 'Supabase 비밀 키', text: `supabase ${f.supabaseKey}`, secret: f.supabaseKey },
    { ruleId: 'basic-auth', label: 'Basic 인증', text: `Authorization: Basic ${f.basicAuth}`, secret: f.basicAuth },
    { ruleId: 'bearer', label: 'Bearer 토큰', text: `curl -H "Authorization: Bearer ${f.bearer}"`, secret: f.bearer },
    { ruleId: 'named-secret', label: '이름=값 비밀 줄', text: `DB_PASSWORD=${f.dbPassword}`, secret: f.dbPassword },
  ];
}

/** 가려지면 안 되는 값들 (커밋 해시, 파일 경로, 아이디, 일반 문장) */
export function negativeSamples(): Array<{ what: string; text: string }> {
  return [
    { what: '커밋 해시', text: `커밋 ${rep('a3f5', 10)} 와 짧은 해시 a3f5c9d` },
    { what: '파일 경로 (Windows)', text: 'C:\\Users\\dev\\project\\src\\keys\\token-store.ts 를 고쳤어요' },
    { what: '파일 경로 (macOS·Linux)', text: '/home/dev/app/config/secret-manager.ts, /Users/dev/app/key.ts' },
    { what: '세션 아이디', text: 'session 123e4567-e89b-12d3-a456-426614174000' },
    { what: '일반 문장', text: '로그인 토큰 만료 처리를 고쳤어요. Fix token refresh when the API key rotates.' },
    { what: '코드 조각', text: 'const keyboard = new Keyboard(); primaryKey: true, tokenizer=cl100k' },
  ];
}
