FROM node:lts-buster

# Set working directory
WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./

# Install dependencies
RUN npm install && npm install -g pm2

# Copy rest of the app
COPY . .

# Expose the port your app listens on
EXPOSE 9090

# Start the app
CMD ["npm", "start"]
