# Linux dependencies are installed here, before the runtime joins an internal namespace.
FROM node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
WORKDIR /app
RUN npm install --global --no-fund --no-audit vite-plus@0.3.0
COPY manifests/ ./
RUN vp install --frozen-lockfile --filter boardsesh-backend...
COPY source/ ./
# No application starts at image build/start. The host attests namespace ownership first.
USER node
CMD ["sleep", "infinity"]
LABEL org.boardsesh.auth-rehearsal.runtime="isolated-v1"
