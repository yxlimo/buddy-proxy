// lib/admin/http.ts — 面板的 HTTP 这一层：Connect 的路由、令牌、SPA。
//
// connect-node 的 handler 是裸的 http handler，Koa 里包一层就好：ctx.req 就是
// 原始的 IncomingMessage，ctx.res 就是原始的 ServerResponse。
//
// 令牌在头里，不在消息里：Authorization: Bearer <token>。/health 不要令牌。

import fs from "node:fs";
import { configString, markHotSetting } from "../config.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type Koa from "koa";
import { createConnectRouter, type Interceptor } from "@connectrpc/connect";
import { universalRequestFromNodeRequest, universalResponseToNodeResponse } from "@connectrpc/connect-node";
import { AdminService } from "../gen/buddy/admin/v1/admin_pb.ts";
import { adminService } from "./service.ts";
import { ADMIN_ERROR_HEADER } from "./error-codes.ts";
import { checkAdminToken } from "./token.ts";
import { scrubForLog } from "../log-scrub.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Connect 的路径前缀：POST /buddy.admin.v1.AdminService/<方法>。 */
export const CONNECT_PREFIX = "/buddy.admin.v1.AdminService";

/**
 * 这次调用是哪一个方法（写进日志用）。
 *
 * 面板那边只看见一句 "internal error"，光看它不知道是哪个方法炸的 ——
 * 方法路径与栈一起留着，才查得下去。
 *
 * 只要路径，不要主机：Connect 的拦截器拿到的 url 是绝对的（authority 来自
 * 请求的 Host 头），整条打出去会把内网主机名写进容器日志，而日志会被复制、
 * 归档、发到别处。query 也一样不留 —— 那里面只有 connect 的协议参数。
 * 取不出路径（不是 URL 形状）就原样退回，这一层不该因为打日志而抛。
 */
function methodPath(req: {
  url?: string;
  method?: { parent?: { typeName?: string }; name?: string };
}): string {
  const url = typeof req.url === "string" ? req.url : "";
  if (url) {
    try {
      // base 只是为了让相对路径也能拆开（`/a/b?x=1` 这种也取得到 pathname）。
      const { pathname } = new URL(url, "http://placeholder");
      if (pathname) return pathname;
    } catch {
      /* 不是 URL 形状：退回原值 */
    }
    return url;
  }
  const service = req.method?.parent?.typeName ?? "unknown";
  const method = req.method?.name ?? "unknown";
  return `${service}/${method}`;
}

/**
 * 实现里抛出来的意外在拦截器这一层留痕（实现与 Connect 之间）。
 *
 * Connect 的 handler-factory 把整段实现调用（含拦截器）包在自己的 try/catch
 * 里，非 ConnectError 一律换成一句 "internal error" 的 500 —— 栈没有了，排查
 * 的时候什么都看不见（面板保存主路由模型撞重复目标的那次 500 就是这么查不动
 * 的：既没有日志，也没有线索）。所以在这一层把方法路径与栈打出来，再原样抛
 * 回去：答复还是那个 500，只是日志里留得下痕迹。
 *
 * 判据与抹都在这里，因为只有这一份：
 *
 *   · 判据 —— 面板自己问出来的失败带着机器码（buddy-error 头），服务方法那边
 *     已经写过日志了，再打一遍栈只是噪音，还会把每个 400 刷成一条栈。没带机
 *     器码的才是意外 —— 写库撞约束、上游炸了这种，它们会变成 500，必须留痕。
 *   · 抹 —— 栈里带着 error message，而上游正文片段会被原样塞进 message（见
 *     sensenova/models.ts、intern-ai/models.ts）；从 checkout 跑时栈里还有
 *     本机路径。进日志之前一律抹一遍。
 */
export const traceUnexpected: Interceptor = (next) => async (req) => {
  try {
    return await next(req);
  } catch (err) {
    const metadata = (err as { metadata?: { get(name: string): string | null } })?.metadata;
    const asked = Boolean(metadata && typeof metadata.get === "function" && metadata.get(ADMIN_ERROR_HEADER));
    if (!asked) {
      const stack = scrubForLog(err instanceof Error ? err.stack ?? err.message : String(err), 500);
      console.error(`[ADMIN] ${methodPath(req)} 出了意外：${stack}`);
    }
    throw err;
  }
};

