#!/usr/bin/env node

/**
 * docker-gen - Auto-generate optimized Dockerfiles
 * Supports: Node.js, Python, Go, Rust, Ruby, Java, PHP, Static sites
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ANSI colors
const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  bold: '\x1b[1m'
};

function log(msg, color = 'reset') {
  console.log(`${C[color]}${msg}${C.reset}`);
}

// Project type detection
function detectProjectType(projectPath) {
  const files = fs.readdirSync(projectPath);
  
  if (files.includes('package.json')) return 'node';
  if (files.includes('requirements.txt') || files.includes('pyproject.toml') || files.includes('setup.py')) return 'python';
  if (files.includes('go.mod')) return 'go';
  if (files.includes('Cargo.toml')) return 'rust';
  if (files.includes('Gemfile')) return 'ruby';
  if (files.includes('pom.xml') || files.includes('build.gradle')) return 'java';
  if (files.includes('composer.json')) return 'php';
  if (files.includes('index.html') || files.includes('index.htm')) return 'static';
  
  // Check for common patterns
  if (files.some(f => f.endsWith('.js') || f.endsWith('.ts'))) return 'node';
  if (files.some(f => f.endsWith('.py'))) return 'python';
  if (files.some(f => f.endsWith('.go'))) return 'go';
  if (files.some(f => f.endsWith('.rs'))) return 'rust';
  
  return 'static';
}

// Detect package manager for Node.js
function detectNodePackageManager(projectPath) {
  if (fs.existsSync(path.join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(projectPath, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(projectPath, 'bun.lockb'))) return 'bun';
  return 'npm';
}

// Detect Python package manager
function detectPythonPackageManager(projectPath) {
  if (fs.existsSync(path.join(projectPath, 'poetry.lock'))) return 'poetry';
  if (fs.existsSync(path.join(projectPath, 'uv.lock'))) return 'uv';
  if (fs.existsSync(path.join(projectPath, 'Pipfile.lock'))) return 'pipenv';
  return 'pip';
}

// Get Node.js version from package.json engines or nvmrc
function getNodeVersion(projectPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8'));
    if (pkg.engines?.node) {
      const match = pkg.engines.node.match(/\d+/);
      if (match) return match[0];
    }
  } catch {}
  
  try {
    const nvmrc = fs.readFileSync(path.join(projectPath, '.nvmrc'), 'utf8').trim();
    if (nvmrc) return nvmrc.replace('v', '');
  } catch {}
  
  return '20'; // Default LTS
}

// Get Python version from pyproject.toml or runtime.txt
function getPythonVersion(projectPath) {
  try {
    const pyproject = fs.readFileSync(path.join(projectPath, 'pyproject.toml'), 'utf8');
    const match = pyproject.match(/python\s*=\s*["'](\d+\.\d+)/);
    if (match) return match[1];
  } catch {}
  
  try {
    const runtime = fs.readFileSync(path.join(projectPath, 'runtime.txt'), 'utf8').trim();
    const match = runtime.match(/python-(\d+\.\d+)/);
    if (match) return match[1];
  } catch {}
  
  return '3.11'; // Default
}

// Get Go version from go.mod
function getGoVersion(projectPath) {
  try {
    const gomod = fs.readFileSync(path.join(projectPath, 'go.mod'), 'utf8');
    const match = gomod.match(/go\s+(\d+\.\d+)/);
    if (match) return match[1];
  } catch {}
  return '1.21';
}

// Get Rust edition from Cargo.toml
function getRustEdition(projectPath) {
  try {
    const cargo = fs.readFileSync(path.join(projectPath, 'Cargo.toml'), 'utf8');
    const match = cargo.match(/edition\s*=\s*["'](\d{4})/);
    if (match) return match[1];
  } catch {}
  return '2021';
}

// Generate Dockerfile for Node.js
function generateNodeDockerfile(projectPath, options) {
  const pm = detectNodePackageManager(projectPath);
  const nodeVersion = getNodeVersion(projectPath);
  const { port = 3000, entryFile = 'index.js' } = options;
  
  let installCmd, buildCmd, runCmd;
  
  switch(pm) {
    case 'pnpm':
      installCmd = 'npm install -g pnpm && pnpm install --frozen-lockfile';
      buildCmd = 'pnpm run build';
      runCmd = 'pnpm start';
      break;
    case 'yarn':
      installCmd = 'yarn install --frozen-lockfile';
      buildCmd = 'yarn build';
      runCmd = 'yarn start';
      break;
    case 'bun':
      installCmd = 'npm install -g bun && bun install';
      buildCmd = 'bun run build';
      runCmd = 'bun start';
      break;
    default:
      installCmd = 'npm ci --only=production';
      buildCmd = 'npm run build';
      runCmd = 'npm start';
  }
  
  const hasBuild = fs.existsSync(path.join(projectPath, 'package.json')) && 
    JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8')).scripts?.build;
  
  return `# syntax=docker/dockerfile:1
# Multi-stage build for Node.js ${nodeVersion}

####################
# Dependencies stage
####################
FROM node:${nodeVersion}-alpine AS deps
WORKDIR /app

# Install dependencies first (better caching)
COPY package*.json ./
${pm === 'pnpm' ? 'COPY pnpm-lock.yaml ./' : ''}
${pm === 'yarn' ? 'COPY yarn.lock ./' : ''}
RUN ${installCmd}

####################
# Build stage
####################
FROM node:${nodeVersion}-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .
${hasBuild ? buildCmd : '# No build step required'}

####################
# Production stage
####################
FROM node:${nodeVersion}-alpine AS runner
WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nodejs

# Copy only necessary files
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist 2>/dev/null || true
COPY --from=builder --chown=nodejs:nodejs /app/public ./public 2>/dev/null || true
COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs package*.json ./
COPY --chown=nodejs:nodejs . .

USER nodejs

EXPOSE ${port}

ENV NODE_ENV=production
ENV PORT=${port}

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD node -e "require('http').get('http://localhost:${port}/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))" || exit 1

CMD ["${runCmd.split(' ')[0]}", "${runCmd.split(' ').slice(1).join(' ')}"]
`;
}

// Generate Dockerfile for Python
function generatePythonDockerfile(projectPath, options) {
  const pm = detectPythonPackageManager(projectPath);
  const pythonVersion = getPythonVersion(projectPath);
  const { port = 8000 } = options;
  
  let installCmd;
  switch(pm) {
    case 'poetry':
      installCmd = `RUN pip install poetry && \\
    poetry config virtualenvs.create false && \\
    poetry install --no-dev --no-interaction --no-ansi`;
      break;
    case 'uv':
      installCmd = `RUN pip install uv && \\
    uv pip install --system -r pyproject.toml`;
      break;
    case 'pipenv':
      installCmd = `RUN pip install pipenv && \\
    pipenv install --deploy --system`;
      break;
    default:
      installCmd = `RUN pip install --no-cache-dir -r requirements.txt`;
  }
  
  // Detect entry point
  let entryPoint = 'app:app';
  if (fs.existsSync(path.join(projectPath, 'main.py'))) entryPoint = 'main:app';
  if (fs.existsSync(path.join(projectPath, 'app.py'))) entryPoint = 'app:app';
  if (fs.existsSync(path.join(projectPath, 'manage.py'))) entryPoint = 'manage:app';
  
  return `# syntax=docker/dockerfile:1
# Multi-stage build for Python ${pythonVersion}

####################
# Builder stage
####################
FROM python:${pythonVersion}-slim AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \\
    gcc \\
    libpq-dev \\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements*.txt pyproject.toml poetry.lock* ./
${installCmd}

####################
# Production stage
####################
FROM python:${pythonVersion}-slim AS runner
WORKDIR /app

# Create non-root user
RUN groupadd --gid 1001 appgroup && \\
    useradd --uid 1001 --gid appgroup --shell /bin/false appuser

# Copy only necessary files from builder
COPY --from=builder /usr/local/lib/python${pythonVersion}/site-packages /usr/local/lib/python${pythonVersion}/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy application code
COPY --chown=appuser:appgroup . .

USER appuser

EXPOSE ${port}

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=${port}

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:${port}/health')" || exit 1

# Use gunicorn for production (adjust entry point as needed)
CMD ["gunicorn", "--bind", "0.0.0.0:${port}", "--workers", "4", "--threads", "2", "${entryPoint}"]
`;
}

// Generate Dockerfile for Go
function generateGoDockerfile(projectPath, options) {
  const goVersion = getGoVersion(projectPath);
  const { port = 8080 } = options;
  
  // Try to get binary name from go.mod
  let binaryName = 'app';
  try {
    const gomod = fs.readFileSync(path.join(projectPath, 'go.mod'), 'utf8');
    const match = gomod.match(/module\s+(\S+)/);
    if (match) {
      binaryName = path.basename(match[1]);
    }
  } catch {}
  
  return `# syntax=docker/dockerfile:1
# Multi-stage build for Go ${goVersion}

####################
# Build stage
####################
FROM golang:${goVersion}-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git ca-certificates tzdata

WORKDIR /build

# Copy and download dependencies
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build with optimizations
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \\
    -ldflags='-w -s -extldflags "-static"' \\
    -a -installsuffix cgo \\
    -o ${binaryName} .

####################
# Production stage (distroless)
####################
FROM gcr.io/distroless/static:nonroot

WORKDIR /

# Copy binary from builder
COPY --from=builder /build/${binaryName} /app

# Use non-root user
USER nonroot:nonroot

EXPOSE ${port}

ENV PORT=${port}

# Health check (if your app has a /health endpoint)
# HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
#   CMD ["/app", "health"] || exit 1

ENTRYPOINT ["/app"]
`;
}

// Generate Dockerfile for Rust
function generateRustDockerfile(projectPath, options) {
  const edition = getRustEdition(projectPath);
  const { port = 8080 } = options;
  
  // Get binary name from Cargo.toml
  let binaryName = 'app';
  try {
    const cargo = fs.readFileSync(path.join(projectPath, 'Cargo.toml'), 'utf8');
    const match = cargo.match(/\[\[bin\]\][\s\S]*?name\s*=\s*["'](\S+)["']/);
    if (match) binaryName = match[1];
    else {
      const nameMatch = cargo.match(/name\s*=\s*["'](\S+)["']/);
      if (nameMatch) binaryName = nameMatch[1];
    }
  } catch {}
  
  return `# syntax=docker/dockerfile:1
# Multi-stage build for Rust (Edition ${edition})

####################
# Chef stage - dependency caching
####################
FROM lukemathwalker/cargo-chef:latest-rust-1 AS chef
WORKDIR /app

####################
# Planner stage
####################
FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

####################
# Builder stage
####################
FROM chef AS builder

# Install dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \\
    pkg-config \\
    libssl-dev \\
    && rm -rf /var/lib/apt/lists/*

COPY --from=planner /app/recipe.json recipe.json

# Build dependencies (cached layer)
RUN cargo chef cook --release --recipe-path recipe.json

# Build application
COPY . .
RUN cargo build --release --bin ${binaryName}

####################
# Production stage (distroless)
####################
FROM gcr.io/distroless/cc:nonroot

WORKDIR /app

# Copy binary
COPY --from=builder /app/target/release/${binaryName} /app/

USER nonroot:nonroot

EXPOSE ${port}

ENV PORT=${port}
ENV RUST_LOG=info

ENTRYPOINT ["/app/${binaryName}"]
`;
}

// Generate Dockerfile for static sites
function generateStaticDockerfile(projectPath, options) {
  return `# syntax=docker/dockerfile:1
# Multi-stage build for static site

####################
# Build stage (optional - for sites needing build)
####################
FROM node:20-alpine AS builder
WORKDIR /app

# Copy package files if they exist
COPY package*.json ./
RUN if [ -f package.json ]; then npm ci; fi

COPY . .
RUN if [ -f package.json ]; then npm run build 2>/dev/null || true; fi

####################
# Production stage (nginx)
####################
FROM nginx:alpine

# Remove default nginx static assets
RUN rm -rf /usr/share/nginx/html/*

# Copy static files
COPY --from=builder /app/dist /usr/share/nginx/html/ 2>/dev/null || \\
COPY --from=builder /app/build /usr/share/nginx/html/ 2>/dev/null || \\
COPY . /usr/share/nginx/html/

# Custom nginx config for SPA support
RUN echo 'server { \\
    listen 80; \\
    server_name localhost; \\
    root /usr/share/nginx/html; \\
    index index.html; \\
    location / { \\
        try_files \$uri \$uri/ /index.html; \\
    } \\
    gzip on; \\
    gzip_types text/plain text/css application/json application/javascript; \\
}' > /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD wget --quiet --tries=1 --spider http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
`;
}

// Generate docker-compose.yml
function generateDockerCompose(options) {
  const { projectName = 'myapp', port = 3000, db = false, redis = false } = options;
  
  let services = `  ${projectName}:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "${port}:${port}"
    environment:
      - NODE_ENV=production
      - PORT=${port}`;

  if (db) {
    services += `
      - DATABASE_URL=postgresql://postgres:postgres@db:5432/${projectName}`;
  }
  if (redis) {
    services += `
      - REDIS_URL=redis://redis:6379`;
  }
  
  services += `
    restart: unless-stopped`;
  
  if (db || redis) {
    services += `
    depends_on:`;
    if (db) services += `
      - db`;
    if (redis) services += `
      - redis`;
  }

  let extraServices = '';
  
  if (db) {
    extraServices += `

  db:
    image: postgres:15-alpine
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres
      - POSTGRES_DB=${projectName}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    restart: unless-stopped`;
  }
  
  if (redis) {
    extraServices += `

  redis:
    image: redis:7-alpine
    restart: unless-stopped`;
  }
  
  let volumes = '';
  if (db) {
    volumes = `

volumes:
  postgres_data:`;
  }
  
  return `version: '3.8'

services:
${services}${extraServices}${volumes}
`;
}

// Generate .dockerignore
function generateDockerignore(projectPath) {
  const commonIgnores = [
    'node_modules',
    'npm-debug.log',
    '.git',
    '.gitignore',
    '.env',
    '.env.local',
    '.env.*.local',
    '*.md',
    '!README.md',
    '.vscode',
    '.idea',
    '*.swp',
    '*.swo',
    '*~',
    '.DS_Store',
    'dist',
    'build',
    'coverage',
    '.nyc_output',
    '.pytest_cache',
    '__pycache__',
    '*.pyc',
    '*.pyo',
    '*.egg-info',
    '.tox',
    '.venv',
    'venv',
    'target',
    'Cargo.lock',
    '*.log',
    'logs',
    'tmp',
    'temp',
    '.cache',
    'Dockerfile',
    'docker-compose.yml',
    '.dockerignore'
  ];
  
  return commonIgnores.join('\n') + '\n';
}

// Main generator function
function generate(projectPath, options = {}) {
  const type = options.type || detectProjectType(projectPath);
  
  log(`Detected project type: ${type}`, 'cyan');
  
  let dockerfile;
  switch(type) {
    case 'node':
      dockerfile = generateNodeDockerfile(projectPath, options);
      break;
    case 'python':
      dockerfile = generatePythonDockerfile(projectPath, options);
      break;
    case 'go':
      dockerfile = generateGoDockerfile(projectPath, options);
      break;
    case 'rust':
      dockerfile = generateRustDockerfile(projectPath, options);
      break;
    case 'static':
      dockerfile = generateStaticDockerfile(projectPath, options);
      break;
    default:
      dockerfile = generateStaticDockerfile(projectPath, options);
  }
  
  const results = {
    dockerfile,
    dockerignore: generateDockerignore(projectPath),
    dockerCompose: options.compose ? generateDockerCompose(options) : null
  };
  
  return results;
}

// CLI
function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
${C.bold}docker-gen${C.reset} - Auto-generate optimized Dockerfiles

Usage: docker-gen [options] [path]

Options:
  --type <type>      Project type (node, python, go, rust, static)
  --port <port>      Exposed port (default: auto-detect)
  --compose          Also generate docker-compose.yml
  --db               Include PostgreSQL in docker-compose
  --redis            Include Redis in docker-compose
  --dry-run          Preview without writing files
  --force            Overwrite existing files
  --help, -h         Show this help

Examples:
  docker-gen                    # Auto-detect and generate
  docker-gen --type node        # Force Node.js detection
  docker-gen --compose --db     # Generate with PostgreSQL service
  docker-gen --dry-run          # Preview only
`);
    return;
  }
  
  const projectPath = args.find(a => !a.startsWith('--')) || '.';
  const options = {
    type: args.includes('--type') ? args[args.indexOf('--type') + 1] : null,
    port: args.includes('--port') ? parseInt(args[args.indexOf('--port') + 1]) : undefined,
    compose: args.includes('--compose'),
    db: args.includes('--db'),
    redis: args.includes('--redis'),
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force')
  };
  
  if (!fs.existsSync(projectPath)) {
    log(`Error: Path does not exist: ${projectPath}`, 'red');
    process.exit(1);
  }
  
  log(`${C.bold}🐳 Docker Generator${C.reset}\n`, 'blue');
  
  const results = generate(projectPath, options);
  
  // Write or preview files
  const files = [
    { name: 'Dockerfile', content: results.dockerfile },
    { name: '.dockerignore', content: results.dockerignore },
    ...(results.dockerCompose ? [{ name: 'docker-compose.yml', content: results.dockerCompose }] : [])
  ];
  
  for (const file of files) {
    const filePath = path.join(projectPath, file.name);
    const exists = fs.existsSync(filePath);
    
    if (exists && !options.force && !options.dryRun) {
      log(`⚠️  ${file.name} already exists (use --force to overwrite)`, 'yellow');
      continue;
    }
    
    if (options.dryRun) {
      log(`\n${C.bold}=== ${file.name} ===${C.reset}`, 'cyan');
      console.log(file.content);
    } else {
      fs.writeFileSync(filePath, file.content);
      log(`${exists ? '✅ Updated' : '✅ Created'}: ${file.name}`, 'green');
    }
  }
  
  if (!options.dryRun) {
    log(`\n${C.bold}Next steps:${C.reset}`, 'cyan');
    log(`  docker build -t myapp .`, 'reset');
    if (options.compose) {
      log(`  docker-compose up`, 'reset');
    } else {
      log(`  docker run -p ${options.port || 3000}:${options.port || 3000} myapp`, 'reset');
    }
    
    // Security scanning suggestion
    log(`\n${C.bold}Security scanning:${C.reset}`, 'cyan');
    log(`  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \\\n    -v $(pwd):/tmp aquasec/trivy image --exit-code 0 myapp`, 'reset');
  }
}

if (require.main === module) {
  main();
}

module.exports = { generate, detectProjectType };
