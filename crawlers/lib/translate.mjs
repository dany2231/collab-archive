import readline from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { readJson } from './output.mjs';

// Puppeteer는 기본으로 --disable-features=Translate를 넘긴다. 이 인자로 다시 켜고 번역 대상을 한국어로 둔다.
// 언어 감지 모델 다운로드를 막는 기본 인자도 풀어 둔다. 이것만으로는 SPA의 "und" 판정이 해결되지 않아 declarePageLanguage가 필요하다.
export const TRANSLATE_ARGS = ['--enable-features=Translate,OptimizationHints', '--lang=ko-KR'];
export const TRANSLATE_IGNORE_DEFAULT_ARGS = ['--disable-component-update', '--disable-background-networking'];

// SPA는 Chrome이 언어를 판정하는 시점에 본문이 비어 있어 "und"(알 수 없음)가 된다.
// 그러면 "항상 번역"이 적용되지 않으므로, lang 속성이 없는 페이지에 원문 언어를 미리 선언한다.
export function declarePageLanguage(page, lang) {
  return page.evaluateOnNewDocument(lang => {
    const apply = () => {
      if (document.documentElement && !document.documentElement.lang) document.documentElement.lang = lang;
    };
    apply();
    document.addEventListener('readystatechange', apply);
    document.addEventListener('DOMContentLoaded', apply);
  }, lang);
}

// 크롤링 전용 프로필에 "항상 한국어로 번역"을 미리 기록한다. Chrome이 이 프로필로 실행 중이 아닐 때만 호출한다.
export async function enableAlwaysTranslate(profileDir, lang) {
  const file = resolve(profileDir, 'Default', 'Preferences');
  const prefs = await readJson(file, {});
  prefs.translate = { ...prefs.translate, enabled: true };
  prefs.translate_allowlists = { ...prefs.translate_allowlists, [lang]: 'ko' };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(prefs));
}

export function isTranslated(page) {
  return page.evaluate(() => /\btranslated-(ltr|rtl)\b/.test(document.documentElement.className));
}

async function ask(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(message); } finally { rl.close(); }
}

export async function promptTranslation(page, reason) {
  await page.bringToFront();
  console.log(`\n${reason}`);
  console.log('브라우저에서 이 페이지를 한국어로 번역해주세요. (주소창 오른쪽 번역 아이콘 → 한국어)');
  for (;;) {
    const answer = await ask('번역을 켠 뒤 Enter를 눌러주세요 (감지 없이 진행하려면 skip 입력): ');
    if (answer.trim().toLowerCase() === 'skip' || await isTranslated(page)) return;
    console.warn('번역이 감지되지 않았습니다 (translated-ltr 없음). 번역이 적용됐는지 확인해주세요.');
  }
}

// 페이지 이동 직후에는 Chrome이 번역을 다시 적용하기 전일 수 있어 잠시 기다린다.
export async function waitForTranslatedClass(page, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await isTranslated(page)) return true;
    await sleep(250);
  }
  return false;
}

// 제목만 한국어가 된 상태에서 저장하지 않도록, 본문까지 한글 비율이 기준을 넘고 텍스트가 더 이상 바뀌지 않을 때까지 기다린다.
export async function waitForTranslation(page, selector, { timeout = 20000, minRatio = 0.3 } = {}) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const start = Date.now();
  let previous = null;
  let last = { ratio: 0 };
  while (Date.now() - start < timeout) {
    await sleep(700);
    last = await page.evaluate(sel => {
      const text = document.querySelector(sel)?.innerText || '';
      const letters = text.match(/\p{L}/gu)?.length || 0;
      const hangul = text.match(/[가-힣]/g)?.length || 0;
      return { text, letters, ratio: letters ? hangul / letters : 1 };
    }, selector);
    // 이미지 위주 기사처럼 글자가 거의 없으면 비율 대신 안정 여부만 본다.
    const enough = last.letters < 30 || last.ratio >= minRatio;
    if (enough && last.text === previous) {
      await page.evaluate(() => window.scrollTo(0, 0));
      return { ok: true, ratio: last.ratio };
    }
    previous = last.text;
  }
  return { ok: false, ratio: last.ratio };
}
