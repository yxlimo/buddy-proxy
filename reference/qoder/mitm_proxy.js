/**
 * Minimal MITM HTTPS proxy: handles CONNECT, terminates TLS with a local cert,
 * logs the request (method/path/headers/body) to a JSONL file, and answers
 * with a canned response.
 *
 * Usage: node mitm_proxy.js <port> <out.jsonl> <mode>
 *   mode = "sse"   -> 200 text/event-stream with one chunk
 *   mode = "json"  -> 200 application/json {"ok":true}
 */
const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');

const PORT = Number(process.argv[2] || 8888);
const OUT = process.argv[3] || '/tmp/opencode/mitm/capture.jsonl';
const MODE = process.argv[4] || 'sse';
const KEY = fs.readFileSync('/tmp/opencode/mitm/srv.key');
const CERT = fs.readFileSync('/tmp/opencode/mitm/srv.pem');

function log(obj) {
  fs.appendFileSync(OUT, JSON.stringify(obj) + '\n');
}

const server = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf('\r\n\r\n');
    if (idx < 0) return;
    sock.off('data', onData);
    const head = buf.slice(0, idx).toString('utf8');
    const lines = head.split('\r\n');
    const reqLine = lines[0];
    const headers = {};
    for (const l of lines.slice(1)) {
      const i = l.indexOf(':');
      if (i > 0) headers[l.slice(0, i).toLowerCase().trim()] = l.slice(i + 1).trim();
    }
    const [method, target] = reqLine.split(' ');
    const host = headers['host'] || target;
    log({ t: 'connect', method, target, host, headers });

    if (method !== 'CONNECT') { sock.end(); return; }

    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    const tlsSock = new tls.TLSSocket(sock, { isServer: true, key: KEY, cert: CERT });
    tlsSock.on('error', (e) => log({ t: 'tls-error', host, error: String(e) }));
    tlsSock.on('secure', () => {
      let b = Buffer.alloc(0);
      tlsSock.on('data', (c) => {
        b = Buffer.concat([b, c]);
        const i = b.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = b.slice(0, i).toString('utf8');
        const hl = head.split('\r\n');
        const h = {};
        for (const l of hl.slice(1)) {
          const j = l.indexOf(':');
          if (j > 0) h[l.slice(0, j).toLowerCase().trim()] = l.slice(j + 1).trim();
        }
        const contentLength = Number(h['content-length'] || 0);
        let body = b.slice(i + 4).toString('utf8');
        const need = contentLength - Buffer.byteLength(body);
        if (need > 0) {
          tlsSock.once('data', (more) => { body += more.toString('utf8'); });
        }
        setTimeout(() => {
          log({
            t: 'request', host, method: hl[0].split(' ')[0], path: hl[0].split(' ')[1],
            headers: h, body,
          });
          if (MODE === 'reject') {
            // make every upstream call fail fast so the client keeps its
            // cached endpoint instead of re-syncing from the real service
            tlsSock.write(
              'HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{"code":"502"}');
            setTimeout(() => tlsSock.end(), 100);
          } else if (MODE === 'sse') {
            tlsSock.write(
              'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n' +
              'data: {"type":"text","data":"ok"}\n\n' +
              'data: [DONE]\n\n');
          } else {
            const payload = JSON.stringify({ ok: true, data: [] });
            tlsSock.write(
              'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ' +
              Buffer.byteLength(payload) + '\r\nConnection: close\r\n\r\n' + payload);
          }
          setTimeout(() => tlsSock.end(), 200);
        }, 150);
      });
    });
  };
  sock.on('data', onData);
  sock.on('error', () => {});
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[mitm] listening on 127.0.0.1:${PORT} mode=${MODE} out=${OUT}`);
});
