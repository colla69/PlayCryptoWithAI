import signalBus from './signalBus.js';
import logger from '../utils/logger.js';

const POSITIVE_WORDS = ['bullish', 'bull', 'buy', 'long', 'moon', 'pump', 'breakout', 'rally', 'surge', 'green', 'up', 'gains', 'profit', 'hodl', 'accumulate', 'support'];
const NEGATIVE_WORDS = ['bearish', 'bear', 'sell', 'short', 'dump', 'crash', 'drop', 'red', 'down', 'loss', 'panic', 'fear', 'correction', 'breakdown', 'resistance'];

export function startTwitterSentiment(config = {}) {
  const {
    bearerToken,
    symbols = [],
    intervalMs = 300_000,
    minTweets = 5,
    confidenceThreshold = 0.1,
  } = config;

  if (!bearerToken) {
    logger.warn('Twitter Bearer Token not set — sentiment analysis disabled');
    return null;
  }

  async function analyzeSentiment(symbol) {
    const coin = symbol.split('/')[0];
    const queries = [`$${coin}`, `#${coin}`, `${coin} crypto`];
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(`(${queries.join(' OR ')}) -is:retweet lang:en`)}&max_results=100&tweet.fields=text,created_at,public_metrics`;

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${bearerToken}` },
      });

      if (!response.ok) {
        logger.warn(`Twitter API error for ${symbol}: ${response.status} ${response.statusText}`);
        return;
      }

      const data = await response.json();
      const tweets = data.data ?? [];

      if (tweets.length < minTweets) {
        logger.debug(`Twitter: not enough tweets for ${symbol} (${tweets.length}/${minTweets})`);
        return;
      }

      let totalScore = 0;
      let scoredTweets = 0;

      for (const tweet of tweets) {
        const text = String(tweet.text ?? '').toLowerCase();
        let score = 0;

        for (const word of POSITIVE_WORDS) {
          if (text.includes(word)) {
            score += 1;
          }
        }

        for (const word of NEGATIVE_WORDS) {
          if (text.includes(word)) {
            score -= 1;
          }
        }

        const engagement = (tweet.public_metrics?.like_count ?? 0) + (tweet.public_metrics?.retweet_count ?? 0);
        const weight = Math.log2(1 + engagement) + 1;
        totalScore += score * weight;
        scoredTweets += 1;
      }

      const normalizedScore = scoredTweets > 0 ? totalScore / scoredTweets : 0;
      const confidence = Math.min(0.9, Math.abs(normalizedScore) / 3);

      if (Math.abs(normalizedScore) < confidenceThreshold || confidence < 0.1) {
        logger.debug(`Twitter: neutral sentiment for ${symbol} (score: ${normalizedScore.toFixed(2)})`);
        return;
      }

      const signal = normalizedScore > 0 ? 'BUY' : 'SELL';
      const payload = {
        symbol,
        signal,
        source: 'twitter_sentiment',
        confidence: Number(confidence.toFixed(2)),
        reason: `Twitter sentiment score ${normalizedScore.toFixed(2)} from ${tweets.length} tweets`,
        timestamp: Date.now(),
      };

      signalBus.emit('signal', payload);
      logger.info(`${symbol}: Twitter sentiment → ${signal} score=${normalizedScore.toFixed(2)} tweets=${tweets.length} confidence=${confidence.toFixed(2)}`);
    } catch (error) {
      logger.error(`Twitter sentiment analysis failed for ${symbol}: ${error.message}`);
    }
  }

  async function runAnalysis() {
    await Promise.allSettled(symbols.map((symbol) => analyzeSentiment(symbol)));
  }

  void runAnalysis();
  const interval = setInterval(() => void runAnalysis(), intervalMs);
  logger.info(`Twitter sentiment started for ${symbols.join(', ')} every ${intervalMs / 1000}s`);
  return { interval, stop: () => clearInterval(interval) };
}

export default startTwitterSentiment;
