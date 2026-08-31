import fs from 'fs';
import path from 'path';
import { generateAuroraApiDocument } from '../server/api/v1/openapi';

const outputPath = path.resolve(process.cwd(), 'docs/openapi/aurora-v1.json');
const generated = `${JSON.stringify(generateAuroraApiDocument(), null, 2)}\n`;
const check = process.argv.includes('--check');

if (check) {
  const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (existing !== generated) {
    console.error('docs/openapi/aurora-v1.json is out of date. Run npm run api:generate.');
    process.exit(1);
  }
  console.log('Aurora API document is current.');
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, generated);
  console.log(`Generated ${path.relative(process.cwd(), outputPath)}`);
}
