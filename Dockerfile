FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npx vite build

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src/server ./src/server
COPY src/jobs ./src/jobs
# Pure algorithm engine and record types: imported by src/server/algorithms.ts and the algo-paper job.
COPY src/lib ./src/lib
COPY scripts/admin-user.ts ./scripts/admin-user.ts
USER node
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/server/index.ts"]
