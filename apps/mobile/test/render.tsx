import type { ReactElement, ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AlertsProvider } from '../src/context/AlertsContext';
import { FarmProvider } from '../src/context/FarmContext';
import { SafetyProvider } from '../src/context/SafetyContext';
import { SettingsProvider } from '../src/context/SettingsContext';
import { ThemeProvider } from '../src/theme';

/**
 * The whole provider stack with demo mode on — which is the default for a fresh
 * install, so this is also the first-launch path.
 */
export function Providers({ children }: { children: ReactNode }) {
    return (
        <SafeAreaProvider
            initialMetrics={{
                frame: { x: 0, y: 0, width: 390, height: 844 },
                insets: { top: 47, left: 0, right: 0, bottom: 34 },
            }}
        >
            <SettingsProvider>
                <ThemeProvider>
                    <FarmProvider>
                        <SafetyProvider>
                            <AlertsProvider>{children}</AlertsProvider>
                        </SafetyProvider>
                    </FarmProvider>
                </ThemeProvider>
            </SettingsProvider>
        </SafeAreaProvider>
    );
}

/** RNTL 14's `render` is async — always await it. */
export function renderWithProviders(ui: ReactElement): Promise<RenderResult> {
    return render(ui, { wrapper: Providers });
}
