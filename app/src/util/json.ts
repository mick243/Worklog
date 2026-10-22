// 사람이 손으로 고칠 수 있는 JSON 파일 읽기 도우미예요.
// Windows PowerShell 5.1(Out-File -Encoding utf8)·메모장 등은 UTF-8 파일 맨 앞에 BOM(U+FEFF)을 붙여 저장해요.
// JSON.parse는 BOM을 받지 않아서, 내용이 올바른데도 "올바른 JSON이 아니에요"가 돼요(시나리오 실행 X-01, PRD 5장).
// 그래서 config.json·patterns.json·Claude Code settings.json·보관 색인·화면용 일지 데이터를 읽을 때는 맨 앞 BOM 하나를 떼고 읽어요.

/** 맨 앞의 UTF-8 BOM(U+FEFF) 하나를 떼요. 다른 곳의 글자는 건드리지 않아요. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 맨 앞 BOM을 뗀 뒤 JSON으로 읽어요. 올바르지 않으면 JSON.parse처럼 던져요. */
export function parseJsonText(text: string): unknown {
  return JSON.parse(stripBom(text));
}
