// Local preview server: builds dist/, serves it, and rebuilds when
// questions/, src/ or site.config.json change (polling, so it also works on
// Docker bind mounts).

import http from 'node:http';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(ROOT, 'dist');
const WATCH = ['questions', 'src', 'site.config.json'].map((p) => path.join(ROOT, p));
const PORT = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

async function safeBuild() {
  try {
    await build({ dev: true });
  } catch (e) {
    console.error('Build failed:', e);
  }
}

async function signature(target) {
  let st;
  try {
    st = await stat(target);
  } catch {
    return '';
  }
  if (!st.isDirectory()) return `${target}:${st.mtimeMs}:${st.size};`;
  let sig = '';
  for (const name of (await readdir(target)).sort()) sig += await signature(path.join(target, name));
  return sig;
}

async function watch() {
  let last = (await Promise.all(WATCH.map(signature))).join('|');
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = (await Promise.all(WATCH.map(signature))).join('|');
    if (now !== last) {
      last = now;
      console.log('Change detected, rebuilding...');
      await safeBuild();
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.join(DIST_DIR, pathname);
    if (!file.startsWith(DIST_DIR + path.sep)) throw Object.assign(new Error('forbidden'), { code: 'ENOENT' });
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' || e.code === 'EISDIR' ? 404 : 500, { 'Content-Type': 'text/plain' });
    res.end(e.code === 'ENOENT' || e.code === 'EISDIR' ? 'Not found' : String(e));
  }
});

await safeBuild();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Preview: http://localhost:${PORT}/  (Ctrl+C to stop)`);
});
watch();
