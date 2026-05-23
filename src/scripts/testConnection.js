#!/usr/bin/.env node
import 'dotenv/config';
import { testConnection, testnetMode, paperMode } from '../exchange/binanceClient.js';
import logger from '../utils/logger.js';

async function main() {
  console.log('\n🔌 Testing Binance connection...\n');
  console.log(`  Mode:    ${paperMode ? '📄 PAPER (no auth)' : testnetMode ? '🧪 TESTNET' : '🔴 LIVE'}`);
  console.log(`  API Key: ${process.env.BINANCE_API_KEY ? '✓ set' : '✗ not set'}`);
  console.log(`  Secret:  ${process.env.BINANCE_API_SECRET ? '✓ set' : '✗ not set'}`);
  console.log('');

  const result = await testConnection();

  if (result.ok) {
    console.log('  ✅ Connection successful!');
    if (result.balance) {
      const usdt = result.balance.free?.USDT ?? result.balance.total?.USDT ?? 0;
      console.log(`  💰 USDT balance: ${Number(usdt).toFixed(2)}`);
    }
  } else {
    console.log(`  ❌ Connection failed: ${result.error}`);

    if (result.error?.includes('-2015') || result.error?.includes('Invalid API-key')) {
      if (testnetMode) {
        console.log(`
  ⚠️  API key error on TESTNET. Testnet requires separate keys — your real
     Binance keys will NOT work here.

  Steps to fix:
    1. Go to  https://testnet.binance.vision/
    2. Click  "Log in with GitHub"
    3. Click  "Generate HMAC_SHA256 Key"
    4. Copy the API Key and Secret shown
    5. Paste them into .env:

       BINANCE_API_KEY=<testnet_key>
       BINANCE_API_SECRET=<testnet_secret>
       BINANCE_TESTNET=true
       PAPER_MODE=false

    6. Run  npm run test:connection  again
`);
      } else {
        console.log(`
  ⚠️  Invalid API key for live Binance. Check:
    - Keys are from https://www.binance.com/en/my/settings/api-management
    - "Enable Spot & Margin Trading" permission is checked
    - IP whitelist (if set) includes your current IP
`);
      }
    } else if (result.error?.includes('ENOTFOUND') || result.error?.includes('network')) {
      console.log('\n  ⚠️  Network error — check your internet connection.');
    } else {
      console.log('\n  Check your ..env configuration and try again.');
    }

    logger.error(`Connection test failed: ${result.error}`);
  }
  console.log('');
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error));
  console.error(error);
  process.exitCode = 1;
});
