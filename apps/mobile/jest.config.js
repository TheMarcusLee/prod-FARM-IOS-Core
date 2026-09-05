// Two projects, one `jest` run: the shared client is plain TypeScript tested in
// a node environment, the screens need jest-expo's React Native environment.
const path = require('node:path');

const clientRoot = path.resolve(__dirname, '../../packages/farm-client');

module.exports = {
    projects: [
        {
            displayName: 'farm-client',
            testEnvironment: 'node',
            rootDir: clientRoot,
            testMatch: ['<rootDir>/test/**/*.test.ts'],
            // The package has no node_modules of its own — it is source-only.
            modulePaths: [path.join(__dirname, 'node_modules')],
            transform: {
                '^.+\\.[jt]sx?$': ['babel-jest', { configFile: path.join(__dirname, 'babel.config.js') }],
            },
        },
        {
            displayName: 'app',
            preset: 'jest-expo',
            rootDir: __dirname,
            testMatch: ['<rootDir>/test/**/*.test.tsx'],
            setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
            // farm-client is source outside this root; its helpers resolve here.
            modulePaths: [path.join(__dirname, 'node_modules')],
            transformIgnorePatterns: [
                'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg))',
            ],
        },
    ],
};
