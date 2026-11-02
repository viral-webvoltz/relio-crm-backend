import { writeFileSync } from 'node:fs';
import { mounts } from './docs.mounts.js';
import { buildOpenApi, countOperations } from './docs.openapi.js';
import { readVersion } from './docs.routes.js';

const doc = buildOpenApi(mounts, readVersion());
writeFileSync(new URL('../../../openapi.json', import.meta.url), JSON.stringify(doc, null, 2));
console.log(`openapi.json written: ${countOperations(doc)} operations`);
process.exit(0);
