export default {
  test: {
    include: ['.github/screens/*.live.ts'],
    setupFiles: ['tests/setup.ts'],
    globals: true, environment: 'node', pool: 'forks', testTimeout: 0,
    execArgv: ['--no-warnings=ExperimentalWarning'],
    env: { WREN_SILENT: '1' },
  },
};
