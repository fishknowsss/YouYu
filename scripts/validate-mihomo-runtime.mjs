import { join, resolve } from 'node:path';
import { mihomoResourceRelativePath, validateMihomoDistribution } from './mihomo-distribution.mjs';

const root = process.cwd();
const distributionDir = process.argv[2] ? resolve(process.argv[2]) : join(root, mihomoResourceRelativePath);
const result = await validateMihomoDistribution(distributionDir);

console.log(`validated Mihomo ${result.manifest.tag} (${result.binarySha256}) at ${distributionDir}`);
