// 로컬 화면이 쓰는 CSS 파일을 dist로 복사해요. (tsc는 .css를 옮기지 않아요)
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../src/styles', import.meta.url));
const to = fileURLToPath(new URL('../dist/src/styles', import.meta.url));
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
