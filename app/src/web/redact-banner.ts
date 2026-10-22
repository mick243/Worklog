// S1·S2 공통: 멈춘 보관본 다시 가리기 배너 (A16, DESIGN 공통 "다시 가리기 배너").
// 화면은 읽기만 해서 마저 끝내지 않아요. 페이지를 만들 때 데이터 폴더의 다시 쓰기 기록 상태만 보고(쓰지 않아요) 고정 글로 알려요.
// 페이지에 스크립트가 없어서, 화면을 연 뒤에 마무리돼도 이 배너는 페이지를 새로 열 때까지 남아 있어요.
// 모양은 기존 배너 클래스(banner banner--warning, 삭제 임박 배너와 같은 색)만 써요. 새 클래스·모양 기호는 없어요.
// 줄마다 따로 써요: 1줄 이름표 + 상태 문장, <br> 뒤 2줄 명령 문장(명령은 고정폭).
import type { PendingNotice } from '../redact/journal.js';
import { BROKEN_NOTICE } from '../term/notices.js';
import { html, type Html } from './html.js';

export interface RedactBannerCommands {
  makeCommand: string;
  archiveCommand: string;
  redactCommand?: string;
}

export function redactBanner(state: PendingNotice | undefined, c: RedactBannerCommands): Html | null {
  const redact = c.redactCommand ?? 'cc-worklog redact';
  if (state === 'unfinished') {
    return html`<div class="banner banner--warning" role="status"><strong class="banner__title">다시 가리기 덜 끝남</strong>
지난번 보관본 다시 가리기가 끝나지 않아 일부 파일만 바뀐 상태일 수 있어요. 아직 바뀌지 않은 일지에는 놓친 비밀 값이 가림 표시 없이 보일 수 있어요.
<br>터미널에서 <code>${c.makeCommand}</code>·<code>${c.archiveCommand}</code>·<code>${redact}</code> 중 하나를 실행하면 마저 끝내요. 마저 끝낸 뒤 페이지를 새로 열면 이 알림이 사라져요.</div>`;
  }
  if (state === 'broken') {
    return html`<div class="banner banner--warning" role="status"><strong class="banner__title">다시 가리기 기록 깨짐</strong>
${BROKEN_NOTICE} 지난번 보관본 다시 가리기가 일부 파일만 바꾼 채 멈췄을 수 있어서, 아직 바뀌지 않은 일지에는 놓친 비밀 값이 가림 표시 없이 보일 수 있어요.
<br>터미널에서 <code>${redact}</code>를 다시 실행하세요. 지금 규칙으로 전체를 다시 가려 맞춰요. 다시 가린 뒤 페이지를 새로 열면 이 알림이 사라져요.</div>`;
  }
  return null;
}
