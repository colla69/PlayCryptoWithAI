# Binance Testnet Setup Guide

## Step 1: Get Testnet API Keys
1. Go to https://testnet.binance.vision/
2. Click "Log in with GitHub"
3. After login, click "Generate HMAC_SHA256 Key"
4. Copy the API Key and Secret Key shown

## Step 2: Configure .env
```
BINANCE_API_KEY=your_testnet_api_key
BINANCE_API_SECRET=your_testnet_secret_key
BINANCE_TESTNET=true
PAPER_MODE=false
```

## Step 3: Verify Connection
```bash
npm run test:connection
```
You should see "✅ Connection successful!" and your testnet USDT balance.

## Step 4: Start Live (Testnet) Trading
```bash
npm start
```

## Testnet Limitations
- Testnet resets periodically (balances may disappear)
- Not all trading pairs are available
- Market data may lag real Binance data
- Recommended test pairs: BTC/USDT, ETH/USDT

## Moving to Real Live Trading
1. Get real API keys from https://www.binance.com/en/my/settings/api-management
2. Set BINANCE_TESTNET=false (or remove it)
3. ⚠️ Start with small amounts and verify bot behavior carefully
4. Monitor the dashboard at http://localhost:3001
