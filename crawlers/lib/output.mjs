import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// OneDrive 폴더에서는 동기화 중인 파일을 덮어쓸 때 rename이 EPERM으로 실패한다.
// 몇 번 기다렸다 다시 시도하고, 그래도 안 되면 직접 쓴다. 긴 크롤링이 저장 한 번에 죽지 않게 한다.
export async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const text = JSON.stringify(value, null, 2) + '\n';
  await writeFile(file + '.tmp', text);
  for (let attempt = 1; ; attempt++) {
    try { return await rename(file + '.tmp', file); }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      if (attempt >= 5) return writeFile(file, text);
      await new Promise(done => setTimeout(done, 500 * attempt));
    }
  }
}

export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function csv(rows, columns) {
  const escape = value => {
    let text = String(value ?? '');
    // Prevent spreadsheet applications from interpreting article text as formulas.
    if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return '﻿' + [columns, ...rows.map(row => columns.map(key => row[key]))]
    .map(row => row.map(escape).join(',')).join('\r\n') + '\r\n';
}

// "2026/07/30" -> "2026-07-30"
export function isoDate(text) {
  const match = String(text ?? '').match(/(\d{4})[/.\-년]\s*(\d{1,2})[/.\-월]\s*(\d{1,2})/);
  return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : '';
}

// data/candidates/{game}.json은 여러 언어 크롤링 결과를 합친 파일이라, 이번 locale 행만 교체한다.
export async function mergeCandidates(file, locale, rows) {
  const existing = await readJson(file, []);
  const merged = [...existing.filter(row => row.locale !== locale), ...rows]
    .sort((a, b) => b.date.localeCompare(a.date) || a.url.localeCompare(b.url));
  await writeJson(file, merged);
}
