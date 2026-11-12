# zarcube served as static files by nginx, at /.

FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY . .
RUN npx vite build --base /

FROM nginxinc/nginx-unprivileged:alpine-slim
LABEL org.opencontainers.image.title="zarcube" \
      org.opencontainers.image.description="Pacific thermocline data cube: monthly GODAS ocean temperature as an interactive 3D volume" \
      org.opencontainers.image.source="https://github.com/fxi/zarcube" \
      org.opencontainers.image.licenses="MIT"
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html
EXPOSE 8080
