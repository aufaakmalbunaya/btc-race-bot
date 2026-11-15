// Bounce hunter: a long-only cbBTC/USDC bot for the 24h bars-replay race.
//
// Idea: on 1-minute bars BTC spends most of its time drifting, so chasing every
// wiggle loses the ~28 bps a round trip costs in fees, slippage and impact.
// This bot trades rarely, only two setups, and lets winners run with a
// trailing stop instead of selling at the first uptick:
//
//   A) Oversold bounce: RSI(14) crosses back up through 30 while the close
//      sits at least 2% under its 120-minute mean (a real dip, not noise),
//      buy with the whole equity.
//   B) Breakout: the close beats every close of the last 60 minutes and sits
//      above EMA(20), buy with half the equity.
//
// Exits (from the entry close): +5% target, -0.8% stop, a 0.6% trailing stop
// once in profit, or 120 bars max hold. One position at a time, never a
// second buy while holding. All math is float64 on the closes, seeded only
// from the bars themselves, so two runs answer every batch identically.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const RSI_PERIOD = 14;
const RSI_OVERSOLD = 30;
const SMA_SPAN = 120;
const DIP_BPS = 200; // entry A needs close >= 2% under the 120-bar mean
const BREAKOUT_BARS = 60;
const EMA_SPAN = 20;
const TARGET_BPS = 500; // +5% from the entry close
const STOP_BPS = 80; // -0.8% from the entry close
const TRAIL_BPS = 60; // 0.6% trailing stop, only while in profit
const MAX_HOLD_BARS = 120;
const MAX_SLIPPAGE_BPS = 100;

const closes: number[] = [];
let ema20: number | null = null;
let rsi: number | null = null;
let prevRsi: number | null = null;
let avgGain = 0;
let avgLoss = 0;
let entryClose: number | null = null;
let peakClose: number | null = null;
let holdBars = 0;

function pushClose(c: number): void {
  closes.push(c);
  // EMA(20), seeded on the first close.
  ema20 = ema20 === null ? c : ema20 + (2 / (EMA_SPAN + 1)) * (c - ema20);
  // RSI(14), Wilder smoothing, seeded on the mean of the first 14 moves.
  if (closes.length > 1) {
    const d = c - closes[closes.length - 2];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    if (closes.length <= RSI_PERIOD + 1) {
      avgGain += g;
      avgLoss += l;
      if (closes.length === RSI_PERIOD + 1) {
        avgGain /= RSI_PERIOD;
        avgLoss /= RSI_PERIOD;
        rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      avgGain = (avgGain * (RSI_PERIOD - 1) + g) / RSI_PERIOD;
      avgLoss = (avgLoss * (RSI_PERIOD - 1) + l) / RSI_PERIOD;
      rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
}

function sma120(): number | null {
  if (closes.length < SMA_SPAN) return null;
  let s = 0;
  for (let i = closes.length - SMA_SPAN; i < closes.length; i++) s += closes[i];
  return s / SMA_SPAN;
}

await runBars({
  onBatch(state: BarsState) {
    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    const c = Number(bar.c);
    prevRsi = rsi;
    pushClose(c);
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const held = state.positions.get(SYMBOL);
    const orders: (BuyInput | SellInput)[] = [];

    if (held !== undefined) {
      // Holding: entryClose is kept until the position is really gone, so a
      // sell the market refuses is sent again on the next bar.
      if (entryClose === null) entryClose = c;
      holdBars += 1;
      peakClose = peakClose === null ? c : Math.max(peakClose, c);
      const up = c >= entryClose * (1 + TARGET_BPS / 10000);
      const down = c <= entryClose * (1 - STOP_BPS / 10000);
      const trailed = peakClose !== null && c > entryClose && c <= peakClose * (1 - TRAIL_BPS / 10000);
      const stale = holdBars >= MAX_HOLD_BARS;
      if (up || down || trailed || stale) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      return orders.slice(0, caps.max_orders_per_bar);
    }

    // Flat: the old entry is done, clear its state, then look for an entry.
    entryClose = null;
    peakClose = null;
    holdBars = 0;
    let sizeBps: number | null = null;
    const mean = sma120();
    const rsiBounce = rsi !== null && prevRsi !== null && rsi > RSI_OVERSOLD && prevRsi <= RSI_OVERSOLD;
    if (rsiBounce && mean !== null && c <= mean * (1 - DIP_BPS / 10000)) {
      sizeBps = 10000; // whole equity on a confirmed oversold bounce
    } else if (closes.length > BREAKOUT_BARS && ema20 !== null && c > ema20) {
      let best = -Infinity;
      for (let i = closes.length - BREAKOUT_BARS - 1; i < closes.length - 1; i++) best = Math.max(best, closes[i]);
      if (c > best) sizeBps = 5000; // half equity on a 60-minute breakout
    }
    if (sizeBps === null) return [];
    const notional = (state.cash * BigInt(sizeBps)) / 10000n;
    if (notional < BigInt(fees.min_notional_quote_units)) return [];
    entryClose = c;
    peakClose = c;
    holdBars = 0;
    orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
    return orders.slice(0, caps.max_orders_per_bar);
  },
});
