# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app

# No npm install: the static builder uses only Node's standard library.
COPY package.json ./
COPY scripts/build-static.mjs ./scripts/build-static.mjs
COPY web/ ./web/
COPY images/ ./images/
RUN node scripts/build-static.mjs && mv dist/site-* /app/public

FROM nginxinc/nginx-unprivileged:stable-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/public/ /usr/share/nginx/html/

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

# The base image runs as an unprivileged user and keeps runtime files in /tmp.
# Skip its configuration-editing entrypoint so a read-only filesystem works.
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
