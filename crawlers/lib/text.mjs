const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// 목록 API가 주는 본문 HTML을 키워드 매칭용 텍스트로 바꾼다.
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity, code) => {
      if (code[0] === '#') return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
      return ENTITIES[code.toLowerCase()] ?? entity;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// 호요랩 리치 텍스트 게시물은 본문이 structured_content(Quill delta JSON)에만 있다.
// 이때 content 필드에는 언어 코드만 들어 있어 쓸 수 없다.
export function structuredText(structured) {
  const raw = String(structured ?? '').trim();
  if (!raw) return '';
  let rows;
  try { rows = JSON.parse(raw); } catch { return ''; }
  if (!Array.isArray(rows)) return '';
  return rows
    .map(row => (typeof row?.insert === 'string' ? row.insert : ''))
    .join('')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}
