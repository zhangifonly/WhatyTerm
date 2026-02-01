export default {
  testEnvironment: 'node',
  transform: {},
  moduleFileExtensions: ['js', 'mjs'],
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'server.js',
    'services/**/*.js',
    'config/**/*.js'
  ],
  coverageDirectory: 'coverage',
  verbose: true
};
