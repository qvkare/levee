#!/usr/bin/env python3
"""Independent check of the repay-from-collateral headline in results/collateral.json.

Shares no code with the TypeScript. It reuses only the decoders of verify_portfolio.py, which is
itself independent of the TypeScript, and works from the committed files: the population and
headline paths, data/derived/collateral/pools.json and the committed quote files. It follows the
method in README.md, "Method: repay from collateral":

- each member's path at every price row of its assets and every read, with no thinning;
- the sold asset: the largest collateral at arming with a usable pool;
- R = (G x D - CL) / (G - L_c x (1 + s)), capped by the USDC debt left and the asset left, at least $1;
- the landing block from the landing time, the ladder quote on a straight line, the cheapest tier,
  the cap against AaveOracle, gas at the block's base fee;
- a repeat revert (after five quoted reverts in a row, in the same UTC hour as the last quoted one)
  taken from the last quoted unwind;
- debt and capacity net of landed unwinds, a repay counted up to the USDC debt on the path.

Checked, for every period and chain at T 1.20, G 1.50, D 60 s and both caps: members, members with
no usable pool, liquidated, saved, bonus avoided, crossed T, false alarms, unwinds sent, landed and
reverted, which must match exactly; repaid, collateral sold, swap cost, gas, and the swap cost of
false alarms and of members not liquidated, which must match within 0.5%.

Before any unwind is sent, a member's rows are skipped in blocks of 512 where a bound shows HF stays
at or above T, as verify_portfolio.py does: nothing can fire there. After an unwind, every row.

Usage: python3 backtest/scripts/verify_collateral.py [--period 2025-10|2026-02|calm] [--chain base|arbitrum]
Standard library only. Exits non-zero on any mismatch.
"""
import bisect
import gzip
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import verify_portfolio as vp  # noqa: E402  (decoders only)

DERIVED = os.path.join(HERE, '..', 'data', 'derived')
RESULTS = os.path.join(HERE, '..', 'results', 'collateral.json')

T, G, D, COOLDOWN = 1.2, 1.5, 60, 60
CAPS = (100, 300)
MIN_UNWIND = 1.0
GAS = 600000
COST_UNIT = 1e7
BASE_GENESIS = 1686789347
SKIP_ROWS = 512
EPS = 1e-9
REPEAT_REVERTS = 5
REPEAT_WINDOW = 3600
# Prints sends per member, to find a difference with the TypeScript.
DUMP = os.environ.get("VERIFY_DUMP") == "1"
USDC = vp.USDC
WETH = {'base': '0x4200000000000000000000000000000000000006', 'arbitrum': '0x82af49447d8a07e3bd95bd0d56f35241523fbab1'}


