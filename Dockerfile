FROM ghcr.io/lavalink-devs/lavalink:4.2.2 AS lavalink
FROM node:24.14.1-bookworm-slim
# Slim does not include a CA bundle yet. Bootstrap verified HTTPS from the
# already-pinned official Lavalink image, then install Debian's own CA package.
COPY --from=lavalink /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 -o APT::Update::Error-Mode=any update \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install -y --no-install-recommends openjdk-17-jre-headless ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/service
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=lavalink /opt/Lavalink/Lavalink.jar /opt/Lavalink/Lavalink.jar
COPY application.yml /opt/Lavalink/application.yml
COPY lib ./lib
COPY services ./services
COPY start.sh ./start.sh
RUN mkdir -p /opt/Lavalink/plugins /opt/Lavalink/logs && chown -R node:node /opt/Lavalink /opt/service
USER node
ENV SERVER_PORT=2333 PORT=10000
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=8s --start-period=120s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini","--","bash","/opt/service/start.sh"]
