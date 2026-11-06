FROM node:24-bookworm-slim
WORKDIR /app
COPY web/gateway/package.json web/gateway/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY web/gateway/*.mjs ./
COPY feishu/ /feishu/
CMD ["node", "/app/gateway.mjs"]
