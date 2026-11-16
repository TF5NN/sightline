// A tiny file server for the tests. It answers "give me bytes X to Y of this
// file" requests, which is how the app reads small pieces of big terrain files.
import { createServer } from 'node:http';
import { open, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';

export async function startServer(rootDir) {
  const log = [];
  const server = createServer(async (req, res) => {
    const path = normalize(join(rootDir, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!path.startsWith(normalize(rootDir))) {
      res.writeHead(403).end();
      return;
    }
    let info;
    try {
      info = await stat(path);
    } catch {
      // The real storage answers 403 for files that do not exist.
      log.push({ url: req.url, status: 403 });
      res.writeHead(403).end('AccessDenied');
      return;
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] !== '' ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    const length = end - start + 1;
    const handle = await open(path, 'r');
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    await handle.close();
    log.push({ url: req.url, status: range ? 206 : 200, bytes: length });
    res.writeHead(range ? 206 : 200, {
      'Content-Length': length,
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
    });
    res.end(buffer);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    log,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
