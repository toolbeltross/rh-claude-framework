import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import https from 'https';
import {
  CREDENTIALS_PATH, CREDENTIALS_POLL_MS, USAGE_POLL_MS,
  MAX_POLL_INTERVAL_MS, OAUTH_CLIENT_ID,
} from './config.js';

/**
 * Read Claude Code credentials (plan type + OAuth token).
 * Windows/Linux: ~/.claude/.credentials.json
 * macOS: Keychain via `security` CLI
 */
function readCredentials() {
  // Try file-based credentials first (Windows + Linux)
  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf-8');
    const creds = JSON.parse(raw);
    return creds.claudeAiOauth || null;
  } catch {
    // File not found or unreadable — try macOS Keychain
  }

  if (process.platform === 'darwin') {
    try {
      const raw = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w',
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      const creds = JSON.parse(raw);
      return creds.claudeAiOauth || null;
    } catch {
      // Keychain entry not found
    }
  }

  return null;
}

/**
 * Write updated tokens back to credentials file.
 * Only for file-based credentials (Windows/Linux). macOS Keychain write-back is skipped.
 */
function writeBackCredentials(newTokens) {
  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf-8');
    const creds = JSON.parse(raw);
    if (creds.claudeAiOauth) {
      creds.claudeAiOauth.accessToken = newTokens.accessToken;
      creds.claudeAiOauth.refreshToken = newTokens.refreshToken;
      creds.claudeAiOauth.expiresAt = newTokens.expiresAt;
      writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
      console.log('[plan] Credentials updated with refreshed token');
    }
  } catch (e) {
    console.log(`[plan] Could not write back credentials: ${e.message}`);
  }
}

/**
 * Determine display mode from subscription type.
 */
function resolveDisplayMode(subscriptionType) {
  if (!subscriptionType) return 'cost';
  const lower = subscriptionType.toLowerCase();
  if (lower === 'max') return 'tokens';
  return 'cost'; // pro, api, unknown
}

/**
 * Extract plan tier name from rateLimitTier string.
 * e.g., "default_claude_max_20x" → "Max 20x"
 */
function friendlyTier(rateLimitTier) {
  if (!rateLimitTier) return null;
  if (rateLimitTier.includes('max_20x')) return 'Max 20x';
  if (rateLimitTier.includes('max_5x')) return 'Max 5x';
  if (rateLimitTier.includes('pro')) return 'Pro';
  return rateLimitTier;
}

/**
 * Refresh OAuth token using refresh_token grant.
 * Returns { accessToken, refreshToken, expiresAt } or null.
 */
