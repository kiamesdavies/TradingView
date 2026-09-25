# Market study: which non-US markets to add for momentum swing trading

*Run 2026-09-25 on EODHD data (bulk snapshot dated 2026-09-24, daily history 2014-01 to 2026-09). It used about 6.2k API credits. Scripts are in the session scratchpad, not in this repo.*

## Executive summary

The goal is to capture price momentum over holding periods of days to weeks. For each market we asked three things. (1) Does EODHD give us the data we need? (2) Are there enough liquid names that are actually moving? (3) Has momentum paid there since 2014, in both halves of the period?

- **Data is not the constraint.** Every exchange EODHD serves passed the basic checks: daily OHLCV back to 2014, bulk end-of-day with EMA50/200, 52-week high/low and 50-day average volume, and fundamentals with reported EPS, report dates and consensus estimates. Intraday 1h/5m bars exist for all of them; Taiwan's history there is only recent. Things the US has that nobody else does: analyst ratings/target prices, institutional holders, insider transactions, and a realtime websocket (non-US quotes are about 15 minutes delayed). KOSDAQ is missing EPS estimates. Hong Kong, Tokyo, NSE India and Milan are **not in this plan's exchange list**, so they were skipped.
- **Liquidity plus action picks the shortlist.** Outside the US, the markets with 100 or more stocks trading at least $5M a day are TW (312), LSE (242), TO (220), KO (189), KQ (174), AU (173), TWO (118) and XETRA (107). Stockholm has 75 and Oslo 34. China A has thousands of liquid names, but foreigners can only reach it through Stock Connect.
- **Where momentum paid historically, measured three ways:**
  - Monthly cross-sectional 6-1 and 12-1 momentum
  - Continuation after a stock rises 25% or more in 20 sessions while above its 50-day SMA
  - Follow-through after a 52-week high on at least twice the average volume

  **Oslo, Australia, Taiwan (TW + TWO), the US and XETRA** were the strongest and most stable. Oslo is the standout: top-quintile 12-1 beat its universe by +14.9%/yr (t = 4.3), with t ≥ 2.8 in both subperiods. Taiwan's continuation and breakout edge was the strongest anywhere: t around 6 to 9 on 20-session excess returns.
