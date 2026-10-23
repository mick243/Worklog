// 사용법 오류 문구 (PRD A1·A22). 옵션 오류는 모두 이 도구가 정한 한국어 문구로 보여 주고, Node·라이브러리의 영어 원문은 넣지 않아요.
// 보여 주는 것은 사용자가 쓴 옵션 이름 그대로(--form, -x)와 모르는 명령뿐이에요. 옵션 값(--옵션=값의 값, 옵션 다음 인자)은
// 경로 속 사용자 이름이나 비밀 값이 들어 있을 수 있어서 넣지 않아요. 모양은 [실패] 한 줄 + `다음: cc-worklog --help …`, 종료 코드 1이에요.
// 문구는 DESIGN에 정해지면 여기만 바꾸면 돼요(cli.ts·args.ts는 이 함수만 불러요).

/** 사용법 오류의 다음: 줄 (지금 사용법 오류와 같아요) */
export const USAGE_NEXT = 'cc-worklog --help 로 사용법을 확인하세요.';

export const usageText = {
  /** 모르는 옵션 (사용자가 쓴 이름 그대로, 예: --form, -x) */
  unknownOption: (raw: string) => `모르는 옵션이에요: ${raw}`,
  /** 값이 필요한데 빠진 옵션 (옵션 다음 인자가 없거나 다른 옵션처럼 -로 시작해요) */
  missingValue: (raw: string) => `${raw} 옵션에 값이 없어요`,
  /** 값을 받지 않는 옵션에 값을 줌 (--hide-identity=yes 등). 준 값은 보여 주지 않아요. */
  noValueAllowed: (raw: string) => `${raw} 옵션은 값을 받지 않아요`,
  /** 모르는 명령. 명령 이름처럼 생긴 글자만 보여 줘요. */
  unknownCommand: (command: string) => `모르는 명령이에요: ${command}`,
  /** 모르는 명령인데 경로·값처럼 생겨서(옵션 이름을 빠뜨린 경우 등) 글자를 보여 주지 않아요 */
  unknownCommandHidden: '모르는 명령이에요. 옵션 이름 없이 값만 준 것 같아요 (값은 보여 주지 않아요)',
  /** 명령 뒤에 남는 인자 (값일 수 있어 글자는 보여 주지 않아요) */
  extraArgs: (n: number) => `명령 뒤에 남는 인자가 ${n}개 있어요 (값은 보여 주지 않아요)`,
  /** 옵션을 읽다 예상 못 한 문제 (원문 없이) */
  unreadable: '옵션을 읽지 못했어요',

  // 잘못된 값: 값 없이 받는 모양만 알려요(A22).
  badDate: (name: '--date' | '--from' | '--to') => `${name}${name === '--from' ? '은' : '는'} YYYY-MM-DD, today, yesterday 중 하나여야 해요`,
  badDayStart: '--day-start는 0~23 사이 정수여야 해요',
  badPort: '--port는 0~65535 사이 정수여야 해요',
  /** --from이 --to보다 늦음 (뒤집힌 기간) */
  reversedRange: '--from 날짜가 --to 날짜보다 늦어요',

  // 그 명령에서 받지 않거나 함께 쓸 수 없는 옵션 (A16·A18·A24)
  yesOnlyRedact: '--yes는 redact 명령에서만 써요',
  /** --summary를 일지 만들기가 아닌 명령에 줌 (A24). 보관만 하고 요약했다고 오해하지 않게 멈춰요. */
  summaryOnlyMake: '--summary는 일지 만들기(cc-worklog, cc-worklog make)에서만 써요',
  rangeOnlyMake: '--from·--to는 일지 만들기(cc-worklog, cc-worklog make)에서만 써요',
  dateWithRange: '--date와 --from·--to는 함께 쓸 수 없어요',
  toWithoutFrom: '--to는 --from과 함께 써야 해요',
} as const;

/** 명령 이름처럼 생긴 글자인지 (영문자로 시작하는 짧은 낱말). 아니면 경로·값일 수 있어 보여 주지 않아요. */
export function looksLikeCommandWord(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(s);
}
