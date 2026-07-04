FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install dependencies first (cache layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app source
COPY . .

# Create uploads directory
RUN mkdir -p public/uploads

# Expose port (Railway sets PORT env var automatically)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT||3000) + '/api/amenities', r => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

CMD ["node", "server.js"]