- **Most of Europe (including Stockholm, SIVE's market) is middling.** Slow 6-12 month momentum works (+5 to 10%/yr, t around 2 to 3). Buying *after* a 25% spike does not pay on average: the mean 20-session excess return is about 0, the median is negative, and fewer than half the events beat the market. Breakouts give a small positive drift (+0.7 to 1.6% over 20 sessions).
- **Avoid:** TSX Venture (spikes reverse: −7.3% mean 20-session excess, t = −15.7, and only 3 names trade ≥$5M a day), China A (no cross-sectional momentum, −5%/yr since 2021, max drawdown −42 to −51%), and KOSPI for continuation-style entries (−1.7%, t = −2.7).
- **SIVE / Stockholm.** Stockholm is a *good-data, medium-liquidity, medium-momentum* market. It is worth keeping on because you trade it, but it is not a top-tier momentum market. SIVE itself is one of Stockholm's most active names: #27 by dollar volume, about $24M a day. It is also an extreme lottery-type stock: 3 → 102 SEK from February to June 2026, then down 74%, with a 180% annualised volatility.

### Ranked recommendation

| Tier | Markets | Why |
|---|---|---|
| **Tier 1 (enable)** | **US** (baseline), **AU** (ASX), **TW** (TWSE), **OL** (Oslo), **XETRA** | Strong and stable momentum across all three tests plus adequate liquidity. AU and XETRA are accessible to retail traders and have full data. Two caveats. TW: foreign retail access is limited at many brokers, and survivorship bias is largest there because of the AI supply-chain run. OL: thin liquidity, with only 34 names ≥$5M/day. |
| **Tier 2 (optional)** | **ST** (keep on: your market), **TWO**, **TO**, **HE**, **MC**, **CO**, **SW**, **PA**, **AS**, **LSE**, **KQ** | Momentum is positive but weaker or less stable, or liquidity is thin. TWO has a huge edge but small names and access issues. TO is very liquid and in your time zone, but its spike-continuation is flat. LSE has deep liquidity but the weakest European momentum, around 0 since 2021. KQ has fat right-tail payoffs (positive mean, −3.9% median). |
| **Not recommended** | **V** (TSX Venture), **SHG**, **SHE** (China A), **KO** (KOSPI) | Spike reversal, or no momentum premium. China and Korea also have broker access problems. |

Composite score (0.5·edge z + 0.2·subperiod-stability z + 0.3·log-liquidity z): TWO 0.95, US 0.88, TW 0.80, AU 0.66, OL 0.64, XETRA 0.32, MC 0.17, HE 0.16, SHE 0.11, SW −0.07, KQ −0.09, SHG −0.09, ST −0.11, TO −0.12, CO −0.18, PA −0.20, LSE −0.28, AS −0.34, KO −0.40, V −2.82.

---

## 1. Liquidity and action snapshot (2026-09-24, common stocks, USD at spot FX)

"ADV" means close × 50-day average volume, in USD. Range, % above EMA and near-high are measured on names with ADV ≥ $1M. "2x" counts names at 2 times or more their 52-week low.

| Ex | Common | ADV≥$1M | ≥$5M | ≥$20M | Median 52w hi/lo | >EMA50 | >EMA200 | ≤5% from 52wH | 2x off low | Mcap >$10B | $1-10B |
|---|---|---|---|---|---|---|---|---|---|---|---|
| US | 6006 | 4110 | 3071 | 2117 | 1.91 | 30% | 44% | 392 | 598 | 950 | 1638 |
| TO | 837 | 385 | 220 | 112 | 1.73 | 45% | 57% | 47 | 55 | 197 | 202 |
| V | 1026 | 15 | 3 | 1 | 2.58 | 53% | 73% | 0 | 9 | 1 | 8 |
| LSE | 1469 | 513 | 242 | 108 | 1.51 | 47% | 64% | 157 | 40 | 112 | 297 |
| XETRA | 690 | 201 | 107 | 53 | 1.64 | 36% | 57% | 32 | 20 | 269* | 134 |
| PA | 608 | 135 | 80 | 48 | 1.52 | 30% | 43% | 19 | 11 | 50 | 101 |
| AS | 100 | 60 | 41 | 25 | 1.57 | 42% | 60% | 16 | 1 | 29 | 29 |
| **ST** | 861 | 181 | 75 | 30 | 1.56 | 57% | 64% | 51 | 13 | 50 | 128 |
| OL | 293 | 81 | 34 | 10 | 1.69 | 57% | 69% | 23 | 16 | 13 | 58 |
| CO | 158 | 45 | 29 | 11 | 1.59 | 60% | 60% | 19 | 3 | 14 | 32 |
| HE | 189 | 39 | 21 | 10 | 1.52 | 62% | 72% | 12 | 6 | 17 | 28 |
| SW | 217 | 125 | 76 | 34 | 1.51 | 45% | 58% | 29 | 8 | 45 | 85 |
| MC | 232 | 57 | 38 | 19 | 1.47 | 40% | 53% | 17 | 3 | 26 | 52 |
| AU | 1808 | 336 | 173 | 74 | 1.78 | 39% | 45% | 51 | 40 | 43 | 187 |
| KO | 936 | 344 | 189 | 104 | 2.21 | 41% | 42% | 11 | 69 | 63 | 171 |
| KQ | 1824 | 461 | 174 | 55 | 3.10 | 61% | 47% | 17 | 137 | 1 | 66 |
| TW | 1101 | 519 | 312 | 161 | 1.99 | 58% | 71% | 82 | 158 | 68 | 195 |
| TWO | 1094 | 255 | 118 | 56 | 2.58 | 57% | 74% | 15 | 109 | 6 | 50 |
| SHG | 2242 | 2221 | 1995 | 1163 | 1.87 | 43% | 30% | 71 | 175 | 174 | 1063 |
| SHE | 2786 | 2776 | 2607 | 1399 | 1.91 | 42% | 28% | 74 | 202 | 105 | 1096 |

\*XETRA's large-cap count is inflated by cross-listed foreign names that report home-currency market caps. The ADV counts are not affected. The universe was filtered to home-currency listings (GBX/GBP for LSE) and, for the US, to NASDAQ/NYSE/AMEX (no OTC).

## 2. Momentum history (2014-01 to 2026-09)

**Universe per market:** the 120 most liquid common stocks today plus 30 names sampled from liquidity ranks 121-400, about 150 names each (2,857 in total). All returns use `adjusted_close` in local currency, so they are currency-neutral within a market. Daily returns above +200% or below −75% are treated as data errors and masked. Daily returns are then clipped to [−60%, +150%] and monthly returns to [−90%, +300%]. "Excess" means minus the equal-weight return of the same universe.

### 2a. Monthly cross-sectional momentum: top quintile minus universe, equal weight

| Ex | 6-1 ann. excess (t) | 12-1 ann. excess (t) | 12-1 hit | 12-1 MaxDD | 12-1 2014-20 | 12-1 2021-26 | 6-1 2014-20 | 6-1 2021-26 |
|---|---|---|---|---|---|---|---|---|
| US | 12.5% (2.7) | 10.4% (2.2) | 58% | −25% | 5.9% (1.6) | 14.9% (1.7) | 10.5% (2.9) | 14.7% (1.6) |
| TO | 8.3% (1.9) | 7.2% (1.6) | 57% | −22% | 3.6% (0.5) | 10.9% (1.7) | 7.5% (1.2) | 9.1% (1.5) |
| V | −3.6% (−0.6) | −4.0% (−0.6) | 51% | −68% | −13.1% | 5.3% | −16.1% | 10.1% |
| LSE | 3.1% (1.2) | 4.1% (1.6) | 57% | −20% | 5.9% (1.5) | 2.2% (0.7) | 6.3% (1.7) | −0.5% (−0.2) |
| XETRA | 9.6% (3.1) | 6.7% (2.1) | 58% | −14% | 3.5% (1.2) | 9.9% (1.8) | 10.0% (3.6) | 9.2% (1.6) |
| PA | 6.2% (2.4) | 5.8% (2.2) | 63% | −13% | 10.2% (2.5) | 1.3% (0.4) | 5.1% (1.4) | 7.5% (1.9) |
| AS | 3.2% (1.2) | 5.9% (1.9) | 58% | −23% | 5.5% (1.0) | 6.3% (1.8) | 2.8% (0.7) | 3.7% (0.9) |
| **ST** | 5.5% (2.0) | 7.0% (2.6) | 58% | −12% | 9.2% (2.5) | 4.8% (1.2) | 6.8% (2.0) | 4.1% (0.9) |
| **OL** | **15.6% (4.3)** | **14.9% (4.3)** | 64% | −14% | 16.5% (3.2) | 13.4% (2.8) | 15.2% (2.9) | 16.1% (3.3) |
| CO | 5.6% (2.3) | 5.2% (2.2) | 51% | −12% | 7.1% (2.3) | 3.3% (0.9) | 7.4% (2.1) | 3.7% (1.0) |
| HE | 10.4% (4.3) | 7.7% (3.1) | 57% | −16% | 9.1% (2.4) | 6.2% (2.0) | 9.7% (2.9) | 11.1% (3.1) |
| SW | 4.3% (1.8) | 3.6% (1.7) | 56% | −18% | 4.3% (1.8) | 2.8% (0.8) | 5.5% (1.7) | 3.0% (0.8) |
| MC | 9.6% (3.5) | 9.6% (3.2) | 65% | −16% | 11.5% (2.2) | 7.7% (2.4) | 10.0% (2.4) | 9.2% (2.6) |
| **AU** | **15.3% (3.8)** | **13.1% (3.4)** | 60% | −18% | 9.5% (1.9) | 16.9% (2.8) | 11.8% (2.3) | 19.3% (3.0) |
| KO | 6.2% (1.4) | 8.9% (2.0) | 55% | −24% | 7.5% (1.5) | 10.3% (1.4) | 2.4% (0.5) | 10.4% (1.4) |
| KQ | 5.9% (1.2) | 5.1% (1.1) | 48% | −34% | 2.6% (0.5) | 7.7% (1.0) | 11.9% (2.0) | −0.8% (−0.1) |
| **TW** | **14.0% (3.7)** | 9.2% (2.2) | 58% | −25% | 2.9% (0.7) | 15.7% (2.2) | 10.1% (2.4) | 18.3% (2.8) |
| **TWO** | **13.8% (3.6)** | 11.1% (2.6) | 59% | −34% | 4.7% (1.0) | 17.6% (2.4) | 11.5% (2.9) | 16.3% (2.4) |
| SHG | −0.9% (−0.2) | 0.4% (0.1) | 50% | −51% | 5.6% (0.8) | −4.9% (−0.6) | −3.5% (−0.7) | 2.0% (0.3) |
| SHE | 4.3% (0.6) | 1.9% (0.3) | 51% | −42% | 8.3% (0.7) | −4.7% (−0.6) | 14.3% (1.3) | −6.8% (−1.0) |

### 2b. Swing continuation: stock up ≥25% in 20 sessions **and** above its 50-day SMA

Events are de-duplicated per stock (20-session cooldown). Returns are forward from the event close. "x" = excess over the market's equal-weight return. "Events/100/yr" = events per 100 stocks per year, which measures how much action a market offers.

| Ex | Events | /100/yr | x10 mean | x20 mean | x20 median | Beat mkt | Raw >0 | t(x20) | x20 2014-20 | x20 2021-26 |
|---|---|---|---|---|---|---|---|---|---|---|
| US | 1650 | 101 | +1.2% | **+2.2%** | −0.6% | 48% | 58% | **4.2** | +0.2% | +3.1% |
| TO | 1582 | 96 | −0.6% | −0.1% | −1.6% | 44% | 54% | −0.2 | 0.0% | −0.1% |
| V | 4212 | 320 | −4.9% | **−7.3%** | −10.2% | 31% | 40% | **−15.7** | −13.0% | −2.8% |
| LSE | 637 | 36 | +0.2% | +0.5% | −1.0% | 46% | 53% | 0.8 | −0.9% | +2.1% |
| XETRA | 1096 | 67 | +0.6% | +1.2% | −0.4% | 49% | 54% | 2.7 | +0.2% | +1.8% |
| PA | 1067 | 60 | +0.5% | −0.1% | −2.2% | 41% | 47% | −0.2 | −0.3% | 0.0% |
| AS | 598 | 62 | +0.6% | +0.9% | −1.4% | 44% | 49% | 0.9 | +1.2% | +0.6% |
| **ST** | 1215 | 76 | −0.4% | −0.2% | −1.4% | 44% | 49% | −0.5 | −0.7% | +0.1% |
| OL | 1274 | 99 | −0.2% | −0.2% | −2.2% | 44% | 49% | −0.3 | −1.0% | +0.5% |
| CO | 767 | 64 | +0.3% | +0.1% | −1.9% | 43% | 51% | 0.2 | +0.3% | −0.1% |
| HE | 816 | 64 | −0.5% | −0.2% | −2.5% | 41% | 47% | −0.3 | −1.6% | +1.2% |
| SW | 533 | 36 | +1.1% | +1.7% | −1.1% | 47% | 52% | 1.4 | +2.0% | +1.5% |
| MC | 796 | 61 | −0.4% | −0.5% | −3.0% | 40% | 46% | −0.8 | +1.0% | −2.4% |
| AU | 1679 | 101 | +0.7% | **+1.8%** | −1.1% | 46% | 52% | **3.1** | +1.1% | +2.4% |
| KO | 1328 | 81 | −1.5% | **−1.7%** | −4.2% | 40% | 48% | **−2.7** | −3.1% | −1.1% |
| KQ | 2188 | 169 | +1.5% | +1.8% | −3.9% | 41% | 49% | 2.9 | +0.8% | +2.1% |
| TW | 2020 | 115 | +1.7% | **+2.7%** | −0.7% | 48% | 57% | **6.1** | +1.4% | +3.4% |
| TWO | 2600 | 165 | +2.2% | **+2.7%** | −1.7% | 45% | 54% | **6.4** | +1.8% | +3.2% |
| SHG | 2479 | 187 | +0.4% | +0.7% | −3.3% | 42% | 49% | 1.8 | −0.1% | +1.1% |
| SHE | 3305 | 209 | +1.2% | +1.0% | −3.3% | 41% | 52% | 2.7 | +0.4% | +1.5% |

In every market the median is negative while the mean is positive where there is an edge. Continuation payoffs are right-skewed: a few runners pay for many small failures. Tight stops and letting winners run are therefore structural requirements, not style choices.

**Small vs large caps** (current market cap below or above $1B) for x20 mean / median: ST small −0.9% / −2.7% (n = 458) vs large +0.2% / −1.0% (n = 757). OL −0.3 / −2.9 vs −0.1 / −1.5. HE −0.1 / −2.8 vs −0.6 / −1.4. AU +1.4 / −5.5 vs +1.8 / −0.8. TWO +2.4 / −2.3 vs +3.1 / −1.1. In short, small caps have worse medians everywhere, and European small caps do not continue on average.

### 2c. Breakout follow-through: close above the prior 252-day high on ≥2x the 50-day average volume

| Ex | Events | /100/yr | x20 mean | x20 median | Beat | t | 2014-20 | 2021-26 |
|---|---|---|---|---|---|---|---|---|
| US | 1453 | 89 | +0.7% | −0.4% | 48% | 1.9 | +0.1% | +1.3% |
| TO | 1488 | 90 | +0.6% | −0.7% | 46% | 1.6 | +1.7% | −0.2% |
| V | 1163 | 88 | −3.1% | −6.3% | 37% | −3.2 | −10.9% | +0.3% |
| LSE | 1407 | 80 | +0.3% | −0.2% | 48% | 1.2 | 0.0% | +0.5% |
| XETRA | 1400 | 86 | +1.1% | +0.1% | 51% | 3.9 | +0.7% | +1.6% |
| PA | 1329 | 74 | +0.8% | −0.1% | 49% | 2.2 | +0.6% | +1.1% |
| AS | 676 | 70 | +1.1% | +0.1% | 51% | 2.2 | +1.9% | +0.4% |
| **ST** | 1525 | 95 | +0.7% | 0.0% | 50% | 2.5 | +0.7% | +0.8% |
| OL | 1366 | 106 | **+1.6%** | +0.6% | 53% | **4.6** | +1.3% | +1.8% |
| CO | 1114 | 93 | +1.1% | +0.4% | 53% | 3.4 | +1.3% | +1.0% |
| HE | 1157 | 91 | +1.3% | −0.2% | 49% | 3.0 | +1.0% | +1.7% |
| SW | 1274 | 87 | +0.8% | +0.5% | 54% | 3.3 | +0.6% | +0.9% |
| MC | 1081 | 83 | +1.0% | −0.2% | 49% | 2.4 | +1.8% | +0.4% |
| AU | 1448 | 87 | +1.2% | 0.0% | 50% | 3.2 | +1.5% | +0.9% |
| KO | 890 | 54 | +0.1% | −2.4% | 43% | 0.1 | +1.5% | −0.8% |
| KQ | 1149 | 89 | +3.1% | −3.5% | 43% | 3.5 | +1.0% | +3.5% |
| TW | 2512 | 143 | +1.9% | −0.7% | 47% | 5.9 | +1.7% | +2.0% |
| **TWO** | 2180 | 138 | **+3.6%** | −0.5% | 49% | **8.6** | +3.4% | +3.7% |
| SHG | 1229 | 93 | +1.3% | −2.2% | 43% | 2.4 | −0.3% | +2.4% |
| SHE | 1413 | 89 | +2.5% | −2.5% | 44% | 3.4 | +1.2% | +3.5% |

Breakouts are the most consistent positive signal across markets. Positive mean excess in both subperiods, with t > 2, holds in XETRA, ST, OL, CO, HE, SW, AU, TW and TWO.

### 2d. Tradeability and risk (last 2 years, the ~150-name universe)

| Ex | Median daily range (H−L)/C | Gap >3% freq | Median ann. vol |
|---|---|---|---|
| US | 2.68% | 9.7% | 42% |
| TO | 2.29% | 5.2% | 35% |
| V | 5.94% | 23.2% | 87% |
| LSE | 1.95% | 3.0% | 28% |
| XETRA | 2.31% | 4.7% | 35% |
| PA | 2.16% | 4.8% | 32% |
| AS | 2.07% | 5.4% | 33% |
| ST | 2.26% | 3.4% | 33% |
| OL | 2.57% | 7.5% | 35% |
| CO | 2.23% | 4.9% | 31% |
| HE | 2.34% | 3.7% | 34% |
| SW | 2.03% | 3.2% | 29% |
| MC | 2.10% | 4.3% | 28% |
| AU | 2.22% | 7.6% | 36% |
| KO | 3.68% | 9.9% | 59% |
| KQ | 5.24% | 14.4% | 85% |
| TW | 3.20% | 9.3% | 53% |
| TWO | 3.80% | 10.5% | 61% |
| SHG | 4.11% | 7.8% | 62% |
| SHE | 4.15% | 8.1% | 63% |

Taiwan, Korea and China carry ±10% daily price limits. These make gap and stop risk path-dependent: limit-locked stocks cannot be exited.

## 3. Data quality for swing trading (EODHD)

The sample was 5 names per market: the 3 most liquid plus liquidity ranks 61 and 101. The earnings calendar was checked for those names from March to December 2026. Intraday was checked with a 1h window in early 2022 and a recent window.

| Ex | Fund. OK | EPS actual ≥3q | EPS estimate ≥3q | reportDate | Analyst ratings | Holders/insider | Calendar rows (with estimate) | Intraday 1h/5m |
|---|---|---|---|---|---|---|---|---|
| US | 5/5 | 5 | 5 | 5 | **5** | **5 / 5** | 15 (15) | yes, 2022+ |
| TO | 5/5 | 5 | 5 | 5 | 0 | 0 | 14 (14) | yes |
| V | 5/5 | 2 | 2 | 2 | 0 | 0 | 8 (6) | yes |
| LSE | 5/5 | 5 | 5 | 5 | 0 | 0 | 14 (14) | yes (AZN 2022+) |
| XETRA | 5/5 | 5 | 4 | 5 | 0 | 0 | 16 (13) | yes |
| PA | 5/5 | 5 | 5 | 5 | 0 | 0 | 7 (7) | yes |
| AS | 4/5 | 3 | 3 | 3 | 0 | 0 | 9 (9) | yes |
| ST | 6/6 | 6 | 5 | 6 | 0 | 0 | 16 (12) | yes (SIVE 5m OK) |
| OL | 5/5 | 5 | 5 | 5 | 0 | 0 | 15 (15) | yes |
| CO | 5/5 | 5 | 3 | 5 | 0 | 0 | 11 (9) | yes |
| HE | 5/5 | 5 | 4 | 5 | 0 | 0 | 14 (10) | yes (NOKIA 2022+) |
| SW | 5/5 | 4 | 4 | 4 | 0 | 0 | 4 (4) | yes |
| MC | 5/5 | 5 | 4 | 5 | 0 | 0 | 12 (11) | yes |
| AU | 5/5 | 5 | 4 | 5 | 0 | 1 | 2 (1) (half-yearly reporting) | yes |
| KO | 5/5 | 5 | 5 | 5 | 0 | 0 | 16 (13) | yes |
| KQ | 5/5 | 5 | **0** | 5 | 0 | 0 | 3 (0) | yes |
| TW | 5/5 | 5 | 5 | 5 | 0 | 0 | 17 (17) | recent only (none in 2022) |
| TWO | 5/5 | 5 | 4 | 5 | 0 | 0 | 8 (8) | recent only |
| SHG/SHE | 5/5 | 4-5 | 4-5 | 4-5 | 0 | 0 | 8-12 | yes |

Other data notes:

- **Realtime:** the websocket covers US stocks, forex and crypto only. Other markets are served through `/real-time` delayed quotes (~15 min).
- **Screener:** the EODHD screener API is US-centric. Non-US screening has to be built from the per-exchange bulk EOD (100 credits per exchange per day).
- **Reporting cadence:** ASX and most UK companies report half-yearly, so AU and LSE have fewer earnings catalysts.

## 4. SIVE.ST: Sivers Semiconductors (Sivers IMA Holding AB)

| Metric | Value |
|---|---|
| Last close (2026-09-24) | 32.78 SEK; market cap ≈ 10.5B SEK (≈ $1.05B) |
| ADV, 20d / 50d / 250d | 220M / 241M / 336M SEK ≈ **$22M / $24M / $34M** per day; #27 in Stockholm by dollar volume |
| Daily turnover | ≈ 3.2% of free float (231.7M float shares) per day, 50d average |
| Median daily range (spread/risk proxy) | 11.2% (60d), 8.6% (250d), vs 4.8% in 2014-19 and a 2.3% Stockholm median |
| Gap >3% frequency (250d) | 34% of days (Stockholm median 3.4%) |
| Annualised volatility (250d) | ~180% |
| 52w range | 2.9 → 101.9 SEK (35x); now −68% from the high |
| 2026 path (month-end) | Feb 3.02 → Mar 10.7 → Apr 38.0 → May 69.0 → Jun 63.2 → Jul 30.7 → Aug 26.6 → Sep 32.8 |
| Calendar-year returns | 2020 +291%, 2021 −37%, 2022 −69%, 2023 +5%, 2024 −51%, 2025 +31%, 2026 YTD +689% |
| Fundamentals in EODHD | Quarterly EPS actuals and estimates with report dates (next report 2026-11-26, est. −0.10); float and insider % (21%) present; no analyst ratings |

**Momentum episodes:** 26 continuation events since 2014 (+25% in 20 sessions and above the SMA50). Mean 20-session excess was +18%, median +5%, and 58% beat the market. That is far better than the Stockholm average, but the mean is driven by three episodes: July 2020 (+111%), March 2026 (+220%) and April 2026 (+154%). The last event, on 2026-06-12, lost 53% in 20 sessions. Breakouts on 2x volume: 9 events, with the 2020-07 and 2026-03/04 breakouts returning +110% to +175% in 20 sessions.

**Segment:** EODHD does not expose Nasdaq Nordic segments. Sivers historically traded on First North and is now reported as a Nasdaq Stockholm listing. Verify Main Market (Mid/Small Cap) vs First North on nasdaqomxnordic.com before relying on index-inclusion or short-availability arguments. At about €0.95B market cap it would sit in the Mid Cap segment if it is on the Main Market.

**Verdict on Stockholm for momentum:**

- *For:* excellent data (EPS, estimates and dates for all sampled names; intraday available), plenty of mid-cap tech/defence/medtech momentum names, positive 12-1 momentum (+7%/yr, t = 2.6) and positive breakout follow-through (+0.7%, t = 2.5, stable across both periods).
- *Against:* only 75 names trade ≥$5M a day. Buying after a 25% spike has **not** paid on average (−0.2% mean, −1.4% median; small caps −0.9% / −2.7%). The 2021-26 cross-sectional premium weakened (12-1 t = 1.2). Stockholm is a place for *selective* breakout entries in the ~30-75 liquid names, not for scanning the whole list of 861 stocks.
- *SIVE specifically* is tradeable on liquidity: $20M+ a day comfortably absorbs retail size. Its range and gap profile, though, means position size should be set from an ~8-11% daily ATR, not from a Stockholm-typical 2%.

## 5. Literature cross-check (from memory; flagged as literature, not verified in this run)

- **Rouwenhorst (1998, J. Finance):** 12 European markets 1978-95. Winner-minus-loser momentum of about 1%/month, present in all 12 markets and stronger in small caps. This is consistent with our positive 6-1/12-1 results across Europe.
- **Griffin, Ji & Martin (2003, J. Finance):** momentum is profitable in most regions worldwide and is not explained by macro risk. Asia is the notable weak region.
- **Chui, Titman & Wei (2010, J. Finance):** momentum is stronger in countries with more *individualistic* cultures (Hofstede index; the US, UK, Australia, Nordics and Netherlands rank high) and weak or absent in collectivist East Asian markets. This fits Stockholm and Oslo having positive momentum and China A having none. Taiwan's post-2021 strength is an exception, probably driven by the AI capex theme.
- **Asness, Moskowitz & Pedersen (2013, J. Finance), "Value and Momentum Everywhere":** momentum is positive across the US, UK, Europe and Japan. **Japan is the famous exception**: momentum is near zero there on its own. Tokyo was not testable here (not in this EODHD plan).
- **China A:** the literature generally finds short-term *reversal* rather than momentum in retail-dominated A-shares, with price limits and T+1. Our SHG/SHE results (no 12-1 premium, negative since 2021) agree.

## 6. Method caveats

1. **Survivorship and look-ahead bias.** Universes are *today's* most liquid names. Stocks that were winners in 2014-2026 are over-represented, which inflates momentum and continuation results in absolute terms. The bias is largest where today's liquid names grew the most (TW/TWO AI supply chain, KQ, SIVE-style re-ratings). The 30 names drawn from ranks 121-400 only slightly mitigate it. **Compare markets relatively, not on absolute return levels.**
2. The size split uses *current* market cap, so a stock like SIVE counts as "large" throughout its history.
3. The sample is about 150 names per market, so results reflect the investable core, not micro caps. Only the V universe is mostly illiquid (only 15 names ≥$1M).
4. There are no transaction costs, spreads or borrow. Median 20-session excess returns are negative everywhere, and a 0.2-0.5% round trip removes much of the European edge.
5. Events overlap in time (cross-sectional clustering), so t-stats are overstated. Treat t < 3 as suggestive.
6. Markets not served by this EODHD plan: HK, TSE (Tokyo), NSE (India), MI (Milan).
7. Broker access is not modelled. Taiwan, Korea and China A are hard or impossible for typical foreign retail accounts. Europe, Canada and Australia are broadly available.

## 7. Credit usage

The `/api/user` counter went from `apiRequests` 50,207 to 56,399, a **delta of 6,192**. That is under the 8,000 budget, though the counter is shared with other work running the same day. The breakdown:

| Item | Credits |
|---|---|
| 20 bulk extended snapshots | 2,000 |
| 20 symbol lists and 11 FX quotes | ~31 |
| 2,857 per-ticker histories | 2,857 |
| 100 fundamentals | 1,000 |
| 20 earnings-calendar calls | 20 |
| ~50 intraday calls | ~250 |
| user checks | ~few |

```json market-defaults
{"enable": ["US", "AU", "TW", "OL", "XETRA", "ST"], "optional": ["TWO", "TO", "HE", "MC", "CO", "SW", "PA", "AS", "LSE", "KQ"], "skip": ["V", "SHG", "SHE", "KO", "HK", "TSE", "NSE", "MI"]}
```

(ST is in `enable` because the user actively trades Stockholm. On evidence alone it is tier 2. HK, TSE, NSE and MI are listed in `skip` because this plan does not serve them.)
