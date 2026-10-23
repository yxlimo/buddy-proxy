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
import { createConnectRouter } from "@connectrpc/connect";
import { universalRequestFromNodeRequest, universalResponseToNodeResponse } from "@connectrpc/connect-node";
import { AdminService } from "../gen/buddy/admin/v1/admin_pb.ts";
import { adminService } from "./service.ts";
import { checkAdminToken } from "./token.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Connect 的路径前缀：POST /buddy.admin.v1.AdminService/<方法>。 */
export const CONNECT_PREFIX = "/buddy.admin.v1.AdminService";

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
  ctx.set("Access-Control-Expose-Headers", "connect-content-encoding");
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
