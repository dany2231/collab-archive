// npm run crawl -- --game zenless [크롤러 옵션...]
// --game을 생략하면 data/games.json의 모든 게임을 순서대로 실행한다.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJson } from '../crawlers/lib/output.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const index = args.indexOf('--game');
const only = index >= 0 ? args.splice(index, 2)[1] : null;
const games = (await readJson(resolve(ROOT, 'data/games.json'), [])).map(game => game.id);
if (only && !games.includes(only)) throw new Error(`Unknown game: ${only}. Add it to data/games.json.`);

let failed = false;
for (const game of only ? [only] : games) {
  const crawler = resolve(ROOT, 'crawlers/games', game, 'crawler.mjs');
  if (!existsSync(crawler)) { console.error(`Missing crawler: ${crawler}`); failed = true; continue; }
  console.log(`\n=== ${game} ===`);
  // 번역 확인용 Enter 입력을 받아야 하므로 stdin을 그대로 넘긴다.
  const { status } = spawnSync(process.execPath, [crawler, ...args], { stdio: 'inherit' });
  if (status !== 0) failed = true;
}
if (failed) process.exitCode = 1;
