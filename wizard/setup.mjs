#!/usr/bin/env node

/**
 * Moltworker Workshop — Interactive Setup Wizard
 *
 * Automates the entire Moltworker deployment process:
 * 1. Verify environment (Node.js, Wrangler, Cloudflare login)
 * 2. Detect Cloudflare Account ID
 * 3. Create AI Gateway via Cloudflare API
 * 4. Generate AI Gateway authentication token
 * 5. Select AI model (default: Kimi K2.5)
 * 6. Generate secure gateway token
 * 7. Create R2 bucket + API credentials
 * 8. Set all required Wrangler secrets
 * 9. Guide Cloudflare Access setup
 * 10. Deploy to Cloudflare Workers
 *
 * Usage: npm run wizard  (or: node wizard/setup.mjs)
 */

import { execSync } from 'node:child_process';
import * as readline from 'node:readline';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Styling ──────────────────────────────────────────────────────────────────

const B = '\x1b[1m';
const D = '\x1b[2m';
const R = '\x1b[0m';
const G = '\x1b[32m';
const RD = '\x1b[31m';
const Y = '\x1b[33m';
const C = '\x1b[36m';
const O = '\x1b[38;5;208m';

function banner() {
  console.log('');
  console.log(`${O}${B}  ╔═══════════════════════════════════════════════════╗${R}`);
  console.log(`${O}${B}  ║                                                   ║${R}`);
  console.log(`${O}${B}  ║   🤖 Moltworker Workshop — Setup Wizard           ║${R}`);
  console.log(`${O}${B}  ║   Deploy your AI Agent on Cloudflare               ║${R}`);
  console.log(`${O}${B}  ║                                                   ║${R}`);
  console.log(`${O}${B}  ╚═══════════════════════════════════════════════════╝${R}`);
  console.log('');
}

function step(num, total, title) {
  console.log('');
  console.log(`${C}${B}  ── Step ${num}/${total}: ${title} ──${R}`);
}

function ok(msg)   { console.log(`  ${G}✓${R} ${msg}`); }
function warn(msg) { console.log(`  ${Y}⚠${R} ${msg}`); }
function fail(msg) { console.log(`  ${RD}✗${R} ${msg}`); }
function info(msg) { console.log(`  ${D}${msg}${R}`); }
function ln()      { console.log(''); }

// ── I/O Helpers ──────────────────────────────────────────────────────────────

