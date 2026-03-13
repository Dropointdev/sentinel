FROM node:20-slim

# Install FFmpeg and download go2rtc binary
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Download go2rtc binary
RUN curl -L https://github.com/AlexxIT/go2rtc/releases/latest/download/go2rtc_linux_amd64 \
    -o /usr/local/bin/go2rtc && chmod +x /usr/local/bin/go2rtc

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 4000
CMD ["node", "src/server.js"]