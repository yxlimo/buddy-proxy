// lib/http.ts — a fetch that looks like the official command line client.
//
// The official client is a Node program that talks over Axios, so its
// requests carry none of the headers a browser's fetch adds. Node's own fetch
// is built on undici, and undici adds two of them: `sec-fetch-mode: cors` and
// `accept-language: *`. The upstream sees both on every request, and the
// official client sends neither.
//
// undici treats them as forbidden headers and refuses to let them be set, so
// the only place they can be taken off is the dispatcher — the last step
// before the bytes go out. The dispatcher is the one undici uses for every
// request, found through the symbol it registers itself under.

/** The dispatcher undici uses by default, if it can be found. */
function undiciDispatcher(): any {
  const symbol = Symbol.for("undici.globalDispatcher.1");
  return (globalThis as any)[symbol] ?? null;
}

/**
 * A dispatcher that takes the browser headers off.
 *
 * The header names arrive in the shape undici uses, and the ones to drop are
 * named in lower case — undici passes them through as it got them.
 */
function strippingDispatcher(base: any): any {
  return {
    dispatch(opts: any, handler: any) {
      const headers = opts?.headers;
      if (headers && typeof headers === "object" && !Array.isArray(headers)) {
        for (const name of Object.keys(headers)) {
          const lower = name.toLowerCase();
          if (lower === "sec-fetch-mode" || lower === "accept-language") delete headers[name];
        }
      }
      return base.dispatch(opts, handler);
    },
    close() {
      return base.close?.();
    },
    destroy() {
      return base.destroy?.();
    },
  };
}

let dispatcher: any = null;
let tried = false;

function cliDispatcher(): any {
  if (!tried) {
    tried = true;
    const base = undiciDispatcher();
    if (base) dispatcher = strippingDispatcher(base);
  }
  return dispatcher;
}

/**
 * Send a request the way the official command line client sends one.
 *
 * When undici cannot be reached for its dispatcher the request goes out as it
 * is — the two extra headers are harmless, only unlike the client.
 */
export function cliFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const d = cliDispatcher();
  if (!d) return fetch(url, init);
  return fetch(url, { ...init, dispatcher: d } as RequestInit);
}
