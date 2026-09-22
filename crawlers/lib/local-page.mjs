import { createServer } from 'node:http';

// 기사 본문을 API로 받는 사이트는 원문 페이지를 열 수 없거나(SPA 렌더 실패) 느릴 수 있다.
// 받아 둔 제목과 본문을 로컬 페이지로 만들어 Chrome 번역에 태운다. lang 선언이 있어야 번역 언어가 잡힌다.
export async function serveArticles(lang) {
  const articles = new Map();
  const server = createServer((request, response) => {
    const id = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.replace(/^\/a\//, ''));
    const article = articles.get(id);
    if (!article) { response.writeHead(404).end('unknown article'); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${article.title}</title></head>`
      + `<body><h1 id="title">${article.title}</h1><div id="content">${article.html}</div></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    // title은 텍스트, html은 기사 본문 HTML
    url(id, article) { articles.set(String(id), article); return `http://127.0.0.1:${port}/a/${encodeURIComponent(id)}`; },
    close() { server.close(); },
  };
}
