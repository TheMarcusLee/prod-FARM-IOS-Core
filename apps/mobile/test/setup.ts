/**
 * Native modules the screens touch. The point of these tests is the rendering
 * from a known client, so the keychain, the biometric prompt and the router are
 * stubs — the parts with their own tests live in `packages/farm-client`.
 */

// React 19's test renderer needs to be told it is in an act environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@react-native-async-storage/async-storage', () =>
    require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
    getItemAsync: jest.fn(async () => null),
    setItemAsync: jest.fn(async () => undefined),
    deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-local-authentication', () => ({
    hasHardwareAsync: jest.fn(async () => true),
    isEnrolledAsync: jest.fn(async () => true),
    authenticateAsync: jest.fn(async () => ({ success: true })),
}));

jest.mock('expo-notifications', () => ({
    setNotificationHandler: jest.fn(),
    addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
    getLastNotificationResponseAsync: jest.fn(async () => null),
    getPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
    requestPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
    getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExponentPushToken[test]' })),
    setNotificationChannelAsync: jest.fn(async () => undefined),
    AndroidImportance: { HIGH: 4 },
}));

jest.mock('expo-router', () => ({
    router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
    useLocalSearchParams: jest.fn(() => ({})),
    Stack: Object.assign(() => null, { Screen: () => null }),
    Link: () => null,
}));
