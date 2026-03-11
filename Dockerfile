FROM node:20-slim

# Install FFmpeg — required to transcode HEVC camera feed to H.264 for browsers
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p streams

EXPOSE 4000
CMD ["node", "src/server.js"]