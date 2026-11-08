#!/usr/bin/env python3
"""Independent check of the population headline in results/portfolio.json.

Shares no code with the TypeScript. It decodes the committed files itself, rebuilds each
member's path from its reads, the oracle prices and the hourly indexes, as README.md describes,
and runs the keeper rule on every point with no thinning. Liquidated positions in the headline
set use their committed paths, with every price update after the liquidation.

Checked, for every period and chain, at T 1.20, G 1.50, R 30%, D 60 s: members, liquidated,
saved by Levee, saved by the same USDC repaid upfront, crossed T, false alarms, and gross bonus
avoided, which must match exactly; reserve held, reserve drawn and reserve drawn by members that
survived anyway, which must match within 0.5%, since the TypeScript thins its paths and this
does not. For each crash window it also runs one shared reserve over every real pair, with
B = R × both debts, and checks the liquidated positions saved and the bonus avoided.

Usage: python3 backtest/scripts/verify_portfolio.py [--period 2025-10|2026-02|calm] [--chain base|arbitrum]
Standard library only. Takes several minutes per period. Exits non-zero on any mismatch.
"""
import gzip
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DERIVED = os.path.join(HERE, '..', 'data', 'derived')
RESULTS = os.path.join(HERE, '..', 'results', 'portfolio.json')

T, G, R, D, COOLDOWN = 1.2, 1.5, 0.3, 60, 60
EPISODE_GAP = 3600
# Rows are skipped in blocks of SKIP_ROWS where a bound shows HF stays at or above T: the keeper
# cannot fire there, and only "below T" and "below 1" are asked of the lowest HF.
SKIP_ROWS = 512
USDC = {'base': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'arbitrum': '0xaf88d065e77c8cc2239327c5edb3a432268e5831'}
EPS = 1e-9


def undelta(values):
    out, total = [], 0
    for v in values:
        total += v
        out.append(total)
    return out


def last_at_or_before(sorted_values, x):
    lo, hi = 0, len(sorted_values) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if sorted_values[mid] <= x:
            lo = mid
        else:
            hi = mid - 1
    return lo


class Prices:
    def __init__(self, window):
        self.blocks = undelta(window['block'])
        self.times = undelta(window['t'])
        n = len(self.blocks)
        self.dense = []
        self.changes = []
        for s in window['series']:
            at, values = undelta(s['at']), undelta(s['price'])
            col = [float('nan')] * n
            for k, start in enumerate(at):
                end = at[k + 1] if k + 1 < len(at) else n
                v = values[k] / 1e8
                for r in range(start, end):
                    col[r] = v
            self.dense.append(col)
            self.changes.append(at)
        self.assets = [s['asset'] for s in window['series']]

    def row_at(self, block):
        return last_at_or_before(self.blocks, block)


class Index:
    """Hourly normalized income and variable debt index, linear in time between reads."""

    def __init__(self, f):
        self.t = undelta(f['index']['t'])
        self.income = [[v / 1e13 for v in undelta(c)] for c in f['index']['income']]
        self.debt = [[v / 1e13 for v in undelta(c)] for c in f['index']['debt']]

    def weights(self, t):
        ts = self.t
        if t <= ts[0]:
            return 0, 0.0
        if t >= ts[-1]:
            return len(ts) - 2, 1.0
        h = last_at_or_before(ts, t)
        h = min(h, len(ts) - 2)
        return h, (t - ts[h]) / (ts[h + 1] - ts[h])


def thresholds(market):
    base = [r['liquidationThreshold'] / 1e4 for r in market['reserves']]
    table = {0: base}
    for cat in market['emodes']:
        bitmap = int(cat['collateralBitmap'])
        table[cat['id']] = [cat['liquidationThreshold'] / 1e4 if (bitmap >> r['id']) & 1 else base[i] for i, r in enumerate(market['reserves'])]
    return table


def decode_states(f):
    """Per member, a list of (applyBlock, applyT, code, emode, holdings dict)."""
    reads, bal = f['reads'], f['balances']
    states = [[] for _ in f['members']]
    member, block, t, off = 0, 0, 0, 0
    for i in range(len(reads['code'])):
        if reads['member'][i] != 0:
            member += reads['member'][i]
            block, t = 0, 0
        block += reads['applyBlock'][i]
        t += reads['applyT'][i]
        code = reads['code'][i]
        lst = states[member]
        holdings = dict(lst[-1][4]) if (code == 1 and lst) else {}
        for _ in range(reads['n'][i]):
            holdings[bal['asset'][off]] = (bal['supply'][off], bal['debt'][off], bal['collateral'][off] == 1)
            off += 1
        holdings = {a: h for a, h in holdings.items() if not (h[0] == 0 and h[1] == 0)}
        lst.append((block, t, code, reads['emode'][i], holdings))
    return states


