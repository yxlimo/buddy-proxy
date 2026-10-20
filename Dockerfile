# The code is baked into the image. The NAS never gets a checkout: this file is
# built locally, exported as a tar, and `docker load`ed on the other side.
FROM node:24-alpine

WORKDIR /app

# Dependencies first so this layer is cached. Node runs the .ts files directly with
# native type stripping (>= 22.6), so there is no build step to copy.
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

# Only what the proxies actually load. minimax-proxy.ts and router-proxy.ts both
# import from lib/; the rest of lib/ comes along because minimax-auth statically
# imports the file store too. There is no login program: the proxies run the
# device flow themselves when their credential is missing.
COPY minimax-proxy.ts ./
COPY router-proxy.ts ./
COPY lib/ ./lib/

# The OAuth session is a credential, not configuration: it lives in a named volume
# mounted at /data, so a container rebuild does not lose the login. Created here with
# the runtime user's ownership, otherwise a fresh volume is root-owned and unwritable.
RUN mkdir -p /data && chown node:node /data
ENV MINIMAX_DATA_DIR=/data

EXPOSE 6448

# The port differs per service (the minimax proxy is 6448, the router 6450), so the
# check reads it from the environment instead of being hardcoded.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "const p=process.env.HEALTH_PORT||6448;fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "minimax-proxy.ts"]