function refreshOAuthToken(refreshTokenStr) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshTokenStr,
      client_id: OAUTH_CLIENT_ID,
    });
    const req = https.request(
      'https://console.anthropic.com/v1/oauth/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            console.log(`[plan] Token refresh failed: HTTP ${res.statusCode} — ${data.slice(0, 200)}`);
            resolve(null);
            return;
          }
          try {
            const parsed = JSON.parse(data);
            console.log('[plan] OAuth token refreshed successfully');
            resolve({
              accessToken: parsed.access_token,
              refreshToken: parsed.refresh_token,
              expiresAt: Date.now() + (parsed.expires_in || 3600) * 1000,
            });
          } catch (e) {
            console.log(`[plan] Token refresh parse error: ${e.message}`);
            resolve(null);
          }
        });
      }
    );
    req.on('error', (e) => {
      console.log(`[plan] Token refresh network error: ${e.message}`);
      resolve(null);
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/**
 * Fetch usage data from Anthropic OAuth API.
 * Returns usage object, { _error: 'rate_limited', retryAfter } on 429, or null on other failures.
 */
function fetchUsage(accessToken) {
  return new Promise((resolve) => {
    const req = https.request(
      'https://api.anthropic.com/api/oauth/usage',
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          // Check HTTP status before parsing
          if (res.statusCode === 429) {
            const retryAfter = res.headers['retry-after'];
            console.log(`[plan] Usage API 429 rate limited (retry-after: ${retryAfter || '?'}s)`);
            resolve({ _error: 'rate_limited', retryAfter: parseInt(retryAfter) || 60 });
            return;
          }
          if (res.statusCode !== 200) {
            console.log(`[plan] Usage API HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
            resolve(null);
            return;
          }
          try {
            const parsed = JSON.parse(data);
            console.log('[plan] Usage data received');
            resolve({
              fiveHour: parsed.five_hour || null,
              sevenDay: parsed.seven_day || null,
              sevenDayOpus: parsed.seven_day_opus || null,
              sevenDaySonnet: parsed.seven_day_sonnet || null,
              extraUsage: parsed.extra_usage || null,
            });
          } catch (e) {
            console.log(`[plan] Usage API parse error: ${e.message} — body: ${data.slice(0, 200)}`);
            resolve(null);
          }
        });
      }
    );
    req.on('error', (e) => {
      console.log(`[plan] Usage API network error: ${e.message}`);
      resolve(null);
    });
    req.on('timeout', () => {
      console.log('[plan] Usage API timeout');
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

/**
 * Start plan detection and usage polling.
 * Reads credentials on startup, detects plan type, polls usage for Max users.
 * Handles 429 rate limits with OAuth token refresh and exponential backoff.
 */
export function startPlanDetector(store) {
  let currentToken = null;
  let currentRefreshToken = null;
  let usageInterval = null;
  let consecutiveFailures = 0;
  let lastSuccessfulUsage = null;

  function adjustPollInterval() {
    if (usageInterval) clearInterval(usageInterval);
    const interval = consecutiveFailures === 0
      ? USAGE_POLL_MS
      : Math.min(USAGE_POLL_MS * Math.pow(2, consecutiveFailures), MAX_POLL_INTERVAL_MS);
    console.log(`[plan] Next usage poll in ${Math.round(interval / 1000)}s`);
    usageInterval = setInterval(pollUsage, interval);
  }

  async function detectPlan() {
    const creds = readCredentials();
    if (!creds) {
      console.log('[plan] No credentials found, defaulting to cost mode');
      store.updatePlanInfo({
        planType: null,
        rateLimitTier: null,
        displayMode: 'cost',
        tierName: null,
        usage: null,
        usageSource: null,
        usageTimestamp: null,
      });
      currentToken = null;
      currentRefreshToken = null;
      if (usageInterval) { clearInterval(usageInterval); usageInterval = null; }
      return;
    }

    const planType = creds.subscriptionType || null;
    const rateLimitTier = creds.rateLimitTier || null;
    const displayMode = resolveDisplayMode(planType);
    const tierName = friendlyTier(rateLimitTier);
    currentToken = creds.accessToken || null;
    currentRefreshToken = creds.refreshToken || null;

    console.log(`[plan] Detected: ${planType || 'unknown'} / ${rateLimitTier || 'unknown'} → ${displayMode} mode`);

    store.updatePlanInfo({
      planType,
      rateLimitTier,
      displayMode,
      tierName,
    });

    // Start usage polling for Max users
    if (displayMode === 'tokens' && currentToken && !usageInterval) {
      await pollUsage(); // Immediate first poll
      adjustPollInterval();
    } else if (displayMode !== 'tokens' && usageInterval) {
      clearInterval(usageInterval);
      usageInterval = null;
    }
  }

  async function pollUsage() {
    if (!currentToken) return;
    const result = await fetchUsage(currentToken);

    // Handle 429 rate limit — try token refresh
    if (result && result._error === 'rate_limited') {
      consecutiveFailures++;

      if (currentRefreshToken) {
        console.log(`[plan] Rate limited (attempt ${consecutiveFailures}), trying token refresh...`);
        const newTokens = await refreshOAuthToken(currentRefreshToken);
        if (newTokens) {
          currentToken = newTokens.accessToken;
          currentRefreshToken = newTokens.refreshToken;
          writeBackCredentials(newTokens);

          // Retry immediately with new token
          const retry = await fetchUsage(currentToken);
          if (retry && !retry._error) {
            consecutiveFailures = 0;
            lastSuccessfulUsage = retry;
            store.updatePlanInfo({ usage: retry, usageSource: 'oauth_api', usageTimestamp: Date.now() });
            adjustPollInterval();
            return;
          }
        }
      }

      // Refresh failed or unavailable — serve cached data if we have it
      if (lastSuccessfulUsage) {
        console.log('[plan] Serving cached usage data');
        store.updatePlanInfo({ usage: lastSuccessfulUsage, usageSource: 'cached', usageTimestamp: Date.now() });
      }
      adjustPollInterval();
      return;
    }

    // Handle success
    if (result && !result._error) {
      if (consecutiveFailures > 0) console.log('[plan] Usage fetch recovered after failures');
      consecutiveFailures = 0;
      lastSuccessfulUsage = result;
      store.updatePlanInfo({ usage: result, usageSource: 'oauth_api', usageTimestamp: Date.now() });
      adjustPollInterval();
      return;
    }

    // Handle other failures (network, parse, non-200)
    consecutiveFailures++;
    if (lastSuccessfulUsage) {
      store.updatePlanInfo({ usage: lastSuccessfulUsage, usageSource: 'cached', usageTimestamp: Date.now() });
    }
    adjustPollInterval();
  }

  // Initial detection
  detectPlan();

  // Re-check credentials periodically (plan could change, token could refresh)
  setInterval(detectPlan, CREDENTIALS_POLL_MS);
}