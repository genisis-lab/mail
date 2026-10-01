// Initialise config + the Node platform for every test file.
import path from 'node:path';
import { initConfig } from '../src/server/config';
import { setPlatform } from '../src/server/platform';
import { nodePlatform } from '../src/server/node-platform';

initConfig(process.env, { platform: 'node', resolvePath: (p) => path.resolve(p) });
setPlatform(nodePlatform(null));
