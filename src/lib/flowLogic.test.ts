/**
 * FLOW Logic Patches V3.1 - Unit Tests
 * 
 * Run with: npx tsx src/lib/flowLogic.test.ts
 */

import { detectSweep, detectCVD, detectAbsorption } from './orderFlow';
import type { Candle, AggTrade, FlowSettings } from './types';

interface DepthLevel {
  price: string;
  qty: string;
}

const defaultSettings: FlowSettings = {
  lookbackCandles: 20,
  sweepPercent: 0.05,
  wallMultiplier: 3,
  absorptionThreshold: 0.02,
  cvdNetRatio: 0.10,
  wallPersistMs: 3000,
  feeBps: 5,
  slippageBps: 2,
};

function createCandle(t: number, o: number, h: number, l: number, c: number, v: number = 100): Candle {
  return { t, o, h, l, c, v };
}

function createTrade(T: number, p: string, q: string, m: boolean): AggTrade {
  return { a: 0, p, q, f: 0, l: 0, T, m };
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ ${message}`);
    failed++;
  }
}

console.log('=== FLOW Logic Patches V3.1 - Unit Tests ===\n');

// FIX 1 Tests
console.log('FIX 1: Sweep Index Guard');

console.log('Test 1: Breakdown candle (close below swingLow) => sweep.pass === false');
const breakdownCandles: Candle[] = [
  createCandle(1, 102, 103, 101, 102),
  createCandle(2, 102, 103, 100, 101), // swing low = 100
  createCandle(3, 101, 102, 100, 101),
  createCandle(4, 101, 102, 101, 102),
  createCandle(5, 102, 102.5, 99.5, 99.5), // sweep: low = 99.5 (0.5% below 100)
  createCandle(6, 99.5, 100, 99.0, 99.0), // breakdown: close = 99.0 < 100
];
const breakdownResult = detectSweep(breakdownCandles, defaultSettings);
assert(breakdownResult.pass === false, 'sweep.pass === false');
assert(breakdownResult.value.includes('breakdown'), 'value contains "breakdown"');

console.log('\nTest 2: No-sweep series => sweep.pass === false (guard test)');
const noSweepCandles: Candle[] = [
  createCandle(1, 100, 101, 99, 100),
  createCandle(2, 100, 101, 99, 100),
  createCandle(3, 100, 101, 99, 100),
  createCandle(4, 100, 101, 99, 100),
  createCandle(5, 100, 101, 99, 100),
  createCandle(6, 100, 101, 99, 100),
];
const noSweepResult = detectSweep(noSweepCandles, defaultSettings);
assert(noSweepResult.pass === false, 'sweep.pass === false');
assert(noSweepResult.value === 'no sweep', 'value === "no sweep"');

console.log('\nTest 3: Valid sweep + same-candle hammer close above swingLow => pass true');
const validSweepCandles: Candle[] = [
  createCandle(1, 102, 103, 101, 102),
  createCandle(2, 102, 103, 100, 101), // swing low = 100
  createCandle(3, 101, 102, 100, 101),
  createCandle(4, 101, 102, 101, 102),
  createCandle(5, 102, 102.5, 99.5, 100.5), // sweep: low = 99.5, close = 100.5 > 100
  createCandle(6, 100.5, 101, 100, 101),
];
const validSweepResult = detectSweep(validSweepCandles, defaultSettings);
assert(validSweepResult.pass === true, 'sweep.pass === true');
assert(validSweepResult.direction === 'LONG', 'direction === "LONG"');

// FIX 2 Tests
console.log('\n\nFIX 2: CVD Flip Tolerance + Gross Volume Window');

console.log('Test 7: CVD noise: cvdTrend tiny, netRatio < 0.10 => cvd.pass false');
const cvdNoiseTrades: AggTrade[] = [
  createTrade(1, '100', '10', false),
  createTrade(2, '100', '10', true),
  createTrade(3, '100', '10', false),
  createTrade(4, '100', '10', true),
  createTrade(5, '100', '10', false),
  createTrade(6, '100', '10', true),
  createTrade(7, '100', '10', false),
  createTrade(8, '100', '10', true),
  createTrade(9, '100', '10', false),
  createTrade(10, '100', '10', true),
];
const cvdNoiseCandles: Candle[] = [
  createCandle(1, 100, 101, 99, 100),
  createCandle(2, 100, 101, 99, 100),
  createCandle(3, 100, 101, 99, 100),
  createCandle(4, 100, 101, 99, 100),
  createCandle(5, 100, 101, 99, 100),
  createCandle(6, 100, 101, 98, 98),
];
const cvdNoiseResult = detectCVD(cvdNoiseTrades, cvdNoiseCandles, defaultSettings);
assert(cvdNoiseResult.pass === false, 'cvd.pass === false');

console.log('\nTest 8: CVD divergence: price lower low vs min(last 5 lows) + netRatio >= 0.10 => pass true');
const cvdDivTrades: AggTrade[] = [
  createTrade(1, '100', '100', false),
  createTrade(2, '100', '50', true),
  createTrade(3, '100', '100', false),
  createTrade(4, '100', '50', true),
  createTrade(5, '100', '100', false),
  createTrade(6, '100', '50', true),
  createTrade(7, '100', '100', false),
  createTrade(8, '100', '50', true),
  createTrade(9, '100', '100', false),
  createTrade(10, '100', '50', true),
];
const cvdDivCandles: Candle[] = [
  createCandle(1, 100, 101, 99, 100),
  createCandle(2, 100, 101, 99, 100),
  createCandle(3, 100, 101, 99, 100),
  createCandle(4, 100, 101, 99, 100),
  createCandle(5, 100, 101, 99, 100),
  createCandle(6, 100, 101, 98, 98),
];
const cvdDivResult = detectCVD(cvdDivTrades, cvdDivCandles, defaultSettings);
assert(cvdDivResult.pass === true, 'cvd.pass === true');
assert(cvdDivResult.direction === 'LONG', 'direction === "LONG"');

console.log('\nTest 9: Delta flip with tiny flip ratio => pass false');
const deltaFlipTrades: AggTrade[] = [
  createTrade(1, '100', '10', true),
  createTrade(2, '100', '10', true),
  createTrade(3, '100', '10', true),
  createTrade(4, '100', '10', true),
  createTrade(5, '100', '10', true),
  createTrade(6, '100', '10', true),
  createTrade(7, '100', '10', true),
  createTrade(8, '100', '10', true),
  createTrade(9, '100', '10', true),
  createTrade(10, '100', '11', false),
];
const deltaFlipCandles: Candle[] = [
  createCandle(1, 100, 101, 99, 100),
  createCandle(2, 100, 101, 99, 100),
  createCandle(3, 100, 101, 99, 100),
  createCandle(4, 100, 101, 99, 100),
  createCandle(5, 100, 101, 99, 100),
  createCandle(6, 100, 101, 99.5, 99.5),
];
const deltaFlipResult = detectCVD(deltaFlipTrades, deltaFlipCandles, defaultSettings);
assert(deltaFlipResult.pass === false, 'cvd.pass === false');

// FIX 3 Tests
console.log('\n\nFIX 3: Wall Registry Correction');

console.log('Test 4: Stable wall constant size for 10s => counted persistent');
const stableWallDepth = {
  bids: Array.from({ length: 15 }, (_, i) => ({
    price: (100 - i * 0.1).toString(),
    qty: i === 0 ? '300' : '100',
  })),
  asks: Array.from({ length: 15 }, (_, i) => ({
    price: (100 + i * 0.1).toString(),
    qty: '100',
  })),
};
const stableWallTrades = [createTrade(Date.now(), '100', '10', true)];
const stableWallCandles = [
  createCandle(1, 100, 101, 99, 100),
  createCandle(2, 100, 101, 99, 100.5),
];

// Simulate multiple snapshots over 10s
for (let i = 0; i < 5; i++) {
  detectAbsorption(stableWallDepth, stableWallTrades, stableWallCandles, defaultSettings);
  const waitUntil = Date.now() + 2000;
  while (Date.now() < waitUntil) {}
}

const stableWallResult = detectAbsorption(stableWallDepth, stableWallTrades, stableWallCandles, defaultSettings);
assert(stableWallResult.pass === true, 'absorption.pass === true');
assert(stableWallResult.direction === 'LONG', 'direction === "LONG"');

console.log('\nTest 5: Growing wall (+5%/s) => counted, stepUp true');
const growingWallTrades = [createTrade(Date.now(), '100', '10', true)];
const growingWallCandles = [
  createCandle(1, 100, 101, 99, 100),
  createCandle(2, 100, 101, 99, 100.5),
];

let growingWallDepth = {
  bids: Array.from({ length: 15 }, (_, i) => ({
    price: (100 - i * 0.1).toString(),
    qty: i === 0 ? '300' : '100',
  })),
  asks: Array.from({ length: 15 }, (_, i) => ({
    price: (100 + i * 0.1).toString(),
    qty: '100',
  })),
};

detectAbsorption(growingWallDepth, growingWallTrades, growingWallCandles, defaultSettings);

growingWallDepth = {
  bids: Array.from({ length: 15 }, (_, i) => ({
    price: (100 - i * 0.1).toString(),
    qty: i === 0 ? '315' : '100',
  })),
  asks: growingWallDepth.asks,
};

const growingWallResult = detectAbsorption(growingWallDepth, growingWallTrades, growingWallCandles, defaultSettings);
assert(growingWallResult.pass === true, 'absorption.pass === true');

console.log('\nTest 6: Spoof wall appears 500ms then vanishes => NOT counted');
const spoofWallTrades = [createTrade(Date.now(), '100', '10', true)];
const spoofWallCandles = [
  createCandle(1, 100, 101, 99, 100),
  createCandle(2, 100, 101, 99, 100.5),
];

let spoofWallDepth = {
  bids: Array.from({ length: 15 }, (_, i) => ({
    price: (100 - i * 0.1).toString(),
    qty: i === 0 ? '300' : '100',
  })),
  asks: Array.from({ length: 15 }, (_, i) => ({
    price: (100 + i * 0.1).toString(),
    qty: '100',
  })),
};

detectAbsorption(spoofWallDepth, spoofWallTrades, spoofWallCandles, defaultSettings);

const waitUntil = Date.now() + 500;
while (Date.now() < waitUntil) {}

spoofWallDepth = {
  bids: Array.from({ length: 15 }, (_, i) => ({
    price: (100 - i * 0.1).toString(),
    qty: '100',
  })),
  asks: spoofWallDepth.asks,
};

const spoofWallResult = detectAbsorption(spoofWallDepth, spoofWallTrades, spoofWallCandles, defaultSettings);
assert(spoofWallResult.pass === false, 'absorption.pass === false');

// Determinism Test
console.log('\n\nFIX 5: Determinism');

console.log('Test 10: Same input twice => identical flags (determinism)');
const detCandles = [
  createCandle(1, 102, 103, 101, 102),
  createCandle(2, 102, 103, 100, 101),
  createCandle(3, 101, 102, 100, 101),
  createCandle(4, 101, 102, 101, 102),
  createCandle(5, 102, 102.5, 99.5, 100.5),
  createCandle(6, 100.5, 101, 100, 101),
];

const detTrades = [
  createTrade(1, '100', '100', false),
  createTrade(2, '100', '50', true),
  createTrade(3, '100', '100', false),
  createTrade(4, '100', '50', true),
  createTrade(5, '100', '100', false),
  createTrade(6, '100', '50', true),
  createTrade(7, '100', '100', false),
  createTrade(8, '100', '50', true),
  createTrade(9, '100', '100', false),
  createTrade(10, '100', '50', true),
];

const detDepth = {
  bids: Array.from({ length: 15 }, (_, i) => ({
    price: (100 - i * 0.1).toString(),
    qty: i === 0 ? '300' : '100',
  })),
  asks: Array.from({ length: 15 }, (_, i) => ({
    price: (100 + i * 0.1).toString(),
    qty: '100',
  })),
};

const sweep1 = detectSweep(detCandles, defaultSettings);
const sweep2 = detectSweep(detCandles, defaultSettings);
assert(JSON.stringify(sweep1) === JSON.stringify(sweep2), 'sweep results identical');

const cvd1 = detectCVD(detTrades, detCandles, defaultSettings);
const cvd2 = detectCVD(detTrades, detCandles, defaultSettings);
assert(JSON.stringify(cvd1) === JSON.stringify(cvd2), 'CVD results identical');

const abs1 = detectAbsorption(detDepth, detTrades, detCandles, defaultSettings);
const abs2 = detectAbsorption(detDepth, detTrades, detCandles, defaultSettings);
assert(JSON.stringify(abs1) === JSON.stringify(abs2), 'absorption results identical');

// Summary
console.log('\n\n=== Test Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);

if (failed > 0) {
  console.log('\nSome tests failed!');
} else {
  console.log('\nAll tests passed!');
}
