#!/usr/bin/env node
/**
 * Docker Gen - Auto-generate optimized Dockerfiles
 * Detects project type and creates multi-stage builds with security best practices
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Platform detectors
const detectors = {
  node: {
    files: ['package.json'],
    check: () => {
      if (!fs.existsSync('package.json')) return null;
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      return {
        name: pkg.name || 'app',
        version: pkg.engines?.node || '18',
        packageManager: fs.existsSync('pnpm-lock.yaml') ? 'pnpm' :
                       fs.existsSync('yarn.lock') ? 'yarn' : 'npm',
        hasLockfile: fs.existsSync('package-lock.json') || 
                     fs.existsSync('yarn.lock') || 
                     fs.existsSync('pnpm-lock.yaml'),
        main: pkg.main || 'index.js',
        port: pkg.port || 3000
      };
    }
  },
  
  python: {
    files: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'],
    check: () => {
      const hasPoetry = fs.existsSync('pyproject.toml') && 
        fs.readFileSync('pyproject.toml', 'utf8').includes('[tool.poetry]');
      const hasPipenv = fs.existsSync('Pipfile');
      const hasUv = fs.existsSync('pyproject.toml') &&
        fs.readFileSync('pyproject.toml', 'utf8').includes('[tool.uv]');
      
      return {
        packageManager: hasPoetry ? 'poetry' : hasPipenv ? 'pipenv' : hasUv ? 'uv' : 'pip',
        pythonVersion: '3.11',
        hasRequirements: fs.existsSync('requirements.txt')
      };
    }
  },
  
  rust: {
    files: ['Cargo.toml'],
    check: () => {
      if (!fs.existsSync('Cargo.toml')) return null;
      const cargo = fs.readFileSync('Cargo.toml', 'utf8');
      const nameMatch = cargo.match(/name\s*=\s*"([^"]+)"/);
      return {
        name: nameMatch ? nameMatch[1] : 'app',
        binary: true
      };
    }
  },
  
  go: {
    files: ['go.mod'],
    check: () => {
      if (!fs.existsSync('go.mod')) return null;
      const gomod = fs.readFileSync('go.mod', 'utf8');
      const moduleMatch = gomod.match(/module\s+(\S+)/);
      return {
        module: moduleMatch ? moduleMatch[1] : 'app',
        version: '1.21'
      };
    }
  },
  
  ruby: {
    files: ['Gemfile'],
    check: () => ({
      hasGemfileLock: fs.existsSync('Gemfile.lock')
    })
  },
  
  java: {
    files: ['pom.xml', 'build.gradle'],
    check: () => ({
      buildTool: fs.existsSync('pom.xml') ? 'maven' : 'gradle',
      hasWrapper: fs.existsSync('mvnw') || fs.existsSync('gradlew')
    })
  }
};

// Dockerfile generators
const generators = {
  node: (info) => {
    const installCmd = {
      npm: 'npm ci --only=production',
      yarn: 'yarn install --production --frozen-lockfile',
      pnpm: 'pnpm install --prod --frozen-lockfile'
    }[info.packageManager] || 'npm ci --only=production';

    const copyCmd = info.packageManager === 'npm' 
      ? 'COPY package*.json ./'
      : info.packageManager === 'yarn'
      ? 'COPY package.json yarn.lock ./'
      : 'COPY package.json pnpm-lock.yaml ./';

    return `# Build stage
FROM node:${info.version}-alpine AS builder
WORKDIR /app
${copyCmd}
RUN ${installCmd}
COPY . .

# Production stage
FROM node:${info.version}-alpine
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
WORKDIR /app
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs . .
USER nodejs
EXPOSE ${info.port}
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD node -e "require('http').get('http://localhost:${info.port}/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))" || exit 1
CMD ["node", "${info.main}"]`;
  },

  python: (info) => {
    const installCmd = {
      poetry: 'poetry install --no-dev',
      pipenv: 'pipenv install --deploy',
      uv: 'uv pip install -r pyproject.toml',
      pip: 'pip install -r requirements.txt'
    }[info.packageManager];

    const copyFiles = {
      poetry: 'COPY pyproject.toml poetry.lock ./',
      pipenv: 'COPY Pipfile Pipfile.lock ./',
      uv: 'COPY pyproject.toml ./',
      pip: 'COPY requirements.txt ./'
    }[info.packageManager];

    return `# Build stage
FROM python:${info.pythonVersion}-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gcc
${copyFiles}
RUN pip install --user ${info.packageManager === 'poetry' ? 'poetry' : info.packageManager === 'pipenv' ? 'pipenv' : ''}
RUN ${installCmd}

# Production stage
FROM python:${info.pythonVersion}-slim
RUN groupadd -r appuser && useradd -r -g appuser appuser
WORKDIR /app
COPY --from=builder /root/.local /home/appuser/.local
COPY . .
RUN chown -R appuser:appuser /app
USER appuser
ENV PATH=/home/appuser/.local/bin:$PATH
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \\
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1
CMD ["python", "-m", "app"]`;
  },

  rust: (info) => `FROM rust:1.75-alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --target x86_64-unknown-linux-musl

FROM scratch
COPY --from=builder /app/target/x86_64-unknown-linux-musl/release/${info.name} /app
EXPOSE 8080
ENTRYPOINT ["/app"]
CMD []`,

  go: (info) => `FROM golang:${info.version}-alpine AS builder
RUN apk add --no-cache git ca-certificates
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o main .

FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /app/main /main
EXPOSE 8080
ENTRYPOINT ["/main"]
CMD []`,

  ruby: (info) => `FROM ruby:3.2-alpine AS builder
WORKDIR /app
${info.hasGemfileLock ? 'COPY Gemfile Gemfile.lock ./' : 'COPY Gemfile ./'}
RUN bundle config --global frozen 1 && bundle install

FROM ruby:3.2-alpine
RUN addgroup -g 1000 -S app && adduser -u 1000 -S app -G app
WORKDIR /app
COPY --from=builder /usr/local/bundle /usr/local/bundle
COPY --chown=app:app . .
USER app
EXPOSE 3000
CMD ["bundle", "exec", "ruby", "app.rb"]`,

  java: (info) => {
    const buildCmd = info.buildTool === 'maven'
      ? './mvnw clean package -DskipTests'
      : './gradlew build -x test';
    const wrapper = info.buildTool === 'maven' ? 'mvnw' : 'gradlew';
    const copyCmd = info.hasWrapper
      ? `COPY ${wrapper} ${wrapper}.cmd ./`
      : `COPY ${info.buildTool === 'maven' ? 'pom.xml' : 'build.gradle*'} ./`;
    
    return `FROM eclipse-temurin:17-jdk-alpine AS builder
WORKDIR /app
${copyCmd}
COPY src ./src
RUN ${buildCmd}

FROM eclipse-temurin:17-jre-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=builder /app/target/*.jar app.jar
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \\
  CMD wget -q --spider http://localhost:8080/actuator/health || exit 1
ENTRYPOINT ["java", "-jar", "app.jar"]`;
  }
};

function detectPlatform() {
  for (const [platform, detector] of Object.entries(detectors)) {
    const hasFiles = detector.files.some(f => fs.existsSync(f));
    if (hasFiles) {
      const info = detector.check();
      if (info) {
        return { platform, info };
      }
    }
  }
  return null;
}

function generateDockerfile(platform, info) {
  const generator = generators[platform];
  if (!generator) {
    throw new Error(`No generator for platform: ${platform}`);
  }
  return generator(info);
}

function scanWithTrivy(dockerfilePath) {
  try {
    console.log('🔍 Running security scan with Trivy...');
    const output = execSync(`trivy config ${dockerfilePath} 2>&1 || true`, { encoding: 'utf8' });
    return output;
  } catch (e) {
    return 'Trivy not installed. Install with: npm install -g @aquasec/trivy';
  }
}

function main() {
  const args = process.argv.slice(2);
  const outputFile = args.find((arg, i) => args[i - 1] === '-o') || 'Dockerfile';
  const shouldScan = args.includes('--scan');
  const specifiedPlatform = args.find((arg, i) => args[i - 1] === '--platform');

  console.log('🐳 Docker Gen - Optimized Dockerfile Generator\n');

  // Detect platform
  let platform, info;
  if (specifiedPlatform) {
    platform = specifiedPlatform;
    info = detectors[platform]?.check() || {};
  } else {
    const detected = detectPlatform();
    if (!detected) {
      console.error('❌ Could not detect project type. Supported: Node.js, Python, Rust, Go, Ruby, Java');
      console.log('\nUse --platform to specify manually:');
      console.log('  docker-gen --platform node');
      process.exit(1);
    }
    platform = detected.platform;
    info = detected.info;
  }

  console.log(`📦 Detected: ${platform}`);
  console.log(`📝 Generating Dockerfile...\n`);

  // Generate Dockerfile
  const dockerfile = generateDockerfile(platform, info);

  // Write file
  fs.writeFileSync(outputFile, dockerfile);
  console.log(`✅ Dockerfile written to: ${outputFile}\n`);

  // Show preview
  console.log('--- Dockerfile Preview ---');
  console.log(dockerfile);
  console.log('--------------------------\n');

  // Security scan
  if (shouldScan) {
    const scanResults = scanWithTrivy(outputFile);
    console.log(scanResults);
  }

  // Build instructions
  console.log('🚀 Next steps:');
  console.log(`  docker build -t myapp .`);
  console.log(`  docker run -p 8080:8080 myapp`);
}

if (require.main === module) {
  main();
}

module.exports = { detectPlatform, generateDockerfile };
