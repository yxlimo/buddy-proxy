# The code is baked into the image. The NAS never gets a checkout: this file is
# built locally, exported as a tar, and `docker load`ed on the other side.
#
# Two stages: the panel is built with node and pnpm, the runtime only carries
# the result. The router runs the .ts files directly with native type stripping
# (>= 22.6), so there is no build step for the backend.

# ── 面板 ──────────────────────────────────────────────────────────────────
FROM node:24-alpine AS web

WORKDIR /build

RUN corepack enable

# 面板自己的依赖。
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./web/
RUN cd web && pnpm install --frozen-lockfile

COPY web/ ./web/
# 契约的生成物在仓库的 lib/gen/ 里。面板构建前把它搬进 web/.gen/（web/scripts/
# copy-gen.mjs），这样它的依赖从 web/node_modules 里找，容器里就不用再装一遍
# 根目录的依赖。来源仍然只有 lib/gen/ 一处。
COPY lib/gen/ ./lib/gen/

RUN cd web && pnpm build

# ── 运行时 ────────────────────────────────────────────────────────────────
FROM node:24-alpine

WORKDIR /app

# Dependencies first so this layer is cached.
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

# Only what the router actually loads: the entry point and lib/. There is no login
# program: the router runs the device flow itself when a credential is missing.
# config-cli.ts is the way to look at and change the settings in the database.
COPY router-proxy.ts config-cli.ts ./
COPY lib/ ./lib/

# The panel: static files the router serves under /admin.
COPY --from=web /build/web/dist/ ./web/dist/

# The OAuth session is a credential, not configuration: it lives in a named volume
# mounted at /data, so a container rebuild does not lose the login. Created here with
# the runtime user's ownership, otherwise a fresh volume is root-owned and unwritable.
RUN mkdir -p /data && chown node:node /data

# 契约生成的代码里有 enum（protobuf 的枚举），而 Node 的「只剥类型」不认
# enum —— enum 要编译，不能只剥。transform-types 走编译那条路，所以能跑。
#
# 生成物是 buf 原样吐出来的，没有额外加工，所以这里改一个开关就够了。
ENV NODE_OPTIONS="--experimental-transform-types --disable-warning=ExperimentalWarning"

EXPOSE 6450

# The check reads the port from the environment, so the same image can serve on
# whichever port it is given. It reads the router's own variable: the health
# check and the service must not disagree about where the service listens.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "const p=process.env.ROUTER_PORT||6450;fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "router-proxy.ts"]
