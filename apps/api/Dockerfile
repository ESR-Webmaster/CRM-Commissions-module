FROM node:22-alpine AS base
RUN npm install -g pnpm@9

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY apps/api/package.json apps/api/

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/api/ apps/api/
COPY tsconfig.base.json ./

RUN pnpm --filter @sunscape/commissions-shared build
RUN pnpm --filter api build

EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]
