#!/usr/bin/env node
/**
 * CI drift guard: the local CP-2/CP-3 test fixtures are STAND-INS that must stay
 * byte-identical to the artifacts shipped by the installed @alchemist/contracts
 * package. If they diverge, synth/tests could pass against a stale contract —
 * exactly the drift the published seam exists to prevent. Fail loudly here.
 *
 * Run: `npm run check:fixtures` (wired into the test job).
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

// The package's "exports" map hides ./package.json, so resolve the main entry
// (the "." export) and walk up to the package root.
function contractsRoot() {
  let dir = dirname(require.resolve('@alchemist/contracts'));
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('cannot locate @alchemist/contracts root');
    dir = parent;
  }
  return dir;
}

const root = contractsRoot();
const checks = [
  {
    name: 'CP-2 openapi.yaml',
    shipped: join(root, 'openapi', 'openapi.yaml'),
    fixture: join('control-plane', 'rest', '__fixtures__', 'openapi.yaml'),
  },
  {
    name: 'CP-3 schema.graphql',
    shipped: join(root, 'graphql', 'schema.graphql'),
    fixture: join('control-plane', 'appsync', '__fixtures__', 'schema.graphql'),
  },
];

let drift = false;
for (const c of checks) {
  const shipped = readFileSync(c.shipped, 'utf8');
  const fixture = readFileSync(c.fixture, 'utf8');
  if (shipped !== fixture) {
    drift = true;
    console.error(
      `✗ ${c.name}: fixture ${c.fixture} differs from the installed package ` +
        `(${c.shipped}). Re-copy the shipped artifact over the fixture.`,
    );
  } else {
    console.log(`✓ ${c.name}: fixture matches the installed @alchemist/contracts`);
  }
}

if (drift) {
  console.error('\nContract fixture drift detected. Refresh the fixtures from @alchemist/contracts.');
  process.exit(1);
}
console.log('\nAll contract fixtures match the installed @alchemist/contracts@0.1.0.');