def keeper(points, liquidation, reserve):
    """points: (t, block, capacity, debt, usdc_debt). Returns (saved, fired)."""
    arm = next(p for p in points if p[3] > 0)
    unspent = reserve
    landed = 0.0
    fired = 0.0
    pending = None
    last_fire = -math.inf
    for t, block, cap, debt, usdc in points:
        if t < arm[0]:
            continue
        if pending and pending[0] < t:
            landed += pending[1]
            pending = None
        owed = max(0.0, debt - landed)
        hf = cap / owed if owed > 0 else math.inf
        if liquidation is not None and block >= liquidation[0] and (hf < 1 or landed == 0):
            return False, fired
        if hf < T and pending is None and t - last_fire >= COOLDOWN and unspent > EPS:
            amount = min(max(0.0, owed - cap / G), unspent, max(0.0, usdc - landed))
            if amount > EPS:
                pending = (t + D, amount)
                unspent -= amount
                fired += amount
                last_fire = t
    return True, fired


def shared_keeper(paths, budget):
    """One reserve for several paths, first come, first served. paths: [(points, liquidation)].
    Each path has its own repay in flight and its own cooldown. Returns saved flags."""
    order = sorted((pt[0], i, k) for i, (pts, _) in enumerate(paths) for k, pt in enumerate(pts))
    books = []
    for pts, _ in paths:
        books.append({'arm': next(p for p in pts if p[3] > 0)[0], 'landed': 0.0, 'pending': None, 'last': -math.inf, 'failed': False})
    unspent = budget
    for _, i, k in order:
        b = books[i]
        if b['failed']:
            continue
        pts, liq = paths[i]
        t, block, cap, debt, usdc = pts[k]
        if t < b['arm']:
            continue
        if b['pending'] and b['pending'][0] < t:
            b['landed'] += b['pending'][1]
            b['pending'] = None
        owed = max(0.0, debt - b['landed'])
        hf = cap / owed if owed > 0 else math.inf
        if liq is not None and block >= liq[0] and (hf < 1 or b['landed'] == 0):
            b['failed'] = True
            continue
        if hf < T and b['pending'] is None and t - b['last'] >= COOLDOWN and unspent > EPS:
            amount = min(max(0.0, owed - cap / G), unspent, max(0.0, usdc - b['landed']))
            if amount > EPS:
                b['pending'] = (t + D, amount)
                unspent -= amount
                b['last'] = t
    return [liq is None or not b['failed'] for (_, liq), b in zip(paths, books)]


def upfront(points, liquidation, amount):
    low = math.inf
    for t, block, cap, debt, usdc in points:
        if block >= liquidation[0]:
            owed = max(0.0, debt - min(amount, usdc))
            low = min(low, cap / owed if owed > 0 else math.inf)
    return low >= 1


def first_episode(events):
    events = sorted(events, key=lambda e: e['t'])
    total, previous = 0.0, events[0]['t']
    for e in events:
        if e['t'] - previous > EPISODE_GAP:
            break
        total += e['bonusUsd']
        previous = e['t']
    return total


def headline_points(position, prices):
    c = position['observed']
    unit = c['debtUnit']
    blocks, times, hf, debt = undelta(c['block']), undelta(c['t']), undelta(c['hf']), undelta(c['debt'])
    share = position['usdcShare']
    points = []
    for i in range(len(blocks)):
        d = debt[i] * unit
        points.append((times[i], blocks[i], hf[i] / 1e4 * d, d, share * d))
    coll = position['portfolio']['collateral']
    owed = position['portfolio']['debt']
    assets = sorted({a for a, _, _ in coll} | {a for a, _ in owed})
    start = prices.row_at(position['liquidationBlock'])

    def mark(row):
        cap = sum(amount * prices.dense[a][row] * th / 1e4 for a, amount, th in coll)
        d = sum(amount * prices.dense[a][row] for a, amount in owed)
        return cap, d

    cap, d = mark(start)
    points.append((position['liquidationTime'], position['liquidationBlock'], cap, d, share * d))
    rows = sorted({r for a in assets for r in prices.changes[a] if r > start})
    for row in rows:
        cap, d = mark(row)
        points.append((prices.times[row], prices.blocks[row], cap, d, share * d))
    return points


