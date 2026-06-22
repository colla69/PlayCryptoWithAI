/**
 * Pure voting math for the signal aggregator.
 *
 * Extracted from src/engine/signalAggregator.js so that the live aggregator,
 * the PortfolioBacktester, and the perSymbolOptimizer all consume the
 * SAME function. This guarantees byte-identical decisions across:
 *
 *   • src/engine/signalAggregator.js     (live + PortfolioBacktester)
 *   • src/scripts/perSymbolOptimizer.mjs (optimizer fast loop)
 *   • tests/aggregatorParity.test.mjs    (regression fixture)
 *
 * Any future change to confidence formulas MUST happen here. Trying to
 * patch the formula in just one caller will fail the parity fixture.
 *
 * ── Formula (Phase 1, confidence-weighted) ────────────────────────────────
 *
 * Each strategy emits a signal ∈ {BUY, SELL, HOLD} and a confidence ∈ [0, 1].
 * Each strategy contributes a *weighted vote* to the chosen direction:
 *
 *   vote_weight = algoWeight × strategy.confidence
 *
 * External signals contribute analogously, using their source weight in place
 * of algoWeight:
 *
 *   vote_weight = sourceWeight(signal.source) × signal.confidence
 *
 * The winning direction is the one with the largest summed vote_weight.
 *
 * The reported `confidence` of the aggregate decision is the winner's vote
 * weight averaged over the **total number of voting strategies** (HOLD votes
 * INCLUDED in the denominator):
 *
 *   confidence = winner_vote_weight / total_voters
 *
 * Properties of this formula:
 *   • Confidence is bounded in [0, 1].
 *   • 3/3 unanimous BUY with conf 1.0  →  3.0 / 3  =  1.00
 *   • 3/3 unanimous BUY with conf 0.6  →  1.8 / 3  =  0.60
 *   • 2/3 BUY conf 1.0 + 1 HOLD        →  2.0 / 3  =  0.67   (was 1.00 before)
 *   • 2/3 BUY conf 1.0 + 1 SELL        →  2.0 / 3  =  0.67   (was 0.67 before)
 *   • 1/3 BUY conf 1.0 + 2 HOLD        →  1.0 / 3  =  0.33   (was 1.00 before)
 *
 *   This *fixes* the prior bug where 2/3 BUY + 1 HOLD = 3/3 BUY = 1.00,
 *   making `minConfidence` granular and meaningful again.
 *
 *   HOLD signals are counted in the denominator but their contribution to
 *   any direction is zero. Signals with confidence 0 contribute nothing
 *   numerically but still count as a voter (preventing a single confident
 *   strategy from over-influencing a quiet committee).
 *
 * The function is intentionally pure: no logger, no side effects, no
 * config-mutation. Callers handle logging, side effects, and threshold
 * comparison around the returned object.
 *
 * @param {object} args
 * @param {Array<{signal:'BUY'|'SELL'|'HOLD', confidence:number}>} args.strategySignals
 * @param {Array<{signal:'BUY'|'SELL'|'HOLD', confidence:number, source?:string}>} [args.externalSignals]
 * @param {number} [args.algoWeight=1]
 * @param {(source:string) => number} [args.getSourceWeight]
 * @returns {{
 *   winner: 'BUY' | 'SELL' | 'HOLD',
 *   winnerVoteWeight: number,
 *   totalVoters: number,
 *   confidence: number,
 *   tie: boolean,
 *   votes: { BUY: number, SELL: number, HOLD: number }
 * }}
 */
export function aggregateVotes({
  strategySignals = [],
  externalSignals = [],
  algoWeight = 1,
  getSourceWeight = () => 1,
} = {}) {
  const votes = { BUY: 0, SELL: 0, HOLD: 0 };
  let totalVoters = 0;
  const safeAlgoWeight = Math.max(0, Number(algoWeight) || 0);

  for (const result of strategySignals) {
    if (!result || typeof result.signal !== 'string') continue;
    const signal = result.signal in votes ? result.signal : 'HOLD';
    const conf = clampConfidence(result.confidence);
    votes[signal] += safeAlgoWeight * conf;
    totalVoters += 1;
  }

  for (const ext of externalSignals) {
    if (!ext || typeof ext.signal !== 'string') continue;
    const signal = ext.signal in votes ? ext.signal : 'HOLD';
    const conf = clampConfidence(ext.confidence);
    const sourceWeight = Math.max(0, Number(getSourceWeight(ext.source)) || 0);
    votes[signal] += sourceWeight * conf;
    totalVoters += 1;
  }

  const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  const [topSignal = 'HOLD', topWeight = 0] = ranked[0] ?? [];
  // When NO strategy contributes any weight (all HOLDs at conf 0, or empty
  // input), default to HOLD rather than picking the first sort entry.
  const winner = topWeight <= 0 ? 'HOLD' : topSignal;
  const winnerVoteWeight = topWeight;
  const tie = ranked.filter(([, w]) => Math.abs(w - winnerVoteWeight) < 1e-9).length > 1;
  const confidence = totalVoters > 0
    ? Number((winnerVoteWeight / totalVoters).toFixed(4))
    : 0;

  return { winner, winnerVoteWeight, totalVoters, confidence, tie, votes };
}

/**
 * Clamp a confidence value to [0, 1]. Treats non-finite / non-numeric as 0.
 */
export function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export default aggregateVotes;
