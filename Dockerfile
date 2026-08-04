# hadron-pauser — self-contained build.
# No NPM_TOKEN / private registry needed: @hadron-fi/sdk-v2 is public and the
# stream/observability layers are vendored into src/vendor.
#
# TWO NON-OBVIOUS BUILD CONSTRAINTS, both about the Yellowstone gRPC client's
# native (napi) binding:
#
#  1. PLATFORM IS PINNED TO linux/amd64. @triton-one/yellowstone-grpc publishes
#     bindings for darwin-arm64/x64 and linux-x64-{gnu,musl} — there is NO
#     linux-arm64 build. Without this pin, `docker build` on an Apple Silicon
#     host produces a linux/arm64 image with no loadable binding, and the
#     service dies at stream connect with "Cannot find native binding".
#     amd64 also matches the ECS task definition (cpu_architecture = X86_64).
#  2. NO LOCKFILE IS COPIED, and it's `npm install`, not `npm ci`. A lockfile
#     generated on another platform makes npm omit the platform-specific
#     optional dependency (npm/cli#4828) — same missing-binding crash. Letting
#     npm resolve at build time installs the correct linux-x64-musl binding.
FROM --platform=linux/amd64 node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
# Fail the build here rather than at 3am in production if the binding is absent.
RUN node -e "require('@triton-one/yellowstone-grpc'); console.log('yellowstone native binding OK')"

FROM --platform=linux/amd64 node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
EXPOSE 8080
CMD ["node", "dist/index.js"]
