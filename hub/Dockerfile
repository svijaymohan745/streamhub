FROM node:20-alpine

WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm install --only=production

# Copy application files
COPY . .

# Expose the API and UI port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]
