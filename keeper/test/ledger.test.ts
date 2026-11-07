import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import { DEFAULT_EVIDENCE_DIR } from '../src/evidence.js';

describe('evidence/claims.json', () => {
  it('points every test-backed claim at a test that exists', async () => {
    const text = await readFile(join(DEFAULT_EVIDENCE_DIR, 'claims.json'), 'utf8');
    const { claims } = JSON.parse(text) as {
      claims: { id: string; test?: { path: string; name: string } }[];
    };

    expect(claims.length).toBeGreaterThan(0);
    for (const { id, test } of claims) {
      if (!test) continue;
      const source = await readFile(join(REPO_ROOT, test.path), 'utf8');
      expect(source, `claim ${id}`).toContain(test.name);
    }
  });
});