def ceil_div(a, b):
    return -((-a) // b)


class Quotes:
    def __init__(self, f, prices):
        self.chain = f['chain']
        self.ladder = f['ladder']
        self.pools = f['pools']
        self.pool_index = {(p['asset'], p['fee']): i for i, p in enumerate(f['pools'])}
        self.rows = {}
        block = t = 0
        for db, dt, base_fee, weth, usdc, assets, pools in f['rows']:
            block += db
            t += dt
            self.rows[block] = {
                't': t, 'base_fee': base_fee, 'weth': weth, 'usdc': usdc,
                'prices': {a: p for a, p in assets},
                'pools': {pool: (gap, dict(zip(ks, costs)), {a: c for a, c in exact}) for pool, gap, ks, costs, exact in pools},
            }
        self.anchor_blocks = prices.blocks
        self.anchor_times = prices.times

    def landing_block(self, t):
        if self.chain == 'base':
            return ceil_div(t - BASE_GENESIS, 2)
        times, blocks = self.anchor_times, self.anchor_blocks
        last = len(times) - 1
        if t > times[last]:
            return blocks[last] + ceil_div((t - times[last]) * (blocks[last] - blocks[0]), times[last] - times[0])
        i = bisect.bisect_left(times, t)
        if times[i] == t or i == 0:
            return blocks[i]
        return blocks[i - 1] + ceil_div((t - times[i - 1]) * (blocks[i] - blocks[i - 1]), times[i] - times[i - 1])

    def amount_in(self, pool, base, per_usdc):
        """Collateral units for `base` USDC base units, or None if the pool cannot fill it."""
        _, ladder, exact = pool

        def at(amount, cost):
            return (amount / 1e6) * per_usdc * (1 + cost / COST_UNIT)

        # A pool that could not fill a smaller amount cannot fill this one.
        if any(c is None and self.ladder[kk] <= base for kk, c in ladder.items()):
            return None
        if any(c is None and a <= base for a, c in exact.items()):
            return None
        k = bisect.bisect_right(self.ladder, base) - 1
        if self.ladder[k] == base:
            cost = ladder[k]
            return None if cost is None else at(base, cost)
        if k == len(self.ladder) - 1:
            cost = exact[base]
            return None if cost is None else at(base, cost)
        low, high = ladder[k], ladder[k + 1]
        if low is None:
            return None
        if high is None:
            cost = exact[base]
            return None if cost is None else at(base, cost)
        a = at(self.ladder[k], low)
        b = at(self.ladder[k + 1], high)
        return a + ((base - self.ladder[k]) / (self.ladder[k + 1] - self.ladder[k])) * (b - a)

    def execute(self, lands_at, amount, asset, fees, cap):
        """(status, units, paid, received, gas)."""
        row = self.rows[self.landing_block(lands_at)]
        price = row['prices'][asset]
        per_usdc = row['usdc'] / price
        gas = GAS * row['base_fee'] * 1e-18 * row['weth'] / 1e8
        base = math.ceil(amount * 1e6)
        best = None
        for fee in fees:
            units = self.amount_in(row['pools'][self.pool_index[(asset, fee)]], base, per_usdc)
            if units is not None and (best is None or units < best):
                best = units
        if best is None:
            return 'liquidity', 0.0, 0.0, 0.0, gas
        if best > amount * per_usdc * (1 + cap / 1e4):
            return 'cap', 0.0, 0.0, 0.0, gas
        return 'landed', best, best * price / 1e8, amount * row['usdc'] / 1e8, gas


class Keeper:
    """The rule of README.md for one cap. Points are (t, block, cap, debt, usdc, price, units, lt)."""

    def __init__(self, quotes, asset, fees, sizing_fee, cap, liquidation):
        self.q, self.asset, self.fees, self.cap = quotes, asset, fees, cap
        self.s = sizing_fee + cap / 1e4
        self.liq = liquidation
        self.landed = self.sold = 0.0
        self.pending = None
        self.last = -math.inf
        self.first = None
        self.failed = None
        self.blocked = False
        self.attempts = []  # (lands_at, amount, cut, status, units, paid, received, gas)
        self.sent = 0
        self.streak = 0
        self.last_quoted = None

    def step(self, p):
        t, block, cap_, debt_, usdc, price, units, lt = p
        if self.pending is not None and self.pending[0] < t:
            lands_at, amount, cut = self.pending
            last = self.last_quoted
            if last is not None and last[0] != 'landed' and self.streak >= REPEAT_REVERTS and lands_at // REPEAT_WINDOW == last[2] // REPEAT_WINDOW:
                # A repeat revert: taken from the last quoted unwind of this run, not quoted itself.
                status, sold, paid, received, gas = last[0], 0.0, 0.0, 0.0, last[1]
            else:
                status, sold, paid, received, gas = self.q.execute(lands_at, amount, self.asset, self.fees, self.cap)
                self.last_quoted = (status, gas, lands_at)
                self.streak = 0 if status == 'landed' else self.streak + 1
            self.attempts.append((lands_at, amount, cut, status, sold, paid, received, gas))
            if status == 'landed':
                self.landed += amount
                self.sold += sold
            self.pending = None
        owed = max(0.0, debt_ - min(self.landed, usdc))
        capacity = max(0.0, cap_ - min(self.sold, units) * price * lt)
        hf = capacity / owed if owed > 0 else math.inf
        after = self.liq is not None and block >= self.liq[0]
        if after and (hf < 1 or self.landed == 0):
            self.failed = p
            return False
        if hf < T:
            if self.first is None and not after:
                self.first = t
            if self.pending is None and t - self.last >= COOLDOWN:
                need = max(0.0, (G * owed - capacity) / (G - lt * (1 + self.s)))
                repayable = max(0.0, usdc - self.landed)
                left = max(0.0, units - self.sold) * price / (1 + self.s)
                wanted = min(need, repayable)
                amount = min(wanted, left)
                if amount >= MIN_UNWIND:
                    self.pending = (t + D, amount, left < wanted)
                    self.sent += 1
                    self.last = t
                elif left < wanted:
                    self.blocked = True
        return True

    def outcome(self):
        """(saved, reason)."""
        if self.liq is None:
            return True, None
        if self.failed is None:
            return True, 'saved'
        fail_t = self.failed[0]
        resolved = [a for a in self.attempts if a[0] < fail_t]
        if self.first is None:
            return False, 'no_warning'
        if any(a[3] != 'landed' for a in resolved):
            return False, 'slippage_cap'
        if not any(a[3] == 'landed' and a[0] < self.liq[1] for a in resolved):
            return False, 'too_slow'
        if self.blocked or any(a[2] for a in resolved) or self.sold >= self.failed[6] - EPS:
            return False, 'collateral_exhausted'
        if self.landed >= self.failed[4] - EPS:
            return False, 'usdc_debt_exhausted'
        return False, 'follow_up_too_slow'


def state_at(states, block):
    found = None
    for s in states:
        if s[0] > block:
            break
        found = s
    return found if found is not None else states[0]


def units_of(state, asset, index, t, lt):
    h = state[4].get(asset)
    table = lt.get(state[3], lt[0])
    if h is None or h[0] <= 0 or not h[2] or table[asset] <= 0:
        return 0.0
    hh, w = index.weights(t)
    inc = index.income[asset]
    return h[0] * (inc[hh] + w * (inc[hh + 1] - inc[hh]))


def holdings(state, index, prices, lt, usdc, block, t):
    row = prices.row_at(block)
    table = lt.get(state[3], lt[0])
    out = []
    for a, h in state[4].items():
        if h[0] > 0 and h[2] and table[a] > 0:
            u = units_of(state, a, index, t, lt)
            out.append((a, u, u * prices.dense[a][row]))
    return out


def choose(hold, usable):
    for a, _, _ in sorted(hold, key=lambda x: (-x[2], x[0])):
        if a in usable:
            return a
    return None


def member_stream(states, liquidation, prices, index, lt, usdc, asset, may_skip):
    """Every point from arming, as README.md describes, with the sold asset's price, units and threshold.
    Rows in blocks of SKIP_ROWS are skipped only while may_skip() and a bound keeps HF at or above T."""
    arm_i = next(i for i, s in enumerate(states) if s[4].get(usdc, (0, 0, False))[1] > 0)
    arm = states[arm_i]
    used = [s for s in states[arm_i:] if liquidation is None or s[0] < liquidation[0]]
    # The assets that move HF: collateral that counts under the read's eMode, and debt.
    assets = sorted({a for s in used for a, h in s[4].items() if (h[0] > 0 and h[2] and lt.get(s[3], lt[0])[a] > 0) or h[1] > 0})
    rows = sorted({r for a in assets for r in prices.changes[a]})

    def flat(state):
        table = lt.get(state[3], lt[0])
        coll = [(a, h[0] * table[a]) for a, h in state[4].items() if h[0] > 0 and h[2] and table[a] > 0]
        debt = [(a, h[1]) for a, h in state[4].items() if h[1] > 0]
        return coll, debt

    def point(state, fl, row, t, block):
        hh, w = index.weights(t)
        coll, debt = fl
        cap = 0.0
        for a, weight in coll:
            inc = index.income[a]
            cap += weight * (inc[hh] + w * (inc[hh + 1] - inc[hh])) * prices.dense[a][row]
        owed = usdc_owed = 0.0
        for a, amount in debt:
            idx = index.debt[a]
            v = amount * (idx[hh] + w * (idx[hh + 1] - idx[hh])) * prices.dense[a][row]
            owed += v
            if a == usdc:
                usdc_owed += v
        table = lt.get(state[3], lt[0])
        return (t, block, cap, owed, usdc_owed, prices.dense[asset][row], units_of(state, asset, index, t, lt), table[asset])

    def safe(fl, start_row):
        coll, debt = fl
        end = min(start_row + SKIP_ROWS, len(prices.blocks))
        cap = sum(weight * min(index.income[a]) * min(prices.dense[a][start_row:end]) for a, weight in coll)
        owed = sum(amount * max(index.debt[a]) * max(prices.dense[a][start_row:end]) for a, amount in debt)
        return owed == 0 or cap / owed >= T

    current = arm
    fl = flat(current)
    yield point(current, fl, prices.row_at(arm[0]), arm[1], arm[0])
    s, r = 1, 0
    while r < len(rows) and prices.blocks[rows[r]] <= arm[0]:
        r += 1
    stop = liquidation[0] if liquidation is not None else math.inf
    safe_block = {}
    while True:
        row_block = prices.blocks[rows[r]] if r < len(rows) else math.inf
        read_block = used[s][0] if s < len(used) else math.inf
        nxt = min(row_block, read_block)
        if nxt >= stop or nxt == math.inf:
            break
        if read_block == nxt:
            while s < len(used) and used[s][0] == nxt:
                current = used[s]
                s += 1
            fl = flat(current)
            safe_block = {}
            if row_block == nxt:
                row, t = rows[r], prices.times[rows[r]]
                r += 1
            else:
                row, t = prices.row_at(nxt), current[1]
        else:
            row, t = rows[r], prices.times[rows[r]]
            if liquidation is None and may_skip():
                b = row // SKIP_ROWS
                if b not in safe_block:
                    safe_block[b] = safe(fl, b * SKIP_ROWS)
                if safe_block[b]:
                    r += 1
                    continue
            r += 1
        yield point(current, fl, row, t, nxt)
    if liquidation is not None:
        yield point(current, fl, prices.row_at(liquidation[0]), liquidation[1], liquidation[0])
        for row in rows[r:]:
            if prices.blocks[row] <= liquidation[0]:
                continue
            yield point(current, fl, row, prices.times[row], prices.blocks[row])


def headline_stream(position, member_states, prices, index, lt, asset):
    c = position['observed']
    unit = c['debtUnit']
    blocks, times, hfs, debts = vp.undelta(c['block']), vp.undelta(c['t']), vp.undelta(c['hf']), vp.undelta(c['debt'])
    share = position['usdcShare']
    for i in range(len(blocks)):
        d = debts[i] * unit
        state = state_at(member_states, blocks[i])
        table = lt.get(state[3], lt[0])
        yield (times[i], blocks[i], hfs[i] / 1e4 * d, d, share * d, prices.dense[asset][prices.row_at(blocks[i])], units_of(state, asset, index, times[i], lt), table[asset])
    coll = position['portfolio']['collateral']
    owed = position['portfolio']['debt']
    frozen = next((x for x in coll if x[0] == asset), None)
    units, threshold = (frozen[1], frozen[2] / 1e4) if frozen else (0.0, 0.0)
    assets = sorted({a for a, _, _ in coll} | {a for a, _ in owed})
    start = prices.row_at(position['liquidationBlock'])

    def mark(row, t, block):
        cap = sum(amount * prices.dense[a][row] * th / 1e4 for a, amount, th in coll)
        d = sum(amount * prices.dense[a][row] for a, amount in owed)
        return (t, block, cap, d, share * d, prices.dense[asset][row], units, threshold)

    yield mark(start, position['liquidationTime'], position['liquidationBlock'])
    for row in sorted({r for a in assets for r in prices.changes[a] if r > start}):
        yield mark(row, prices.times[row], prices.blocks[row])


FIELDS = ('members', 'noPool', 'liquidated', 'saved', 'bonusAvoided', 'crossed', 'falseAlarms', 'sent', 'landed', 'revertedCap', 'revertedLiquidity',
          'repaid', 'sold', 'swapCost', 'gas', 'swapCostFalseAlarms', 'swapCostSurvivors')
DOLLARS = ('repaid', 'sold', 'swapCost', 'gas', 'swapCostFalseAlarms', 'swapCostSurvivors')


def main():
    sys.stdout.reconfigure(line_buffering=True)
    arg = lambda name: sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None
    only, only_chain = arg('--period'), arg('--chain')
    with open(arg('--results') or RESULTS) as f:
        published = json.load(f)
    with open(os.path.join(DERIVED, 'collateral', 'pools.json')) as f:
        pools_file = json.load(f)
    with open(os.path.join(DERIVED, 'markets.json')) as f:
        markets = json.load(f)
    with open(os.path.join(DERIVED, 'portfolio', 'markets-calm.json')) as f:
        markets += json.load(f)
    windows = {(w['chain'], w['window']): w for w in vp.load_gz(os.path.join(DERIVED, 'prices.json.gz'))}
    if only not in ('2025-10', '2026-02'):
        for w in vp.load_gz(os.path.join(DERIVED, 'portfolio', 'prices-calm.json.gz')):
            windows[(w['chain'], w['window'])] = w
    with gzip.open(os.path.join(DERIVED, 'positions.jsonl.gz'), 'rt') as f:
        headline = {}
        for line in f:
            p = json.loads(line)
            if p['scope'] != 'no_usdc_debt':
                headline[(p['chain'], p['window'], p['user'])] = p

    failures = 0
    for period in [p['period'] for p in published['periods']]:
        if only and period != only:
            continue
        for chain in ('arbitrum', 'base'):
            if only_chain and chain != only_chain:
                continue
            f = vp.load_gz(os.path.join(DERIVED, 'portfolio', '%s-%s.json.gz' % (chain, period)))
            prices = vp.Prices(windows[(chain, period)])
            market = next(m for m in markets if m['chain'] == chain and m['window'] == period and m['block'] == f['fromBlock'])
            lt = vp.thresholds(market)
            index = vp.Index(f)
            usdc = f['assets'].index(USDC[chain])
            states = vp.decode_states(f)
            liquidations = {m: (b, t, bonus) for m, b, t, bonus, _ in f['liquidations']}
            pools = next(p for p in pools_file if p['chain'] == chain and p['period'] == period)
            usable = {a['asset']: a for a in pools['assets'] if any(t['usable'] for t in a['tiers'])}
            quotes = Quotes(vp.load_gz(os.path.join(DERIVED, 'collateral', 'quotes-%s-%s.json.gz' % (chain, period))), prices)
            got = {cap: {k: 0 for k in FIELDS} for cap in CAPS}
            for m, user in enumerate(f['members']):
                p = headline.get((chain, period, user))
                if p is not None:
                    obs = list(vp.headline_points(p, prices))
                    liq = (p['liquidationBlock'], p['liquidationTime'])
                    arm_point = next(q for q in obs if q[3] > 0)
                    arm_debt, arm_hf = arm_point[3], arm_point[2] / arm_point[3]
                    min_hf = min(q[2] / q[3] for q in obs if q[1] < liq[0] and q[0] >= arm_point[0] and q[3] > 0)
                    bonus = vp.first_episode(p['events'])
                    hold = holdings(state_at(states[m], arm_point[1]), index, prices, lt, usdc, arm_point[1], arm_point[0])
                else:
                    liq_info = liquidations.get(m)
                    built = vp.member_points(states[m], liq_info[:2] if liq_info else None, prices, index, lt, usdc)
                    if built is None:
                        continue
                    _, arm_debt, arm_hf, min_hf, liq = built
                    bonus = liq_info[2] if liq is not None else 0.0
                    arm = next(s for s in states[m] if s[4].get(usdc, (0, 0, False))[1] > 0)
                    hold = holdings(arm, index, prices, lt, usdc, arm[0], arm[1])
                asset = choose(hold, usable)
                collateral = sum(x[2] for x in hold)
                keepers = {}
                if asset is not None and (liq is not None or arm_hf < T or min_hf < T):
                    info = usable[asset]
                    fees = [t['fee'] for t in info['tiers'] if t['usable']]
                    keepers = {cap: Keeper(quotes, asset, fees, info['configuredFee'] / 1e6, cap, liq) for cap in CAPS}
                    live = dict(keepers)
                    if p is not None:
                        stream = headline_stream(p, states[m], prices, index, lt, asset)
                    else:
                        stream = member_stream(states[m], liq, prices, index, lt, usdc, asset, lambda: all(k.sent == 0 for k in keepers.values()))
                    started = False
                    for point in stream:
                        if not started:
                            if point[3] <= 0:
                                continue
                            started = True
                        for cap in list(live):
                            if not live[cap].step(point):
                                del live[cap]
                        if not live:
                            break
                if DUMP and keepers:
                    print('dump', m, ' '.join('%d/%d' % (keepers[c].sent, sum(1 for a in keepers[c].attempts if a[3] == 'cap')) for c in CAPS))
                for cap in CAPS:
                    g = got[cap]
                    k = keepers.get(cap)
                    saved, reason = (k.outcome() if k else ((False, 'no_pool') if liq is not None else (True, None)))
                    resolved = [a for a in k.attempts] if k else []
                    landed = [a for a in resolved if a[3] == 'landed']
                    swap = sum(a[5] - a[6] for a in landed)
                    g['members'] += 1
                    g['noPool'] += asset is None
                    g['sent'] += k.sent if k else 0
                    g['landed'] += len(landed)
                    g['revertedCap'] += sum(1 for a in resolved if a[3] == 'cap')
                    g['revertedLiquidity'] += sum(1 for a in resolved if a[3] == 'liquidity')
                    g['repaid'] += sum(a[1] for a in landed)
                    g['sold'] += sum(a[5] for a in landed)
                    g['swapCost'] += swap
                    g['gas'] += sum(a[7] for a in resolved)
                    false_alarm = arm_hf >= T and liq is None and min_hf < T and min_hf >= 1
                    if arm_hf >= T and (liq is not None or min_hf < T):
                        g['crossed'] += 1
                        g['falseAlarms'] += false_alarm
                    if false_alarm:
                        g['swapCostFalseAlarms'] += swap
                    if liq is None:
                        g['swapCostSurvivors'] += swap
                    else:
                        g['liquidated'] += 1
                        if saved:
                            g['saved'] += 1
                            g['bonusAvoided'] += bonus
            for cap in CAPS:
                row = next(r for r in published['population'] if r['period'] == period and r['chain'] == chain and r['trigger'] == T and r['slippageBps'] == cap and r['tier'] == 'cheapest')
                for k in FIELDS:
                    v, want = got[cap][k], row[k]
                    if k in DOLLARS:
                        ok = abs(v - want) <= 0.005 * max(1.0, abs(want)) + 1
                    elif k == 'bonusAvoided':
                        ok = abs(v - want) <= 1
                    else:
                        ok = v == want
                    print('%-8s %-9s %4d bps %-20s published %14.2f  here %14.2f  %s' % (period, chain, cap, k, want, v, 'ok' if ok else 'MISMATCH'))
                    failures += 0 if ok else 1
    if failures:
        print('%d mismatches' % failures)
        sys.exit(1)
    print('all match')


if __name__ == '__main__':
    main()