def member_points(states, liquidation, prices, index, lt, usdc):
    """Rebuilt path from arming, or None. Returns (points, armDebt, armHf, minHf, liquidation used)."""
    arm_i = next((i for i, s in enumerate(states) if s[4].get(usdc, (0, 0, False))[1] > 0), None)
    if arm_i is None:
        return None
    arm = states[arm_i]
    if liquidation is not None and liquidation[0] <= arm[0]:
        liquidation = None
    used = [s for s in states[arm_i:] if liquidation is None or s[0] < liquidation[0]]
    assets = sorted({a for s in used for a in s[4]})
    rows = sorted({r for a in assets for r in prices.changes[a]})

    def flat(state):
        table = lt.get(state[3], lt[0])
        coll = [(a, h[0] * table[a]) for a, h in state[4].items() if h[0] > 0 and h[2] and table[a] > 0]
        debt = [(a, h[1]) for a, h in state[4].items() if h[1] > 0]
        return coll, debt

    def value(fl, row, t):
        h, w = index.weights(t)
        coll, debt = fl
        cap = 0.0
        for a, weight in coll:
            inc = index.income[a]
            cap += weight * (inc[h] + w * (inc[h + 1] - inc[h])) * prices.dense[a][row]
        owed = 0.0
        usdc_owed = 0.0
        for a, amount in debt:
            idx = index.debt[a]
            v = amount * (idx[h] + w * (idx[h + 1] - idx[h])) * prices.dense[a][row]
            owed += v
            if a == usdc:
                usdc_owed += v
        return cap, owed, usdc_owed

    # A lower bound on HF over a block of rows, from the lowest collateral and highest debt
    # prices in it, the lowest income index and the highest debt index.
    def safe(fl, start_row):
        coll, debt = fl
        end = min(start_row + SKIP_ROWS, len(prices.blocks))
        cap = sum(weight * min(index.income[a]) * min(prices.dense[a][start_row:end]) for a, weight in coll)
        owed = sum(amount * max(index.debt[a]) * max(prices.dense[a][start_row:end]) for a, amount in debt)
        return owed == 0 or cap / owed >= T

    points = []
    current = arm
    fl = flat(current)
    cap, owed, usdc_owed = value(fl, prices.row_at(arm[0]), arm[1])
    points.append((arm[1], arm[0], cap, owed, usdc_owed))
    arm_debt, arm_hf = owed, (cap / owed if owed > 0 else math.inf)
    min_hf = arm_hf
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
            if liquidation is None:
                b = row // SKIP_ROWS
                if b not in safe_block:
                    safe_block[b] = safe(fl, b * SKIP_ROWS)
                if safe_block[b]:
                    r += 1
                    continue
            r += 1
        cap, owed, usdc_owed = value(fl, row, t)
        points.append((t, nxt, cap, owed, usdc_owed))
        min_hf = min(min_hf, cap / owed if owed > 0 else math.inf)
    if liquidation is not None:
        frozen_from = liquidation[0]
        cap, owed, usdc_owed = value(fl, prices.row_at(frozen_from), liquidation[1])
        points.append((liquidation[1], frozen_from, cap, owed, usdc_owed))
        for row in rows[r:]:
            if prices.blocks[row] <= frozen_from:
                continue
            cap, owed, usdc_owed = value(fl, row, prices.times[row])
            points.append((prices.times[row], prices.blocks[row], cap, owed, usdc_owed))
    return points, arm_debt, arm_hf, min_hf, liquidation


def load_gz(path):
    with gzip.open(path, 'rt') as f:
        return json.load(f)


