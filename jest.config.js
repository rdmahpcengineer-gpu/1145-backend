module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test', '<rootDir>/agent', '<rootDir>/workflows', '<rootDir>/data', '<rootDir>/ml', '<rootDir>/control-plane'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
};
