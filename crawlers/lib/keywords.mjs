// 번역된 한국어와 원문(영어/일본어) 표현을 모두 찾는다. 오탐은 검토 단계에서 거른다.
const PATTERNS = [
  /콜라보|컬래버|협업|제휴|크로스오버|타이업/u,
  /コラボ|タイアップ/u,
  // 중국어: 联动이 가장 흔하고, 联名·跨界는 브랜드 협업 표기다.
  /联动|聯動|联名|聯名|跨界合作|合作款/u,
  /(?<![\p{L}\p{N}_])(?:collabs?|collaborations?|crossover|tie-in)(?![\p{L}\p{N}_])/iu,
];
// "A × B", "A x B" 형태는 제목에서만 본다. 본문에서는 "×480" 같은 수량 표기와 섞인다.
const TITLE_ONLY = [
  /(?<=[\p{L}\p{N}\p{Pe}\p{Pf}]\s*)×(?=\s*[\p{L}\p{Ps}\p{Pi}])/u,
  /(?<=[\p{L}\p{N}\p{Pe}\p{Pf}]\s+)[xX](?=\s+[\p{L}\p{Ps}\p{Pi}])/u,
];

function firstMatch(text, patterns) {
  let best = null;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && (!best || match.index < best.index)) best = { index: match.index, keyword: match[0] };
  }
  return best;
}

const LATIN = /^[ -~]+$/u;
const WORD = /[\p{L}\p{N}]/u;

// 별칭은 정규식을 만들지 않고 문자열로 찾는다. 라틴 문자 별칭은 앞뒤가 글자가 아닐 것을
// 요구해서 "Keep"이 keeping에 걸리는 식의 오탐을 막는다. firstMatch가 쓰는 exec 형태로 돌려준다.
function aliasMatch(text, extra) {
  const haystack = text.toLowerCase();
  let best = null;
  for (const term of extra) {
    const needle = term.toLowerCase();
    const bounded = LATIN.test(term);
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
      if (bounded && (WORD.test(text[at - 1] ?? '') || WORD.test(text[at + term.length] ?? ''))) continue;
      if (!best || at < best.index) best = Object.assign([term], { index: at });
      break;
    }
  }
  return best;
}

// extra는 이미 확인된 콜라보 상대의 원문 표기다. 키워드 없이 상대 이름만 적은 공지를 잡는 데 쓴다.
// 상대 이름만 걸린 기사는 콜라보 표현이 걸린 기사와 섞지 않고 confidence를 'alias'로 표시한다.
// 브랜드 이름이 게임 안의 고유명사와 겹치는 일이 많아서다 (예: 「갤럭시 레인저」는 게임 내 조직).
export function matchArticle(titles, body, extra = []) {
  const title = titles.filter(Boolean).join(' / ').replace(/\s+/g, ' ').trim();
  const text = String(body ?? '').replace(/\s+/g, ' ').trim();
  const titleMatch = firstMatch(title, [...PATTERNS, ...TITLE_ONLY]);
  const bodyMatch = firstMatch(text, PATTERNS);
  // 별칭은 제목에서만 본다. 본문에는 이벤트 안내마다 플랫폼·브랜드 이름이 나열돼 오탐이 쏟아진다.
  const alias = titleMatch || bodyMatch || !extra.length ? null : aliasMatch(title, extra);
  const source = alias ? title : bodyMatch ? text : title;
  const hit = alias ? { index: alias.index, keyword: alias[0] } : bodyMatch || titleMatch;
  return {
    matched: Boolean(hit),
    matched_in: alias ? 'title'
      : titleMatch && bodyMatch ? 'title and body' : titleMatch ? 'title' : bodyMatch ? 'body' : '',
    keyword: hit?.keyword.trim() || '',
    // 제목에 걸린 기사는 실제 콜라보 공지일 가능성이 높다.
    confidence: alias ? 'alias' : titleMatch ? 'high' : bodyMatch ? 'low' : '',
    excerpt: hit ? source.slice(Math.max(0, hit.index - 100), hit.index + 180) : '',
  };
}
