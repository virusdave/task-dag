#!/usr/bin/env tsx
/**
 * Generate experiment dashboard from L2 outputs
 * 
 * Usage:
 *   ./scripts/generate-experiment-dashboard.ts --l2-runs outputs/prod/json/run-*.json --output dashboard.html
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { generateExperimentDashboard } from '../lib/html/experiment-dashboard.js';
import type { L2PredictionOutput } from '../lib/shared/types.js';

async function main() {
  const args = process.argv.slice(2);
  
  // Find all L2 run JSON files
  const l2Files = args.filter(arg => arg.endsWith('.json'));
  
  if (l2Files.length === 0) {
    // Default: use all recent L2 outputs
    const prodDir = 'outputs/prod/json';
    try {
      const files = await fs.readdir(prodDir);
      l2Files.push(...files
        .filter(f => f.includes('l2-output.json'))
        .map(f => path.join(prodDir, f))
      );
    } catch {
      // Try test outputs
      l2Files.push('outputs/final-test/json/run-2026-05-15-59ea1fca-l2-output.json');
    }
  }
  
  console.log(`📊 Loading ${l2Files.length} L2 run(s)...`);
  
  const l2Runs: L2PredictionOutput[] = [];
  for (const file of l2Files) {
    try {
      const content = await fs.readFile(file, 'utf-8');
      l2Runs.push(JSON.parse(content));
      console.log(`  ✓ ${file}`);
    } catch (error) {
      console.warn(`  ✗ Skipped ${file}: ${error}`);
    }
  }
  
  console.log(`\n🎨 Generating experiment dashboard...`);
  const html = generateExperimentDashboard({ l2Runs });
  
  const outputPath = 'outputs/experiment-dashboard.html';
  await fs.writeFile(outputPath, html);
  
  console.log(`✅ Dashboard generated: ${outputPath}`);
  console.log(`\nView it with:`);
  console.log(`  open ${outputPath}`);
  console.log(`  # Or:`);
  console.log(`  python3 -m http.server 8000 --directory outputs/`);
}

main().catch(console.error);
