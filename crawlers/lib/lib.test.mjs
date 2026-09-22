import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchArticle } from './keywords.mjs';
import { csv, isoDate } from './output.mjs';
import { htmlToText, structuredText } from './text.mjs';

test('matches collaboration keywords in Korean, Japanese and English', () => {
  assert.equal(matchArticle(['COLLABORATION!'], '').matched_in, 'title');
  assert.equal(matchArticle(['News'], 'A collab with Razer.').matched_in, 'body');
  assert.equal(matchArticle(['Collaboration'], 'collaborations').matched_in, 'title and body');
  assert.equal(matchArticle(['お知らせ'], '限定コラボカフェ開催').keyword, 'コラボ');
  assert.equal(matchArticle(['공지'], '레이저와의 콜라보레이션 굿즈').keyword, '콜라보');
  assert.equal(matchArticle(['《原神》×肯德基联动活动'], '').keyword, '×');
  assert.equal(matchArticle(['公告'], '本次联动活动开启').keyword, '联动');
  for (const word of ['collaborative', 'precollaboration', 'collaboration2', 'écollaboration']) {
    assert.equal(matchArticle([word], word).matched, false);
  }
});

test('title matches are high confidence and body-only matches are low', () => {
  assert.equal(matchArticle(['Zenless Zone Zero × Kyuramen'], '').confidence, 'high');
  assert.equal(matchArticle(['Razer x ZZZ'], '').confidence, 'high');
  assert.equal(matchArticle(['『ゼンレスゾーンゼロ』×『崩壊：スターレイル』'], '').keyword, '×');
  assert.equal(matchArticle(['Web event'], 'Razer collaboration merch').confidence, 'low');
});

test('multiplication signs only count in titles, next to letters', () => {
  assert.equal(matchArticle(['Polychrome ×480'], '').matched, false);
  assert.equal(matchArticle(['Event'], 'Brand × Game').matched, false);
});

test('CSV preserves quotes, commas and line breaks and neutralizes formulas', () => {
  const output = csv([{ title: '=SUM(1,2)', excerpt: 'a "quote",\nand newline' }], ['title', 'excerpt']);
  assert.ok(output.startsWith('﻿'));
  assert.ok(output.includes('"\'=SUM(1,2)"'));
  assert.ok(output.includes('"a ""quote"",\nand newline"'));
});

test('htmlToText strips tags and decodes entities', () => {
  assert.equal(htmlToText('<p>A&nbsp;&amp;&#x42;</p><p>コラボ<br>開催</p><script>x</script>'), 'A &B\nコラボ\n開催');
});

test('isoDate normalizes listing, API and Korean dates', () => {
  assert.equal(isoDate('2026/07/30'), '2026-07-30');
  assert.equal(isoDate('2026-09-16 18:00:00'), '2026-09-16');
  assert.equal(isoDate('2026년 8월 1일'), '2026-08-01');
  assert.equal(isoDate(''), '');
});

test('alias terms find partner names without a collaboration keyword', () => {
  const match = matchArticle(['「카프카」와 「블레이드」, ≪포트나이트≫에 강하'], '', ['포트나이트']);
  assert.equal(match.matched_in, 'title');
  assert.equal(match.keyword, '포트나이트');
  // 이름만 걸린 기사는 콜라보 표현이 걸린 기사와 구분한다.
  assert.equal(match.confidence, 'alias');
  assert.equal(matchArticle(['콜라보 안내'], '', ['포트나이트']).confidence, 'high');
  // 라틴 문자 별칭은 단어 경계를 요구한다.
  assert.equal(matchArticle(['Keeping up with the update'], '', ['Keep']).matched, false);
  assert.equal(matchArticle(['Keep is a brand'], '', ['Keep']).keyword, 'Keep');
  // 본문에만 있는 이름은 무시한다. 이벤트 안내 본문에는 브랜드 이름이 늘 나열된다.
  assert.equal(matchArticle(['3.6 버전 프리뷰'], '생방송 인센티브: 더우인, 후야', ['더우인']).matched, false);
});

test('structuredText reads Quill delta bodies and ignores broken input', () => {
  const delta = JSON.stringify([{ insert: { image: 'x.jpg' } }, { insert: '콜라보\n\n안내' }]);
  assert.equal(structuredText(delta), '콜라보\n안내');
  assert.equal(structuredText('ko-kr'), '');
  assert.equal(structuredText(null), '');
});
