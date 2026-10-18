# A bot's computer: an Ubuntu desktop you can watch in the browser (port 3000),
# with Claude Code, Node and Chromium installed. Build from the repo root:
#   docker build -f deploy/computer/Dockerfile -t nimbus-computer .
FROM lscr.io/linuxserver/webtop:ubuntu-xfce

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates git \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Changes on every 'Update computers', so Claude Code and Chromium are always fetched fresh.
ARG CACHEBUST=0
RUN echo "build $CACHEBUST" && npm install -g @anthropic-ai/claude-code@latest

# Chromium for the Browser plugin. It opens on the bot's desktop, so you can watch it.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npx -y playwright@latest install --with-deps chromium && chmod -R a+rX /opt/ms-playwright

COPY hooks/approval-hook.js /opt/nimbus/approval-hook.js
