#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { Cli } from '../src/cli.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const cli = new Cli({ cwd: process.cwd(), binDir: __dirname });
  await cli.run(process.argv.slice(2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
