# Production Dockerfile for the long-running torrent streaming server
FROM node:18-alpine

# Set working directory
WORKDIR /usr/src/app

# Use production mode
ENV NODE_ENV=production

# Install dependencies (copy package files first for better layer caching)
COPY package*.json ./
RUN npm ci --only=production

# Copy app sources
COPY . .

# Create a non-root user and give ownership of the app directory
RUN addgroup -S appgroup && adduser -S appuser -G appgroup && \
		chown -R appuser:appgroup /usr/src/app

USER appuser

# Expose port
EXPOSE 3000

# Simple healthcheck (uses wget available in alpine's busybox)
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
	CMD wget -q --spider http://localhost:3000/ || exit 1

# Default command
CMD ["node", "stream.js"]
