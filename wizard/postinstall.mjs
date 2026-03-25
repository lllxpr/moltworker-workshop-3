#!/usr/bin/env node

/**
 * postinstall.mjs
 * After npm install, clone the official moltworker source and apply workshop patches.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const UPSTREAM_DIR = resolve(ROOT, '.upstream');

const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const YELLOW = '\x1b[33m';

function log(msg)  { console.log(`  ${GREEN}▸${RESET} ${msg}`); }
function ok(msg)   { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`  ${YELLOW}⚠${RESET} ${msg}`); }
function dim(msg)  { console.log(`  ${DIM}${msg}${RESET}`); }

// Check if we already have the upstream source
if (existsSync(resolve(ROOT, 'wrangler.jsonc')) && existsSync(resolve(ROOT, 'src'))) {
  dim('Moltworker source already present — skipping clone.');
  process.exit(0);
}

console.log('');
log('Setting up Moltworker Workshop Edition...');

// Clone upstream if not present
if (!existsSync(UPSTREAM_DIR)) {
  log('Cloning official cloudflare/moltworker...');
  try {
    execSync(
      'git clone --depth 1 https://github.com/cloudflare/moltworker.git .upstream',
      { cwd: ROOT, stdio: 'pipe' }
    );
    log('Clone complete.');
  } catch (e) {
    console.error('  Failed to clone. Please ensure git is installed and you have internet access.');
    console.error('  You can manually clone: git clone https://github.com/cloudflare/moltworker.git .upstream');
    process.exit(0); // Don't fail npm install
  }
} else {
  dim('Upstream source already cloned.');
}

// Copy upstream files into the workshop root (excluding .git, README, package.json, wizard/)
log('Applying workshop overlay...');
try {
  // Copy all upstream source files (exclude .git, README, package.json — we keep our own)
  const filesToCopy = [
    'src', 'wrangler.jsonc', 'tsconfig.json', 'Dockerfile',
    'vite.config.ts', 'vitest.config.ts', 'start-openclaw.sh',
    'index.html', 'public', 'skills', 'assets',
    '.dev.vars.example', '.oxfmtrc.json', '.oxlintrc.json',
    'test', 'AGENTS.md',
  ];
  for (const f of filesToCopy) {
    const src = resolve(UPSTREAM_DIR, f);
    if (existsSync(src)) {
      execSync(`cp -rn "${src}" "${ROOT}/" 2>/dev/null || true`, { stdio: 'pipe' });
    }
  }

  // Install upstream dependencies if they have a package.json
  const upstreamPkg = resolve(UPSTREAM_DIR, 'package.json');
  if (existsSync(upstreamPkg)) {
    const upstream = JSON.parse(readFileSync(upstreamPkg, 'utf-8'));
    const workshopPkg = resolve(ROOT, 'package.json');
    const workshop = JSON.parse(readFileSync(workshopPkg, 'utf-8'));

    // Merge dependencies
    if (upstream.dependencies) {
      workshop.dependencies = { ...upstream.dependencies, ...(workshop.dependencies || {}) };
    }
    if (upstream.devDependencies) {
      workshop.devDependencies = { ...upstream.devDependencies, ...(workshop.devDependencies || {}) };
    }

    writeFileSync(workshopPkg, JSON.stringify(workshop, null, 2) + '\n');
    dim('Merged upstream dependencies into package.json');

    // Re-run npm install to fetch the merged dependencies (--ignore-scripts avoids infinite loop)
    log('Installing upstream dependencies...');
    try {
      execSync('npm install --ignore-scripts', { cwd: ROOT, stdio: 'inherit' });
      ok('Dependencies installed');
    } catch {
      warn('Could not auto-install dependencies. Run "npm install" again manually.');
    }
  }

  log('Workshop overlay applied.');

  // Patch src/index.ts to handle missing Sandbox binding (for no-Docker deployments)
  const srcIndexPath = resolve(ROOT, 'src/index.ts');
  if (existsSync(srcIndexPath)) {
    let indexCode = readFileSync(srcIndexPath, 'utf-8');
    
    // Replace getSandbox call to check if Sandbox binding exists
    const originalGetSandbox = `  const options = buildSandboxOptions(c.env);
  const sandbox = getSandbox(c.env.Sandbox, 'moltbot', options);`;
    
    const patchedGetSandbox = `  const options = buildSandboxOptions(c.env);
  // Check if Sandbox binding exists (may be disabled when Docker is not available)
  const sandbox = c.env.Sandbox ? getSandbox(c.env.Sandbox, 'moltbot', options) : null;
  if (!sandbox && c.req.path.includes('/sandbox')) {
    return c.text('Python sandbox is disabled (Docker not available)', 503);
  }`;
    
    if (indexCode.includes(originalGetSandbox)) {
      indexCode = indexCode.replace(originalGetSandbox, patchedGetSandbox);
      writeFileSync(srcIndexPath, indexCode);
      ok('Patched src/index.ts to handle missing Sandbox binding');
    }

    // Disable CF Access requirement check
    if (indexCode.includes('if (!isTestMode)')) {
      indexCode = indexCode.replace(
        'if (!isTestMode)',
        'if (false && !isTestMode) // CF Access is optional'
      );
      writeFileSync(srcIndexPath, indexCode);
      ok('Patched src/index.ts to make CF Access optional');
    }
  }

  // Patch src/auth/middleware.ts to skip CF Access checks
  const authMiddlewarePath = resolve(ROOT, 'src/auth/middleware.ts');
  if (existsSync(authMiddlewarePath)) {
    let authCode = readFileSync(authMiddlewarePath, 'utf-8');
    
    if (authCode.includes('if (!teamDomain || !expectedAud)')) {
      authCode = authCode.replace(
        'if (!teamDomain || !expectedAud)',
        'if (false && (!teamDomain || !expectedAud)) // Skip CF Access check'
      );
      writeFileSync(authMiddlewarePath, authCode);
      ok('Patched src/auth/middleware.ts to skip CF Access checks');
    }
  }
} catch (e) {
  dim(`Overlay warning: ${e.message}`);
}

// Apply workshop-specific patches to wrangler.jsonc
const wranglerPath = resolve(ROOT, 'wrangler.jsonc');
if (existsSync(wranglerPath)) {
  let jsonc = readFileSync(wranglerPath, 'utf-8');

  // Rename worker to workshop name
  if (jsonc.includes('"moltbot-sandbox"')) {
    jsonc = jsonc.replace('"moltbot-sandbox"', '"moltworker-workshop"');
    dim('Renamed worker to moltworker-workshop');
  }

  writeFileSync(wranglerPath, jsonc);
}

console.log('');
log('Setup complete! Run: npm run wizard');
console.log('');
