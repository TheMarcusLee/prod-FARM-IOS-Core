import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Stack, router } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AlertsProvider } from '../src/context/AlertsContext';
import { FarmProvider } from '../src/context/FarmContext';
import { SafetyProvider } from '../src/context/SafetyContext';
import { SettingsProvider } from '../src/context/SettingsContext';
import { ThemeProvider, useTheme } from '../src/theme';
import { configureNotificationHandler, hrefForTarget, targetForNotificationData } from '../src/lib/push';

configureNotificationHandler();

/** A tapped notification opens the device or the execution it names. */
function useNotificationDeepLinks(): void {
    useEffect(() => {
        const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
            const target = targetForNotificationData(response.notification.request.content.data);
            router.push(hrefForTarget(target) as never);
        });

        // Cold start: the tap that launched the app.
        void Notifications.getLastNotificationResponseAsync().then((response) => {
            if (!response) return;
            const target = targetForNotificationData(response.notification.request.content.data);
            router.push(hrefForTarget(target) as never);
        });

        return () => subscription.remove();
    }, []);
}

function RootStack() {
    const { colors, scheme } = useTheme();
    useNotificationDeepLinks();
    return (
        <>
            <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
            <Stack
                screenOptions={{
                    headerStyle: { backgroundColor: colors.bg },
                    headerTintColor: colors.text,
                    headerTitleStyle: { color: colors.text, fontSize: 17, fontWeight: '700' },
                    headerShadowVisible: false,
                    contentStyle: { backgroundColor: colors.bg },
                }}
            >
                {/* `title` is what the detail screens' back button reads. */}
                <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Wall' }} />
                {/* The device screen draws its own header: back · number and
                    name · state line · Stop, per PhoneDevice.dc.html. */}
                <Stack.Screen name="device/[udid]" options={{ headerShown: false }} />
                <Stack.Screen name="execution/[id]" options={{ title: 'Execution' }} />
            </Stack>
        </>
    );
}

export default function RootLayout() {
    return (
        <SafeAreaProvider>
            {/* Settings is outermost: the theme is one of the things the
                operator sets, so `ThemeProvider` reads from it. */}
            <SettingsProvider>
                <ThemeProvider>
                    <FarmProvider>
                        <SafetyProvider>
                            <AlertsProvider>
                                <RootStack />
                            </AlertsProvider>
                        </SafetyProvider>
                    </FarmProvider>
                </ThemeProvider>
            </SettingsProvider>
        </SafeAreaProvider>
    );
}
