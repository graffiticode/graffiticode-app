# Install dependencies only when needed
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy manifests for the root and every workspace package so npm ci can resolve
# the workspace graph.
COPY package.json package-lock.json* ./
COPY packages/auth-react/package.json ./packages/auth-react/package.json
RUN npm ci --legacy-peer-deps

# Rebuild the source code only when needed
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined at build time, so they must be present here.
ARG NEXT_PUBLIC_GC_API_URL
ARG NEXT_PUBLIC_GC_AUTH_URL
ARG NEXT_PUBLIC_PRIVY_APP_ID
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ENV NEXT_PUBLIC_GC_API_URL=$NEXT_PUBLIC_GC_API_URL
ENV NEXT_PUBLIC_GC_AUTH_URL=$NEXT_PUBLIC_GC_AUTH_URL
ENV NEXT_PUBLIC_PRIVY_APP_ID=$NEXT_PUBLIC_PRIVY_APP_ID
ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY

RUN npm run build

# Production image
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

# Leverage Next.js standalone output to keep the image small.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 8080

ENV PORT 8080

CMD ["node", "server.js"]
