/**
 * Plain-HTTP capture server: logs every request (method, path, headers, body)
 * to a JSONL file and answers with a minimal SSE stream.
 *
 * Usage: node capture_server.js <port> <out.jsonl>
 */
const fs = require('node:fs');
const http = require('node:http');

const PORT = Number(process.argv[2] || 8888);
const OUT = process.argv[3] || '/tmp/opencode/qoder/capture.jsonl';

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    fs.appendFileSync(
      OUT,
      JSON.stringify({
        t: new Date().toISOString(),
        method: req.method,
        path: req.url,
        headers: req.headers,
        body,
      }) + '\n');
    console.error(`[capture] ${req.method} ${req.url} body=${body.length}B`);

    if (req.url.includes('/ping')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.url.includes('/region/endpoints')) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"code":"500"}');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'close',
    });
    res.write('data: {"body":"{\\"type\\":\\"text\\",\\"data\\":\\"ok\\"}"}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[capture] listening on http://127.0.0.1:${PORT} -> ${OUT}`);
});
