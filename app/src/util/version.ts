// 패키지 버전을 package.json에서 읽어요.
import { readFileSync } from 'node:fs';

let cached: string | null = null;

export function toolVersion(): string {
  if (cached) return cached;
  try {
    // dist/src/util/version.js → 패키지 맨 위 package.json
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: string };
    cached = pkg.version ?? '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
