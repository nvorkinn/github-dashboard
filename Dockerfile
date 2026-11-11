# Build the page with the dev dependencies, then ship only the relay, its runtime dependencies and the built page.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY relay/src relay/src
COPY shared shared
COPY --from=build /app/dist dist
# The node user, by number so a host can check it without the image's /etc/passwd.
USER 1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD ["wget", "-qO-", "http://127.0.0.1:8080/healthz"]
# Node runs the TypeScript as it is (type stripping), so there is no compile step for the relay.
CMD ["node", "relay/src/main.ts"]
