const fs = require('fs');
const path = require('path');
const { generate, detectProjectType } = require('../index.js');

// Test helper
function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ FAIL: ${message}`);
  }
  console.log(`✅ PASS: ${message}`);
}

function createTempProject(files) {
  const tmpDir = path.join('/tmp', `docker-gen-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(tmpDir, file), content);
  }
  
  return tmpDir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('🧪 Running docker-gen tests...\n');

// Test 1: Detect Node.js project
{
  const tmp = createTempProject({
    'package.json': JSON.stringify({ name: 'test', version: '1.0.0' })
  });
  const type = detectProjectType(tmp);
  assert(type === 'node', 'Detects Node.js project from package.json');
  cleanup(tmp);
}

// Test 2: Detect Python project
{
  const tmp = createTempProject({
    'requirements.txt': 'flask==2.0.0'
  });
  const type = detectProjectType(tmp);
  assert(type === 'python', 'Detects Python project from requirements.txt');
  cleanup(tmp);
}

// Test 3: Detect Go project
{
  const tmp = createTempProject({
    'go.mod': 'module example.com/test'
  });
  const type = detectProjectType(tmp);
  assert(type === 'go', 'Detects Go project from go.mod');
  cleanup(tmp);
}

// Test 4: Detect Rust project
{
  const tmp = createTempProject({
    'Cargo.toml': '[package]\nname = "test"'
  });
  const type = detectProjectType(tmp);
  assert(type === 'rust', 'Detects Rust project from Cargo.toml');
  cleanup(tmp);
}

// Test 5: Generate Node.js Dockerfile
{
  const tmp = createTempProject({
    'package.json': JSON.stringify({ 
      name: 'test', 
      version: '1.0.0',
      scripts: { start: 'node index.js' }
    })
  });
  const result = generate(tmp, { type: 'node', port: 3000 });
  assert(result.dockerfile.includes('FROM node:'), 'Node.js Dockerfile has node base image');
  assert(result.dockerfile.includes('EXPOSE 3000'), 'Node.js Dockerfile exposes correct port');
  assert(result.dockerfile.includes('Multi-stage') || result.dockerfile.includes('multi-stage'), 'Node.js Dockerfile uses multi-stage build');
  assert(result.dockerfile.includes('HEALTHCHECK'), 'Node.js Dockerfile includes health check');
  cleanup(tmp);
}

// Test 6: Generate Python Dockerfile
{
  const tmp = createTempProject({
    'requirements.txt': 'flask==2.0.0'
  });
  const result = generate(tmp, { type: 'python', port: 5000 });
  assert(result.dockerfile.includes('FROM python:'), 'Python Dockerfile has python base image');
  assert(result.dockerfile.includes('EXPOSE 5000'), 'Python Dockerfile exposes correct port');
  cleanup(tmp);
}

// Test 7: Generate Go Dockerfile (distroless)
{
  const tmp = createTempProject({
    'go.mod': 'module example.com/test'
  });
  const result = generate(tmp, { type: 'go', port: 8080 });
  assert(result.dockerfile.includes('golang:'), 'Go Dockerfile uses golang builder');
  assert(result.dockerfile.includes('distroless'), 'Go Dockerfile uses distroless for production');
  assert(result.dockerfile.includes('nonroot'), 'Go Dockerfile uses non-root user');
  cleanup(tmp);
}

// Test 8: Generate Docker Compose
{
  const tmp = createTempProject({
    'package.json': JSON.stringify({ name: 'test' })
  });
  const result = generate(tmp, { type: 'node', compose: true, db: true, redis: true });
  assert(result.dockerCompose !== null, 'Docker Compose is generated when requested');
  assert(result.dockerCompose.includes('postgres'), 'Docker Compose includes PostgreSQL');
  assert(result.dockerCompose.includes('redis'), 'Docker Compose includes Redis');
  cleanup(tmp);
}

// Test 9: Generate .dockerignore
{
  const tmp = createTempProject({
    'package.json': JSON.stringify({ name: 'test' })
  });
  const result = generate(tmp, { type: 'node' });
  assert(result.dockerignore.includes('node_modules'), '.dockerignore excludes node_modules');
  assert(result.dockerignore.includes('.env'), '.dockerignore excludes .env files');
  assert(result.dockerignore.includes('.git'), '.dockerignore excludes .git');
  cleanup(tmp);
}

// Test 10: Multi-stage build for all types
{
  const types = ['node', 'python', 'go', 'rust'];
  for (const type of types) {
    const files = type === 'node' ? { 'package.json': '{}' } :
                  type === 'python' ? { 'requirements.txt': '' } :
                  type === 'go' ? { 'go.mod': 'module test' } :
                  { 'Cargo.toml': '[package]' };
    const tmp = createTempProject(files);
    const result = generate(tmp, { type });
    const stageCount = (result.dockerfile.match(/FROM /g) || []).length;
    assert(stageCount >= 2, `${type} Dockerfile uses multi-stage build (${stageCount} stages)`);
    cleanup(tmp);
  }
}

console.log('\n🎉 All tests passed!');
