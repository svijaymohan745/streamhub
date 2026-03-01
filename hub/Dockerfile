FROM node:20-bookworm-slim

# Install ffmpeg (includes ffprobe) with NVENC support via apt
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --only=production

# Copy application files
COPY . .

# Expose web port
EXPOSE 3000

CMD ["node", "server.js"]
