#!/bin/bash
# Deploy playAIStocks to AWS (Lambda + S3 + API Gateway)
# Prerequisites: AWS CLI configured, SAM CLI installed
#   brew install aws-sam-cli
#   aws configure
set -euo pipefail

STACK_NAME="playaistocks"
REGION="${AWS_REGION:-eu-central-1}"
TEMPLATE="aws/template.yaml"

echo "╔══════════════════════════════════════════════════════╗"
echo "║  playAIStocks — AWS Serverless Deploy               ║"
echo "╚══════════════════════════════════════════════════════╝"

# Check prerequisites
command -v sam >/dev/null 2>&1 || { echo "❌ SAM CLI not found. Install: brew install aws-sam-cli"; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "❌ AWS CLI not found. Install: brew install awscli"; exit 1; }

# Check for required env vars
if [ -z "${BINANCE_API_KEY:-}" ] || [ -z "${BINANCE_API_SECRET:-}" ]; then
  echo "⚠️  BINANCE_API_KEY and BINANCE_API_SECRET must be set as env vars"
  echo "   Export them or create a .env file and source it first."
  exit 1
fi

ENV="${DEPLOY_ENV:-production}"
echo "📦 Environment: ${ENV}"
echo "🌍 Region: ${REGION}"
echo ""

# Build
echo "🔨 Building Lambda package..."
sam build --template-file "$TEMPLATE" --use-container --region "$REGION"

# Deploy
echo "🚀 Deploying stack: ${STACK_NAME}..."
sam deploy \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    "BinanceApiKey=${BINANCE_API_KEY}" \
    "BinanceApiSecret=${BINANCE_API_SECRET}" \
    "TelegramBotToken=${TELEGRAM_BOT_TOKEN:-}" \
    "TelegramChatId=${TELEGRAM_CHAT_ID:-}" \
    "Environment=${ENV}" \
  --no-confirm-changeset

# Get outputs
echo ""
echo "📋 Stack outputs:"
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs" \
  --output table

# Deploy dashboard to S3
DASHBOARD_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='DashboardUrl'].OutputValue" \
  --output text | sed 's|http://||' | cut -d. -f1)

API_URL=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" \
  --output text)

echo ""
echo "🌐 Deploying dashboard to S3..."
# Inject API URL into dashboard HTML
sed "s|const API_BASE = window.location.origin;|const API_BASE = '${API_URL}';|" \
  public/index.html > /tmp/index-aws.html

aws s3 cp /tmp/index-aws.html "s3://${DASHBOARD_BUCKET}/index.html" \
  --content-type "text/html" \
  --region "$REGION"

rm /tmp/index-aws.html

echo ""
echo "✅ Deployment complete!"
echo ""
echo "   Dashboard: http://${DASHBOARD_BUCKET}.s3-website.${REGION}.amazonaws.com"
echo "   API:       ${API_URL}"
echo ""
echo "   Bot runs every 15 minutes automatically."
echo "   Monitor: aws logs tail /aws/lambda/${STACK_NAME}-TradingBotFunction --follow"
