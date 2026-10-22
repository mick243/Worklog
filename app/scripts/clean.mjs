// dist 폴더를 지워서 지난 빌드의 남은 파일이 섞이지 않게 해요.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

rmSync(fileURLToPath(new URL('../dist', import.meta.url)), { recursive: true, force: true });
