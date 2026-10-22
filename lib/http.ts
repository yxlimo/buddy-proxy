// lib/http.ts — a fetch that looks like the official command line client.
//
// The official client is a Node program that talks over Axios, so its
// requests carry none of the headers a browser's fetch adds. Node's own fetch
// is built on undici, and undici adds two of them: `sec-fetch-mode: cors` and
// `accept-language: *`. They are forbidden headers, so they cannot be set or
// unset on the request — the request has to be built by something else.
//
// This is that something else: the same request, sent over the plain HTTP
// module, with the headers exactly as they were given. The answer comes back
// as the same kind of object a fetch gives, so the callers do not care which
// one sent it.

import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";

export interface CliFetchOptions {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  /** Abort the request when the signal fires. */
  signal?: AbortSignal | null;
  /** How long the request may take. */
  timeoutMs?: number;
}

/** The header list as a plain object, the way the HTTP module wants it. */
function headerList(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((value, name) => {
      out[name.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [name, value] of headers) out[name.toLowerCase()] = value;
    return out;
  }
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
}

/** A response that cannot carry a body. */
function bodyless(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

/**
 * Send a request the way the official command line client sends one.
 *
 * The parts of the fetch interface the service uses are the same: the status,
 * the headers, the text, the json and the body as a stream. What it does not
 * have is a browser's fingerprint.
 */
export function cliFetch(url: string, opts: CliFetchOptions = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const headers = headerList(opts.headers);
    if (!headers["accept-encoding"]) headers["accept-encoding"] = "gzip, deflate, br";

    let payload: Buffer | undefined;
    if (opts.body !== undefined && opts.body !== null && typeof opts.body !== "object") {
      payload = Buffer.from(String(opts.body));
    } else if (opts.body instanceof Uint8Array) {
      payload = Buffer.from(opts.body);
    }
    if (payload) headers["content-length"] = String(payload.length);

    const request = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: opts.method ?? "GET",
        headers,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const encoding = (res.headers["content-encoding"] ?? "").toString().toLowerCase();
        if (encoding) delete res.headers["content-encoding"];

        let stream: Readable = res;
        if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(createGunzip());
        else if (encoding === "deflate") stream = res.pipe(createInflate());
        else if (encoding === "br") stream = res.pipe(createBrotliDecompress());

        const body = bodyless(status) ? null : (Readable.toWeb(stream) as ReadableStream<Uint8Array>);
        resolve(
          new Response(body, {
            status,
            statusText: res.statusMessage ?? "",
            headers: res.headers as Record<string, string>,
          }),
        );
      },
    );

    request.on("error", (e) => reject(e));
    if (opts.timeoutMs) {
      request.setTimeout(opts.timeoutMs, () => {
        request.destroy(new Error(`the request timed out after ${opts.timeoutMs}ms`));
      });
    }
    const signal = opts.signal;
    if (signal) {
      if (signal.aborted) request.destroy(new Error("the request was aborted"));
      else signal.addEventListener("abort", () => request.destroy(new Error("the request was aborted")), { once: true });
    }
    if (payload) request.write(payload);
    request.end();
  });
}
