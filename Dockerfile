# Glama builds this image and checks that the MCP server starts.
# Start command matches package.json: node dist/src/server.js
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY api ./api
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=44721
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY logo.jpg ./logo.jpg
USER node
EXPOSE 44721
CMD ["node", "dist/src/server.js"]
