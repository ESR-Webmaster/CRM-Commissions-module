FROM node:22-alpine AS base
RUN npm install -g pnpm@9

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/web/ apps/web/
COPY tsconfig.base.json ./

RUN pnpm --filter @sunscape/commissions-shared build
RUN pnpm --filter @sunscape/commissions-ui build
RUN pnpm --filter web build

FROM nginx:alpine
COPY --from=base /app/apps/web/dist /usr/share/nginx/html
EXPOSE 5173
CMD ["nginx", "-g", "daemon off;"]
