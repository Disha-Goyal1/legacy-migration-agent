FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    npm_config_offline=true \
    npm_config_audit=false \
    npm_config_fund=false

WORKDIR /runner
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node test-runner.mjs archive-security.mjs ./
USER node

ENTRYPOINT ["node", "/runner/test-runner.mjs"]
