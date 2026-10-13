# --- Build stage: compile TS + bundle the widget into dist/ ---
FROM node:22-alpine AS builder

WORKDIR /usr/src/app

# Install all deps (incl. devDependencies: tsc + esbuild are needed to build)
COPY package*.json ./
RUN npm install

# Copy build inputs and produce dist/ (tsc + esbuild widget bundle)
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# --- Runtime stage: production deps + built output only ---
FROM node:22-alpine

WORKDIR /usr/src/app

ENV NODE_ENV=production

# Install production dependencies only
COPY package*.json ./
RUN npm install --omit=dev

# Copy the compiled output from the build stage and static assets
COPY --from=builder /usr/src/app/dist ./dist
COPY favicon.ico ./

CMD [ "node", "dist/server.js" ]
