# Docker Gen

Auto-generate optimized Dockerfiles with multi-stage builds and security scanning.

## Features

- **Auto-detects** project type (Node, Python, Rust, Go, Ruby, Java)
- **Multi-stage builds** for minimal image size
- **Security scanning** integration (Trivy, Snyk)
- **Best practices** built-in (non-root user, health checks, layer caching)
- **CI/CD ready** outputs for GitHub Actions/GitLab CI

## Usage

```bash
# Generate Dockerfile for current project
docker-gen

# With security scan
docker-gen --scan

# For specific platform
docker-gen --platform node

# Output to specific file
docker-gen -o Dockerfile.prod
```

## Supported Platforms

| Platform | Detection | Base Image | Features |
|----------|-----------|------------|----------|
| Node.js | package.json | node:alpine | npm/yarn/pnpm, multi-stage |
| Python | requirements.txt, pyproject.toml | python:slim | pip/poetry/uv, venv |
| Rust | Cargo.toml | rust:alpine | cargo, static binary |
| Go | go.mod | golang:alpine | modules, static build |
| Ruby | Gemfile | ruby:alpine | bundler, gems |
| Java | pom.xml, build.gradle | eclipse-temurin | Maven/Gradle, JAR |

## Example Output

```dockerfile
# Build stage
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Production stage
FROM node:18-alpine
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
WORKDIR /app
COPY --from=builder --chown=nodejs:nodejs /app .
USER nodejs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node healthcheck.js || exit 1
CMD ["node", "index.js"]
```

## Installation

```bash
npm install -g docker-gen
```

## License

MIT
