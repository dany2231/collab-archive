// 로컬 미리보기용 정적 서버. index.html이 fetch로 JSON을 읽기 때문에 file://로는 열리지 않는다.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const SITE = resolve(import.meta.dirname, '../site');
const PORT = Number(process.env.PORT) || 4173;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

createServer(async (request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = resolve(SITE, '.' + (path.endsWith('/') ? path + 'index.html' : path));
  if (file !== SITE && !file.startsWith(SITE + sep)) { response.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': `${TYPES[extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'cache-control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
