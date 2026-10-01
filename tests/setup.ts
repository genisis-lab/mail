// Initialise config and an in-process stand-in for the Worker platform for every test file.
import { initConfig } from '../src/server/config';
import { setPlatform } from '../src/server/platform';
import { testPlatform } from './test-platform';

initConfig({}, { secret: 'test-secret-0123456789abcdef' });
setPlatform(testPlatform());