def main():
    sys.stdout.reconfigure(line_buffering=True)
    arg = lambda name: sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None
    only = arg('--period')
    only_chain = arg('--chain')
    with open(arg('--results') or RESULTS) as f:
        published = json.load(f)
    with open(os.path.join(DERIVED, 'markets.json')) as f:
        markets = json.load(f)
    with open(os.path.join(DERIVED, 'portfolio', 'markets-calm.json')) as f:
        markets += json.load(f)
    windows = {(w['chain'], w['window']): w for w in load_gz(os.path.join(DERIVED, 'prices.json.gz'))}
    calm_prices = os.path.join(DERIVED, 'portfolio', 'prices-calm.json.gz')
    if only != '2025-10' and only != '2026-02':
        for w in load_gz(calm_prices):
            windows[(w['chain'], w['window'])] = w
    with gzip.open(os.path.join(DERIVED, 'positions.jsonl.gz'), 'rt') as f:
        headline = {}
        for line in f:
            p = json.loads(line)
            if p['scope'] != 'no_usdc_debt':
                headline[(p['chain'], p['window'], p['user'])] = p

    failures = 0
    for period_info in published['periods']:
        period = period_info['period']
        if only and period != only:
            continue
        # Real pairs: addresses with USDC debt on both chains at the period start.
        starts = {}
        for chain in ('arbitrum', 'base'):
            f = load_gz(os.path.join(DERIVED, 'portfolio', '%s-%s.json.gz' % (chain, period)))
            starts[chain] = set(f['members'][:f['census']['startMembers']])
        on_both = starts['arbitrum'] & starts['base']
        kept = {}
        for chain in ('arbitrum', 'base'):
            if only_chain and chain != only_chain:
                continue
            f = load_gz(os.path.join(DERIVED, 'portfolio', '%s-%s.json.gz' % (chain, period)))
            prices = Prices(windows[(chain, period)])
            assert prices.assets == f['assets']
            market = next(m for m in markets if m['chain'] == chain and m['window'] == period and m['block'] == f['fromBlock'])
            lt = thresholds(market)
            index = Index(f)
            usdc = f['assets'].index(USDC[chain])
            states = decode_states(f)
            liquidations = {m: (b, t, bonus) for m, b, t, bonus, _ in f['liquidations']}
            got = dict(members=0, liquidated=0, savedLevee=0, savedUpfront=0, crossed=0, falseAlarms=0, bonusAvoidedLevee=0.0, reserveHeld=0.0, drawn=0.0, drawnBySurvivors=0.0)
            for m, user in enumerate(f['members']):
                p = headline.get((chain, period, user))
                if p is not None:
                    points = headline_points(p, prices)
                    liq = (p['liquidationBlock'], p['liquidationTime'])
                    arm = next(q for q in points if q[3] > 0)
                    arm_debt, arm_hf = arm[3], arm[2] / arm[3]
                    min_hf = min(q[2] / q[3] for q in points if q[1] < liq[0] and q[0] >= arm[0] and q[3] > 0)
                    bonus = first_episode(p['events'])
                else:
                    liq_info = liquidations.get(m)
                    built = member_points(states[m], liq_info[:2] if liq_info else None, prices, index, lt, usdc)
                    if built is None:
                        continue
                    points, arm_debt, arm_hf, min_hf, liq = built
                    bonus = liq_info[2] if liq is not None else 0.0
                saved, fired = keeper(points, liq, R * arm_debt)
                if user in on_both and m < f['census']['startMembers']:
                    kept[(chain, user)] = (points, liq, arm_debt, bonus)
                got['members'] += 1
                got['reserveHeld'] += R * arm_debt
                got['drawn'] += fired
                if liq is None:
                    got['drawnBySurvivors'] += fired
                if arm_hf >= T and (liq is not None or min_hf < T):
                    got['crossed'] += 1
                    if liq is None and min_hf >= 1:
                        got['falseAlarms'] += 1
                if liq is not None:
                    got['liquidated'] += 1
                    if saved:
                        got['savedLevee'] += 1
                        got['bonusAvoidedLevee'] += bonus
                    if upfront(points, liq, R * arm_debt):
                        got['savedUpfront'] += 1
            row = next(r for r in published['population'] if r['period'] == period and r['chain'] == chain and r['trigger'] == T and r['reserveShare'] == R)
            for k, v in got.items():
                want = row[k]
                if k in ('reserveHeld', 'drawn', 'drawnBySurvivors'):
                    ok = abs(v - want) <= 0.005 * max(1.0, abs(want)) + 1
                elif k == 'bonusAvoidedLevee':
                    ok = abs(round(v) - want) <= 1
                else:
                    ok = v == want
                print('%-8s %-9s %-18s published %14s  here %16.2f  %s' % (period, chain, k, want, v, 'ok' if ok else 'MISMATCH'))
                failures += 0 if ok else 1
        pair_row = next((r for r in published.get('pairs', []) if r['period'] == period and r['set'] == 'real' and r['reserveShare'] == R), None)
        if pair_row is None or only_chain:
            continue
        pairs = liquidated = saved = 0
        bonus_avoided = 0.0
        for user in sorted(on_both):
            a, b = kept.get(('arbitrum', user)), kept.get(('base', user))
            if a is None or b is None:
                continue
            pairs += 1
            if a[1] is None and b[1] is None:
                continue
            flags = shared_keeper([(a[0], a[1]), (b[0], b[1])], R * (a[2] + b[2]))
            for member, ok in zip((a, b), flags):
                if member[1] is not None:
                    liquidated += 1
                    if ok:
                        saved += 1
                        bonus_avoided += member[3]
        for k, v, want in (('pairs', pairs, pair_row['pairs']), ('liquidated in pairs', liquidated, pair_row['liquidatedPositions']),
                           ('saved, shared', saved, pair_row['savedLiquidated']['shared']), ('bonus avoided, shared', round(bonus_avoided), pair_row['bonusAvoided']['shared'])):
            ok = abs(v - want) <= (1 if k.startswith('bonus') else 0)
            print('%-8s %-9s %-22s published %10s  here %12s  %s' % (period, 'pairs', k, want, v, 'ok' if ok else 'MISMATCH'))
            failures += 0 if ok else 1
    if failures:
        print('%d mismatches' % failures)
        sys.exit(1)
    print('all match')


if __name__ == '__main__':
    main()
