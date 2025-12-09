# Use an Alpine-based Node image for a small footprint
FROM node:20-alpine

# Create app directories
WORKDIR /app

# Install backend dependencies first for better layer caching
COPY backend/package*.json ./backend/
RUN npm ci --prefix /app/backend --omit=dev

# Copy the rest of the project files
COPY backend /app/backend
COPY frontend /app/frontend

# Ensure uploads and tests directories exist for volume mounts
RUN mkdir -p /app/uploads /app/tests

# Expose the application port
EXPOSE 3000

WORKDIR /app/backend
CMD ["npm", "start"]