function createRL() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, question, defaultVal) {
  const def = defaultVal ? ` ${D}[${defaultVal}]${R}` : '';
  return new Promise((resolve) => {
    rl.question(`  ${B}${question}${def}: ${R}`, (answer) => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

function confirm(rl, question, defaultYes = true) {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  return new Promise((resolve) => {
    rl.question(`  ${B}${question} (${hint}): ${R}`, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === '') resolve(defaultYes);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

function choose(rl, question, choices) {
  return new Promise((resolve) => {
    console.log(`  ${B}${question}${R}`);
    choices.forEach((c, i) => {
      const marker = c.default ? `${O}→${R}` : ' ';
      console.log(`  ${marker} ${C}${i + 1}${R}) ${c.label}${c.desc ? `  ${D}— ${c.desc}${R}` : ''}`);
    });
    rl.question(`  ${B}Choice [1-${choices.length}]: ${R}`, (answer) => {
      const idx = parseInt(answer, 10) - 1;
      resolve(idx >= 0 && idx < choices.length ? choices[idx] : choices.find(c => c.default) || choices[0]);
    });
  });
}

// ── Shell / API Helpers ──────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: opts.silent ? 'pipe' : undefined, ...opts }).trim();
  } catch (e) {
    if (opts.allowFail) return null;
    throw e;
  }
}

function generateHex(bytes = 32) {
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function cfApi(method, path, accountId, apiToken, body) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`;
  const headers = {
    'Authorization': `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const json = await res.json();
  return json;
}

function setSecret(name, value, accountId) {
  try {
    const result = execSync(`npx wrangler secret put ${name}`, {
      input: value + '\n',
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: ROOT,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    });
    return true;
  } catch (e) {
    // Log error for debugging
    if (e.stderr) console.error(`  Error: ${e.stderr.toString().trim()}`);
    return false;
  }
}

// ── Save config for reference ────────────────────────────────────────────────

function saveConfig(config) {
  const configPath = resolve(ROOT, '.workshop-config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  info(`Config saved to .workshop-config.json`);
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
  banner();

  const rl = createRL();
  const TOTAL = 10;
  const config = {};
  let apiToken = null;

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: Environment Check
  // ═══════════════════════════════════════════════════════════════════════════

  step(1, TOTAL, 'Checking Environment');

  // Node.js version
  const nodeVer = run('node --version', { silent: true, allowFail: true });
  if (nodeVer) {
    const major = parseInt(nodeVer.replace('v', '').split('.')[0], 10);
    if (major >= 18) {
      ok(`Node.js ${nodeVer}`);
    } else {
      fail(`Node.js ${nodeVer} — version 18+ required`);
      fail('Download from: https://nodejs.org');
      rl.close(); process.exit(1);
    }
  } else {
    fail('Node.js not found');
    rl.close(); process.exit(1);
  }

  // Wrangler
  const wranglerVer = run('npx wrangler --version 2>&1', { silent: true, allowFail: true });
  if (wranglerVer) {
    ok(`Wrangler ${wranglerVer.split('\n').pop()}`);
  } else {
    warn('Wrangler not found. Installing...');
    run('npm install -g wrangler', { stdio: 'inherit' });
    ok('Wrangler installed');
  }

  // Cloudflare login
  const whoami = run('npx wrangler whoami 2>&1', { silent: true, allowFail: true });
  if (whoami && !whoami.includes('not authenticated') && !whoami.includes('error')) {
    ok('Logged in to Cloudflare');
  } else {
    warn('Not logged in — opening browser for authentication...');
    ln();
    run('npx wrangler login', { stdio: 'inherit', cwd: ROOT });
    ok('Logged in to Cloudflare');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2: Detect Account
  // ═══════════════════════════════════════════════════════════════════════════

  step(2, TOTAL, 'Detecting Cloudflare Account');

  // Parse account list from wrangler whoami
  const whoamiOutput = run('npx wrangler whoami 2>&1', { silent: true });
  const accountRegex = /│\s+(.+?)\s+│\s+([a-f0-9]{32})\s+│/g;
  const accounts = [];
  let match;
  while ((match = accountRegex.exec(whoamiOutput)) !== null) {
    accounts.push({ name: match[1].trim(), id: match[2] });
  }

  if (accounts.length === 0) {
    config.accountId = await ask(rl, 'Enter your Cloudflare Account ID');
  } else if (accounts.length === 1) {
    config.accountId = accounts[0].id;
    config.accountName = accounts[0].name;
    ok(`Account: ${config.accountName} (${config.accountId})`);
  } else {
    const acctChoice = await choose(rl, 'Select the Cloudflare account to use:', accounts.map((a, i) => ({
      label: a.name,
      desc: a.id,
      default: i === 0,
      value: a,
    })));
    config.accountId = acctChoice.value.id;
    config.accountName = acctChoice.value.name;
    ok(`Account: ${config.accountName} (${config.accountId})`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODE SELECTION: Interactive vs Bulk Paste
  // ═══════════════════════════════════════════════════════════════════════════

  ln();
  const modeChoice = await choose(rl, 'Choose setup mode:', [
    { label: 'Interactive Mode', desc: 'Step-by-step guided setup (recommended for first-time)', default: true, value: 'interactive' },
    { label: 'Bulk Paste Mode', desc: 'Fill a template with all keys at once (faster for re-runs)', value: 'bulk' },
  ]);

  const useBulkMode = modeChoice.value === 'bulk';

  if (useBulkMode) {
    // ═══════════════════════════════════════════════════════════════════════════
    // BULK PASTE MODE
    // ═══════════════════════════════════════════════════════════════════════════

    ln();
    console.log(`${C}${B}  ── Bulk Paste Mode ──${R}`);
    ln();
    info('Copy the template below, fill in your values, then paste it back:');
    ln();

    const template = `# Moltworker Setup Template
# Fill in the values after the = sign, then copy and paste the entire block back

CLOUDFLARE_API_TOKEN=
AI_GATEWAY_ID=moltworker-workshop
AI_GATEWAY_AUTH_TOKEN=
AI_MODEL=@cf/moonshotai/kimi-k2.5
GATEWAY_TOKEN=${generateHex(32)}
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=

# Optional: leave blank to skip R2 setup
# Gateway Token is auto-generated above - save it for Control UI access
# Available models: @cf/moonshotai/kimi-k2.5, @cf/zai-org/glm-4.7-flash, @cf/meta/llama-3.3-70b-instruct-fp8-fast`;

    console.log(`${D}${'─'.repeat(70)}${R}`);
    console.log(template);
    console.log(`${D}${'─'.repeat(70)}${R}`);
    ln();

    info('After filling the template, paste it below as a single block:');
    info('(Tip: paste all lines at once, then press Enter)');
    ln();

    // Read bulk input line by line
    let bulkInput = '';
    let lineCount = 0;
    const maxLines = 15;
    
    info('Paste your filled template (press Enter twice when done):');
    while (lineCount < maxLines) {
      const line = await ask(rl, '', '');
      if (!line && lineCount > 0) break; // Empty line after some input = done
      if (line) {
        bulkInput += line + '\n';
        lineCount++;
      }
    }

    // Parse the bulk input - filter out comments and empty lines
    const cleanInput = bulkInput
      .split('\n')
      .filter(line => line.trim() && !line.trim().startsWith('#'))
      .join('\n');

    const parseValue = (key) => {
      const match = cleanInput.match(new RegExp(`^${key}=(.*)$`, 'm'));
      const value = match ? match[1].trim() : '';
      // Remove any trailing comments
      return value.split('#')[0].trim();
    };

    apiToken = parseValue('CLOUDFLARE_API_TOKEN');
    config.gatewayId = parseValue('AI_GATEWAY_ID') || 'moltworker-workshop';
    config.aigToken = parseValue('AI_GATEWAY_AUTH_TOKEN');
    config.model = parseValue('AI_MODEL') || '@cf/moonshotai/kimi-k2.5';
    config.gatewayToken = parseValue('GATEWAY_TOKEN');
    config.r2AccessKeyId = parseValue('R2_ACCESS_KEY_ID');
    config.r2SecretAccessKey = parseValue('R2_SECRET_ACCESS_KEY');

    // Verify required fields
    if (!apiToken) {
      warn('CLOUDFLARE_API_TOKEN is required but not provided');
    }
    if (!config.aigToken) {
      warn('AI_GATEWAY_AUTH_TOKEN is required but not provided');
    }
    if (!config.gatewayToken) {
      config.gatewayToken = generateHex(32);
      warn('GATEWAY_TOKEN was empty, generated a new one');
    }

    ok('Bulk configuration loaded');
    ln();
    console.log(`${Y}${B}  🔑 SAVE THIS GATEWAY TOKEN:${R}`);
    console.log(`  ${config.gatewayToken}`);
    ln();

    // Determine if R2 is configured
    const setupR2 = !!(config.r2AccessKeyId && config.r2SecretAccessKey);

    // Skip to review step
  } else {
    // ═══════════════════════════════════════════════════════════════════════════
    // INTERACTIVE MODE (original flow)
    // ═══════════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 3: API Token
  // ═══════════════════════════════════════════════════════════════════════════

  step(3, TOTAL, 'Cloudflare API Token');

  info('An API Token is needed to create resources (AI Gateway, R2, etc.) via the Cloudflare API.');
  info('You can create one at:');
  ln();
  console.log(`  ${O}${B}  https://dash.cloudflare.com/profile/api-tokens${R}`);
  ln();
  info('Recommended template: "Edit Cloudflare Workers" (or custom with:');
  info('  Account > AI Gateway > Edit');
  info('  Account > R2 > Edit');
  info('  Account > Workers Scripts > Edit');
  info('  Account > Access: Apps and Policies > Edit)');
  ln();

  apiToken = await ask(rl, 'Paste your Cloudflare API Token');
  if (!apiToken) {
    warn('No API token provided. Some automation will be skipped.');
    warn('You can create resources manually in the Cloudflare Dashboard.');
  } else {
    // Verify token
    try {
      const verify = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
        headers: { 'Authorization': `Bearer ${apiToken}` },
      });
      const result = await verify.json();
      if (result.success) {
        ok('API Token verified');
      } else {
        warn('Token verification failed — some API calls may not work');
      }
    } catch {
      warn('Could not verify token — continuing anyway');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 4: AI Gateway
  // ═══════════════════════════════════════════════════════════════════════════

  step(4, TOTAL, 'AI Gateway Setup');

  let gatewayId = null;

  if (apiToken) {
    const gwName = `moltworker-workshop`;
    info(`Creating AI Gateway: ${gwName}`);

    const gwResult = await cfApi('POST', '/ai-gateway/gateways', config.accountId, apiToken, {
      id: gwName,
      name: 'Moltworker Workshop',
      rate_limiting_interval: 60,
      rate_limiting_limit: 200,
      rate_limiting_technique: 'fixed',
      collect_logs: true,
    });

    if (gwResult.success) {
      gatewayId = gwResult.result.id || gwName;
      ok(`AI Gateway created: ${gatewayId}`);
    } else {
      const errMsg = gwResult.errors?.[0]?.message || 'Unknown error';
      if (errMsg.includes('already exists') || errMsg.includes('duplicate')) {
        gatewayId = gwName;
        ok(`AI Gateway already exists: ${gatewayId}`);
      } else {
        warn(`Could not create AI Gateway: ${errMsg}`);
        info('Create one manually at:');
        console.log(`  ${O}  https://dash.cloudflare.com/?to=/:account/ai/ai-gateway/create-gateway${R}`);
        gatewayId = await ask(rl, 'Enter your AI Gateway ID');
      }
    }
  } else {
    info('Create an AI Gateway at:');
    console.log(`  ${O}  https://dash.cloudflare.com/?to=/:account/ai/ai-gateway/create-gateway${R}`);
    gatewayId = await ask(rl, 'Enter your AI Gateway ID');
  }

  config.gatewayId = gatewayId;

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 5: AI Gateway Auth Token (cf-aig-authorization)
  // ═══════════════════════════════════════════════════════════════════════════

  step(5, TOTAL, 'AI Gateway Authentication Token');

  info('With Unified Billing, you need an AI Gateway auth token (cf-aig-authorization)');
  info('to use Workers AI models without a separate provider API key.');
  ln();

  let aigToken = null;

  if (apiToken) {
    info('Attempting to create AI Gateway auth token via API...');

    // Try to create an AI Gateway token via the authentication endpoint
    const tokenResult = await cfApi('POST', `/ai-gateway/gateways/${config.gatewayId}/tokens`, config.accountId, apiToken, {
      name: 'moltworker-workshop-token',
    });

    if (tokenResult.success && tokenResult.result?.token) {
      aigToken = tokenResult.result.token;
      ok('AI Gateway auth token created');
    } else if (tokenResult.success && tokenResult.result?.value) {
      aigToken = tokenResult.result.value;
      ok('AI Gateway auth token created');
    } else {
      // Fallback: the API token itself can be used as cf-aig-authorization
      // if the gateway has authentication disabled (default for new gateways)
      info('Auto-creation not available for this gateway.');
      info('You can use your Cloudflare API Token as the AI Gateway auth token,');
      info('or create a dedicated token in the dashboard.');
    }
  }

  if (!aigToken) {
    info('To create the token manually:');
    info('  1. Go to AI Gateway → your gateway → Settings → Authentication');
    info('  2. Enable "Authentication" toggle');
    info('  3. Click "Create Token"');
    info('  4. Copy the token value (starts with "aig-...")');
    ln();
    console.log(`  ${O}  https://dash.cloudflare.com/?to=/:account/ai/ai-gateway/general${R}`);
    ln();
    aigToken = await ask(rl, 'Paste your AI Gateway auth token (cf-aig-authorization)');
  }

  config.aigToken = aigToken;

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 6: AI Model Selection
  // ═══════════════════════════════════════════════════════════════════════════

  step(6, TOTAL, 'AI Model Selection');

  const modelChoice = await choose(rl, 'Select the AI model for your agent:', [
    { label: 'Kimi K2.5', desc: '256k context, tool calling, vision', default: true, value: '@cf/moonshotai/kimi-k2.5' },
    { label: 'GLM 4.7 Flash', desc: 'Fast multilingual by Zhipu AI', value: '@cf/zai-org/glm-4.7-flash' },
    { label: 'Llama 3.3 70B', desc: 'FP8 fast inference by Meta', value: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
    { label: 'Other', desc: 'Enter a custom model ID', value: 'custom' },
  ]);

  if (modelChoice.value === 'custom') {
    config.model = await ask(rl, 'Enter model ID (format: provider/model-id)');
  } else {
    config.model = modelChoice.value;
  }
  ok(`Model: ${config.model}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 7: Gateway Token
  // ═══════════════════════════════════════════════════════════════════════════

  step(7, TOTAL, 'Gateway Token (Control UI Access)');

  config.gatewayToken = generateHex(32);

  ln();
  console.log(`  ${Y}${B}  ╔══════════════════════════════════════════════════════════════════════╗${R}`);
  console.log(`  ${Y}${B}  ║  🔑 SAVE THIS TOKEN — you need it to access the Control UI          ║${R}`);
  console.log(`  ${Y}${B}  ║                                                                      ║${R}`);
  console.log(`  ${Y}${B}  ║  ${config.gatewayToken}  ║${R}`);
  console.log(`  ${Y}${B}  ║                                                                      ║${R}`);
  console.log(`  ${Y}${B}  ╚══════════════════════════════════════════════════════════════════════╝${R}`);
  ln();

  await ask(rl, 'Press Enter after you have saved the token...');
  ok('Gateway token generated');

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 8: R2 Storage
  // ═══════════════════════════════════════════════════════════════════════════

  step(8, TOTAL, 'R2 Persistent Storage');

  const setupR2 = await confirm(rl, 'Set up R2 for persistent storage? (recommended)');

  if (setupR2) {
    const bucketName = 'moltbot-data';

    // Create R2 bucket via API (more reliable than wrangler CLI)
    info(`Creating R2 bucket: ${bucketName}`);
    let bucketCreated = false;
    if (apiToken) {
      const bucketResult = await cfApi('POST', '/r2/buckets', config.accountId, apiToken, { name: bucketName });
      if (bucketResult.success) {
        ok(`R2 bucket created: ${bucketName}`);
        bucketCreated = true;
      } else {
        const errMsg = bucketResult.errors?.[0]?.message || '';
        if (errMsg.includes('already exists') || errMsg.includes('duplicate')) {
          ok(`R2 bucket already exists: ${bucketName}`);
          bucketCreated = true;
        }
      }
    }
    if (!bucketCreated) {
      // Fallback: try wrangler CLI
      const cliResult = run(`npx wrangler r2 bucket create ${bucketName} 2>&1`, { silent: true, allowFail: true, cwd: ROOT });
      if (cliResult && !cliResult.includes('ERROR')) {
        ok(`R2 bucket created: ${bucketName}`);
      } else if (cliResult && cliResult.includes('already exists')) {
        ok(`R2 bucket already exists: ${bucketName}`);
      } else {
        warn('Could not create R2 bucket automatically.');
        info('Create it manually: Dashboard → R2 → Create Bucket → Name: moltbot-data');
      }
    }

    // R2 API Token
    ln();
    info('For R2 persistence, you need an R2-scoped API token.');
    info('To create one:');
    info('  1. Go to R2 → Overview → Manage R2 API Tokens');
    info('  2. Create API Token');
    info('  3. Permissions: Object Read & Write');
    info('  4. Scope: moltbot-data bucket');
    info('  5. Copy the Access Key ID and Secret Access Key');
    ln();
    console.log(`  ${O}  https://dash.cloudflare.com/?to=/:account/r2/api-tokens${R}`);
    ln();

    config.r2AccessKeyId = await ask(rl, 'R2 Access Key ID (or Enter to skip)');
    if (config.r2AccessKeyId) {
      config.r2SecretAccessKey = await ask(rl, 'R2 Secret Access Key');
    }
  }

  } // End of interactive mode

  // ═══════════════════════════════════════════════════════════════════════════
  // REVIEW: Confirm all values before setting secrets
  // ═══════════════════════════════════════════════════════════════════════════

  let reviewDone = false;
  while (!reviewDone) {
    ln();
    console.log(`${C}${B}  ── Review Configuration ──${R}`);
    ln();

    const editable = [
      { key: 'apiToken',          label: 'API Token',              value: apiToken, mask: true },
      { key: 'gatewayId',         label: 'AI Gateway ID',          value: config.gatewayId },
      { key: 'aigToken',          label: 'AI Gateway Auth Token',  value: config.aigToken, mask: true },
      { key: 'model',             label: 'AI Model',               value: config.model },
      { key: 'gatewayToken',      label: 'Gateway Token (Control)',value: config.gatewayToken },
      { key: 'r2AccessKeyId',     label: 'R2 Access Key ID',       value: config.r2AccessKeyId, mask: true },
      { key: 'r2SecretAccessKey', label: 'R2 Secret Access Key',   value: config.r2SecretAccessKey, mask: true },
    ];

    editable.forEach((e, i) => {
      const display = !e.value ? `${D}(not set)${R}` :
        e.mask ? `${e.value.slice(0, 8)}...${e.value.slice(-4)}` : e.value;
      console.log(`  ${C}${i + 1}${R}) ${B}${e.label}${R}: ${display}`);
    });

    ln();
    const editChoice = await ask(rl, 'Enter number to re-edit, or press Enter to continue');

    if (!editChoice) {
      reviewDone = true;
    } else {
      const idx = parseInt(editChoice, 10) - 1;
      if (idx >= 0 && idx < editable.length) {
        const item = editable[idx];
        const newVal = await ask(rl, `New value for ${item.label}`);
        if (newVal) {
          switch (item.key) {
            case 'apiToken':          apiToken = newVal; break;
            case 'gatewayId':         config.gatewayId = newVal; break;
            case 'aigToken':          config.aigToken = newVal; break;
            case 'model':             config.model = newVal; break;
            case 'gatewayToken':      config.gatewayToken = newVal; break;
            case 'r2AccessKeyId':     config.r2AccessKeyId = newVal; break;
            case 'r2SecretAccessKey': config.r2SecretAccessKey = newVal; break;
          }
          ok(`${item.label} updated`);
        }
      } else {
        warn('Invalid choice');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 9: Set All Secrets
  // ═══════════════════════════════════════════════════════════════════════════

  step(9, TOTAL, 'Setting Wrangler Secrets');

  const secrets = [
    { name: 'MOLTBOT_GATEWAY_TOKEN', value: config.gatewayToken, required: true },
    { name: 'CF_AI_GATEWAY_ACCOUNT_ID', value: config.accountId, required: true },
    { name: 'CF_AI_GATEWAY_GATEWAY_ID', value: config.gatewayId, required: true },
    { name: 'CF_AI_GATEWAY_MODEL', value: config.model, required: true },
    { name: 'CF_ACCOUNT_ID', value: config.accountId, required: false },
  ];

  if (config.aigToken) {
    secrets.push({ name: 'CLOUDFLARE_AI_GATEWAY_API_KEY', value: config.aigToken, required: true });
  }
  if (config.r2AccessKeyId) {
    secrets.push({ name: 'R2_ACCESS_KEY_ID', value: config.r2AccessKeyId, required: false });
    secrets.push({ name: 'R2_SECRET_ACCESS_KEY', value: config.r2SecretAccessKey, required: false });
  }

  let secretsFailed = 0;
  for (const s of secrets) {
    if (!s.value) {
      if (s.required) warn(`Skipping ${s.name} — no value provided`);
      continue;
    }
    info(`Setting ${s.name}...`);
    if (setSecret(s.name, s.value, config.accountId)) {
      ok(`${s.name} ✓`);
    } else {
      warn(`Failed to set ${s.name}`);
      info(`  Manual: echo "${s.value}" | npx wrangler secret put ${s.name}`);
      secretsFailed++;
    }
  }

  if (secretsFailed > 0) {
    warn(`${secretsFailed} secret(s) failed — set them manually before deploying`);
  } else {
    ok('All secrets set successfully');
  }

  // Cloudflare Access guidance
  ln();
  info('─── Cloudflare Access (Admin UI Protection) ───');
  info('After deployment, protect the Admin UI with Cloudflare Access:');
  info('  1. Go to Workers & Pages → your Worker → Settings');
  info('  2. Under Domains & Routes, click (...) on workers.dev row');
  info('  3. Click "Enable Cloudflare Access"');
  info('  4. Copy the AUD tag');
  info('  5. Set secrets:');
  info('     npx wrangler secret put CF_ACCESS_TEAM_DOMAIN');
  info('     npx wrangler secret put CF_ACCESS_AUD');
  info('  6. Go to Zero Trust → Access → Applications');
  info('     Add your email to the allow list');
  info('  7. Redeploy: npm run deploy');

  // Save config
  const hasR2 = !!(config.r2AccessKeyId && config.r2SecretAccessKey);
  saveConfig({
    accountId: config.accountId,
    accountName: config.accountName || '',
    gatewayId: config.gatewayId,
    model: config.model,
    gatewayToken: config.gatewayToken,
    r2Bucket: hasR2 ? 'moltbot-data' : null,
    createdAt: new Date().toISOString(),
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 10: Deploy
  // ═══════════════════════════════════════════════════════════════════════════

  step(10, TOTAL, 'Deploy to Cloudflare Workers');

  const doDeploy = await confirm(rl, 'Ready to deploy?');

  if (doDeploy) {
    info('Deploying...');
    ln();
    try {
      run('npm run deploy', { stdio: 'inherit', cwd: ROOT });
      ln();
      ok('Deployment successful!');
    } catch {
      fail('Deployment failed — check errors above');
      info('Fix the issue and run: npm run deploy');
    }
  } else {
    info('Skipped. Deploy later with: npm run deploy');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DONE
  // ═══════════════════════════════════════════════════════════════════════════

  ln();
  console.log(`${G}${B}  ╔═══════════════════════════════════════════════════╗${R}`);
  console.log(`${G}${B}  ║                                                   ║${R}`);
  console.log(`${G}${B}  ║   🎉 Setup Complete!                               ║${R}`);
  console.log(`${G}${B}  ║                                                   ║${R}`);
  console.log(`${G}${B}  ╚═══════════════════════════════════════════════════╝${R}`);
  ln();
  console.log(`  ${B}Your AI Agent URLs:${R}`);
  ln();
  console.log(`  ${B}Control UI:${R}  https://<your-worker>.workers.dev/?token=${config.gatewayToken}`);
  console.log(`  ${B}Admin UI:${R}    https://<your-worker>.workers.dev/_admin/`);
  ln();
  console.log(`  ${B}Configuration:${R}`);
  console.log(`    AI Model:     ${config.model}`);
  console.log(`    AI Gateway:   ${config.gatewayId}`);
  console.log(`    Account:      ${config.accountId}`);
  ln();
  console.log(`  ${B}Next steps:${R}`);
  console.log(`    1. Open the Control UI in your browser`);
  console.log(`    2. Wait 1-2 minutes for the container to start`);
  console.log(`    3. Set up Cloudflare Access (see above) and visit /_admin/`);
  console.log(`    4. Pair your device and start chatting!`);
  ln();
  console.log(`  ${D}Config saved to .workshop-config.json${R}`);
  console.log(`  ${D}Tip: SANDBOX_SLEEP_AFTER=10m is set to save costs when idle.${R}`);
  ln();

  rl.close();
}

main().catch((err) => {
  console.error(`\n  ${RD}Fatal error: ${err.message}${R}\n`);
  process.exit(1);
});
