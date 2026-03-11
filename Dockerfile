FROM node:20-slim

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

RUN npm install --production

RUN chmod +x ./mediamtx

EXPOSE 4000

CMD ["node", "src/server.js"]