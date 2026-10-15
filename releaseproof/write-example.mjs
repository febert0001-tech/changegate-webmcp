import fs from 'node:fs';
import path from 'node:path';
import {fixture, modelFixture} from './fixtures.mjs';
import {canonicalJson} from './report.mjs';

const directory = path.resolve(process.argv[2] ?? 'releaseproof-example');
const {expected, packet} = fixture();
packet.model = modelFixture();
fs.mkdirSync(directory, {recursive: true});
fs.writeFileSync(path.join(directory, 'expected.json'), canonicalJson(expected));
fs.writeFileSync(path.join(directory, 'packet.json'), canonicalJson(packet));
console.log('Synthetic example inputs written. No provider was contacted.');
