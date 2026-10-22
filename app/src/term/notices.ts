// 멈춘 보관본 다시 가리기를 알리는 문장 (A16). 검사(S4)·일지 만들기와 보관(S3)·다시 가리기(S3)가 여기 문장을 나눠 써요.
// 검사(S4)는 판정과 함께 읽히는 자리라 "판정은 지금 파일 기준이에요"와 다시 검사하라는 말을 더한 전용 문장을 써요(DESIGN S4 9번).
// 화면(S1·S2)은 같은 뜻을 배너로 보여 줘요(web/redact-banner.ts).
/** 다시 가리기가 파일을 바꾸기 시작한 뒤 멈춰 다시 쓰기 기록이 남아 있을 때 (첫 두 문장) */
export const UNFINISHED_NOTICE =
  '지난번 보관본 다시 가리기가 끝나지 않아 일부 파일만 바뀐 상태일 수 있어요. 다음 cc-worklog·cc-worklog archive·cc-worklog redact 실행이 마저 끝내요.';

/** 다시 쓰기 기록이 깨져 읽을 수 없을 때 (검사·일지 만들기·보관·다시 가리기 공통 첫 문장) */
export const BROKEN_NOTICE = '다시 쓰기 기록이 깨져 자동으로 마저 끝낼 수 없어요.';

/** 깨진 기록이 뜻하는 것 (검사·일지 만들기·보관) */
export const BROKEN_WHY = '지난번 보관본 다시 가리기가 일부 파일만 바꾼 채 멈췄을 수 있어요.';

/** 깨진 기록일 때 할 일 (일지 만들기·보관) */
export const BROKEN_NEXT = 'cc-worklog redact를 다시 실행하세요. 지금 규칙으로 전체를 다시 가려 맞춰요.';

/** 일지 만들기·보관(S3)의 깨진 기록 [알림] 한 덩어리 (DESIGN S3 가·나 10번) */
export const BROKEN_FULL = `${BROKEN_NOTICE} ${BROKEN_WHY} ${BROKEN_NEXT}`;

/** 검사(S4)에서 판정 기준을 밝히는 문장 */
const CHECK_BASIS = '판정은 지금 파일 기준이에요.';

/** 검사(S4)의 확정 뒤 멈춘 기록 [알림] 한 덩어리 (DESIGN S4 9번) */
export const UNFINISHED_CHECK = `${UNFINISHED_NOTICE} ${CHECK_BASIS} 마저 끝낸 뒤 다시 검사하세요.`;

/** 검사(S4)의 깨진 기록 [알림] 한 덩어리 (DESIGN S4 9번) */
export const BROKEN_CHECK = `${BROKEN_NOTICE} ${BROKEN_WHY} ${CHECK_BASIS} cc-worklog redact를 다시 실행한 뒤 다시 검사하세요.`;