/**
 * Connect 的路由。
 *
 * 只开 Connect 一种协议：面板说的是 Connect，gRPC 那套要 HTTP/2 的 trailer，
 * 这里没有理由再开一种。
 *
 * `alwaysEmitImplicit` 让零值也出现在 JSON 里：proto3 默认是不写的，可面板上
 * 「待重启：否」与「这个字段没有」是两回事，写出来省得前端猜。
 */
const connectRouter = createConnectRouter({
  grpc: false,
  grpcWeb: false,
  jsonOptions: { alwaysEmitImplicit: true },
  interceptors: [traceUnexpected],
});
connectRouter.service(AdminService, adminService);

/** 每个方法一个 handler，键就是 Connect 的标准路径。 */
const connectHandlers = new Map(connectRouter.handlers.map((h) => [h.requestPath, h]));

/**
 * 回答一个 Connect 请求。
 *
 * connect-node 自带的那个适配器是给 http.createServer 用的：它不返回 promise，
 * 答复在后台写。而 Koa 要等答复写完才走完中间件 —— 两个都写就会写两遍。
 * 所以这里自己走一遍 Connect 的那两步（收请求、写答复），中间可以 await。
 */
async function handleConnect(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "").split("?", 1)[0];
  const handler = connectHandlers.get(path);
  if (!handler) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ code: "unimplemented", message: `没有这个方法：${path}` }));
    return;
  }
  const uReq = universalRequestFromNodeRequest(req, res, undefined, undefined);
  // 这里不要兜底。handler 是 handler-factory 造出来的，它把实现调用（连同
  // 拦截器）整段包在自己的 try/catch 里，实现抛的异常从不外逃到这里 —— 只会
  // 被换成 500。真正留痕的是拦截器 traceUnexpected，再在这儿写个 catch 只会
  // 让人以为它在起作用（它一次也不会进）。
  const uRes = await handler(uReq);
  await universalResponseToNodeResponse(uRes, res);
}

/** 令牌不对时的答复。Connect 的错误就是这个形状。 */
function unauthorized(ctx: Koa.Context): void {
  ctx.status = 401;
  ctx.body = { code: "unauthenticated", message: "访问令牌不正确。" };
}

/**
 * 允许跨域访问管理接口的来源。空表示不发跨域头。
 *
 * 面板改了它就重新读一遍 —— 跨域头每个请求都要算，所以这个设置是热的。
 */
markHotSetting("ADMIN_CORS_ORIGINS");

// Ask for it here, at load time: a setting nobody has asked for is not in the
// snapshot, so the panel would not show it and config-cli would refuse to
// write it. The value itself is read again on every request.
configString("ADMIN_CORS_ORIGINS", "");

