FROM node:24.15-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
COPY apps/dashboard/ apps/dashboard/
COPY scripts/build-web.mjs scripts/build-web.mjs
RUN node scripts/build-web.mjs production
RUN npx tsc
RUN npm prune --omit=dev

FROM node:24.15-bookworm-slim
ENV NODE_ENV=production MCP_WEB_ROOT=/app/web
WORKDIR /app
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/apps/dashboard/dist ./web
COPY --chown=node:node packaging/compose.production.yaml ./deployment/compose.production.yaml
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "const h=require('node:http');const u=new URL(process.env.MCP_PUBLIC_URL);const r=h.get({host:'127.0.0.1',port:3000,path:'/healthz',headers:{Host:u.host,'X-Forwarded-Proto':'https'}},s=>{s.resume();process.exit(s.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.setTimeout(4000,()=>{r.destroy();process.exit(1)})"
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["saas"]
