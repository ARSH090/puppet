# Use the pre-configured Puppeteer image
FROM ghcr.io/puppeteer/puppeteer:21.0.0

# Skip downloading Chrome because it's already in the image
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Create and change to the app directory.
WORKDIR /app

# Copy application dependency manifests to the container image.
COPY package*.json ./

# Install production dependencies.
RUN npm install

# Copy local code to the container image.
COPY . .

# Render defaults to 10000
EXPOSE 10000

# Run the web service on container startup.
CMD [ "node", "server.js" ]
