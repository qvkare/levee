#!/usr/bin/env python3
"""Independent check of the headline cell, from the committed derived files only.

Shares no code with the TypeScript. It decodes the files itself, simulates from the rule in
the README, and uses every price update after a liquidation with no thinning, so it also
tests that thinning does not change the result.

Usage: python3 backtest/scripts/verify_headline.py [backtest/results/summary.json]
Takes a few minutes. Standard library only. Exits non-zero on any mismatch.
"""
import gzip
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DERIVED = os.path.join(HERE, '..', 'data', 'derived')
SUMMARY = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', 'results', 'summary.json')

T, G, R, D = 1.2, 1.5, 0.3, 60
COOLDOWN = 60
EPISODE_GAP = 3600


def undelta(values):
    out, total = [], 0
    for value in values:
        total += value
        out.append(total)
    return out


def load_books():
    books = {}
    with gzip.open(os.path.join(DERIVED, 'prices.json.gz'), 'rt') as f:
        for window in json.load(f):
            books[(window['chain'], window['window'])] = {
                'blocks': undelta(window['block']),
                'times': undelta(window['t']),
                'series': [(undelta(s['at']), undelta(s['price'])) for s in window['series']],
            }
    return books


def last_row_at(blocks, block):
    low, high = 0, len(blocks) - 1
    while low < high:
        mid = (low + high + 1) // 2
        if blocks[mid] <= block:
            low = mid
        else:
            high = mid - 1
    return low


def frozen_points(position, book):
    blocks, times = book['blocks'], book['times']
    start = last_row_at(blocks, position['liquidationBlock'])
    collateral = position['portfolio']['collateral']
    debt = position['portfolio']['debt']
    assets = sorted({a for a, _, _ in collateral} | {a for a, _ in debt})
    price, later = {}, {}
    rows = set()
    for asset in assets:
        at, values = book['series'][asset]
        i = 0
        while i < len(at) and at[i] <= start:
            price[asset] = values[i]
            i += 1
        later[asset] = {at[j]: values[j] for j in range(i, len(at))}
        rows.update(later[asset])

    def value():
        capacity = sum(amount * price[a] / 1e8 * threshold / 1e4 for a, amount, threshold in collateral)
        owed = sum(amount * price[a] / 1e8 for a, amount in debt)
        return capacity, owed

    points = [(position['liquidationBlock'], position['liquidationTime'], *value())]
    for row in sorted(rows):
        for asset in assets:
            if row in later[asset]:
                price[asset] = later[asset][row]
        points.append((blocks[row], times[row], *value()))
    return points


def observed_points(position):
    columns = position['observed']
    unit = columns['debtUnit']
    blocks, times = undelta(columns['block']), undelta(columns['t'])
    hf, debt = undelta(columns['hf']), undelta(columns['debt'])
    return [(blocks[i], times[i], hf[i] / 1e4 * debt[i] * unit, debt[i] * unit) for i in range(len(blocks))]


def saved(points, liquidation_block, usdc_share):
    arming = next(p for p in points if p[3] > 0)
    unspent = R * arming[3]
    landed = 0.0
    pending = None
    last_fire = float('-inf')
    for block, t, capacity, debt in points:
        if t < arming[1]:
            continue
        if pending and pending[0] < t:
            landed += pending[1]
            pending = None
        owed = max(0.0, debt - landed)
        hf = capacity / owed if owed > 0 else float('inf')
        if block >= liquidation_block and (hf < 1 or landed == 0):
            return False
        if hf < T and pending is None and t - last_fire >= COOLDOWN and unspent > 1e-9:
            amount = min(max(0.0, owed - capacity / G), unspent, max(0.0, usdc_share * debt - landed))
            if amount > 1e-9:
                pending = (t + D, amount)
                unspent -= amount
                last_fire = t
    return True


def first_episode_bonus(position):
    events = sorted(position['events'], key=lambda e: e['t'])
    total, previous = 0.0, events[0]['t']
    for event in events:
        if event['t'] - previous > EPISODE_GAP:
            break
        total += event['bonusUsd']
        previous = event['t']
    return total


def main():
    books = load_books()
    with gzip.open(os.path.join(DERIVED, 'positions.jsonl.gz'), 'rt') as f:
        positions = [json.loads(line) for line in f]
    in_scope = [p for p in positions if p['scope'] != 'no_usdc_debt']
    count, bonus = 0, 0.0
    for position in in_scope:
        book = books[(position['chain'], position['window'])]
        points = observed_points(position) + frozen_points(position, book)
        if saved(points, position['liquidationBlock'], position['usdcShare']):
            count += 1
            bonus += first_episode_bonus(position)

    with open(SUMMARY) as f:
        cell = json.load(f)['headline']['cell']
    print(f'independent: {count} saved of {len(in_scope)}, bonus avoided ${bonus:,.0f}')
    print(f'pnpm backtest: {cell["saved"]} saved of {cell["positions"]}, bonus avoided ${cell["bonusAvoidedUsd"]:,.0f}')
    match = count == cell['saved'] and len(in_scope) == cell['positions'] and abs(bonus - cell['bonusAvoidedUsd']) < 1
    print('match' if match else 'MISMATCH')
    sys.exit(0 if match else 1)


if __name__ == '__main__':
    main()