function corsOrigins(): string[] {
  return configString("ADMIN_CORS_ORIGINS", "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
/**
 * 浏览器的跨域头。
 *
 * 面板在生产环境是网关自己托管的，同源，不需要跨域头；开发时 vite 把接口
 * 代理到网关，浏览器也是同源。所以默认一个都不发。
 *
 * 真要跨域（比如把面板放在别的域名下），在 ADMIN_CORS_ORIGINS 里写允许的
 * 来源，白名单，不接受通配符 —— 通配符加上 Authorization 头，任何一个网站
 * 都能拿着令牌来调管理接口。
 */
function cors(ctx: Koa.Context): void {
  const origins = corsOrigins();
  if (!origins.length) return;
  const origin = String(ctx.headers.origin ?? "");
  if (!origin || !origins.includes(origin)) return;
  ctx.set("Access-Control-Allow-Origin", origin);
  ctx.set("Access-Control-Allow-Headers", "authorization, content-type, connect-protocol-version, connect-timeout-ms");
  // buddy-error：失败的机器码就在这个响应头上。跨域时不列出来，浏览器就不让
  // 前端读它（读了也是 null），面板只能显示一句「出错了」。
  ctx.set("Access-Control-Expose-Headers", "connect-content-encoding, buddy-error");
  ctx.set("Access-Control-Max-Age", "600");
}

/**
 * Connect 的路由。
 *
 * 令牌在进 handler 之前就查：面板管的是凭据，没有令牌的人一眼都不该看到。
 */
export function connectMiddleware(): Koa.Middleware {
  return async (ctx) => {
    cors(ctx);
    if (ctx.method === "OPTIONS") {
      ctx.status = 204;
      return;
    }
    if (!checkAdminToken(ctx.headers as Record<string, unknown>)) {
      unauthorized(ctx);
      return;
    }
    await handleConnect(ctx.req, ctx.res);
  };
}

/* ------------------------------------------------------------------ *
 * 面板的静态文件
 * ------------------------------------------------------------------ */

/** 面板构建出来的东西在哪。 */
export function webDistDir(): string {
  return path.join(HERE, "..", "..", "web", "dist");
}

/** 面板构建出来的东西在不在。 */
export function hasWebDist(): boolean {
  try {
    return fs.statSync(path.join(webDistDir(), "index.html")).isFile();
  } catch {
    return false;
  }
}

/** 文件名后缀与 Content-Type。 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** 一个文件的内容类型。 */
function contentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * 面板的静态文件。
 *
 * 面板挂在 /admin 下面：/admin/assets/x.js 是 web/dist/assets/x.js，
 * /admin 本身是 web/dist/index.html。
 *
 * 前端是单页应用：深链接（/admin/credentials）也要回 index.html，交给前端
 * 的路由去解析。带后缀的路径（/admin/assets/x.js）没有就是没有，回 404 ——
 * 把 HTML 当成脚本发出去，报错会更难懂。
 *
 * 面板的构建产物有时把 base 设成 "/"（那样静态文件就在根上），所以
 * /assets/... 也认一份，两种构建都能用。
 */
export function staticMiddleware(root: string): Koa.Middleware {
  return async (ctx, next) => {
    const urlPath = ctx.path;
    let rel: string;
    let spa = false;
    if (urlPath === "/admin") {
      // /admin 和 /admin/ 是两个地址。重定向到一个，别让相对路径错位。
      ctx.redirect("/admin/");
      return;
    }
    if (urlPath.startsWith("/admin/")) {
      rel = urlPath.slice("/admin".length);
      spa = true;
    } else if (urlPath.startsWith("/assets/")) {
      rel = urlPath;
    } else {
      await next();
      return;
    }

    rel = rel.replace(/^\/+/, "");
    if (rel === "" || rel.endsWith("/")) rel += "index.html";

    // 不许跑到 root 外面去。
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) {
      ctx.status = 403;
      ctx.body = { error: "forbidden" };
      return;
    }

    let file = target;
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(file);
      if (stat.isDirectory()) {
        file = path.join(file, "index.html");
        stat = fs.statSync(file);
      }
    } catch {
      stat = null;
    }

    if (!stat?.isFile()) {
      // 深链接：GET 才回 index.html，其余的是找不到。
      if (!spa || (ctx.method !== "GET" && ctx.method !== "HEAD")) {
        ctx.status = 404;
        ctx.body = { error: "not found" };
        return;
      }
      // 带后缀的路径是资源，不是路由。资源没了就是没了，回 404 —— 把 HTML
      // 当成脚本发出去，浏览器只报 MIME 错，比 404 更难定位。
      if (path.extname(rel)) {
        ctx.status = 404;
        ctx.body = { error: "not found" };
        return;
      }
      file = path.join(root, "index.html");
      try {
        stat = fs.statSync(file);
      } catch {
        ctx.status = 404;
        ctx.body = { error: "not found" };
        return;
      }
    }

    ctx.type = contentType(file);
    // 带指纹的静态文件可以久一点，index.html 不能缓存（不然前端拿到旧的）。
    ctx.set("Cache-Control", file.endsWith("index.html") ? "no-cache" : "public, max-age=3600");
    ctx.body = fs.createReadStream(file);
  };
}
