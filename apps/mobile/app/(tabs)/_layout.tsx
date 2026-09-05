import { Text, type ColorValue } from 'react-native';
import { Tabs } from 'expo-router/js-tabs';
import { useFarm } from '../../src/context/FarmContext';
import { useTheme } from '../../src/theme';

/**
 * No icon font: a glyph per tab keeps the bundle small and reads fine at this
 * size. The Alerts badge comes from `/api/mobile/bootstrap`'s
 * `unacknowledgedCount` and is per-token, so two teammates see their own.
 */
function Glyph({ character, color }: { character: string; color: ColorValue }) {
    return <Text style={{ fontSize: 20, color, lineHeight: 24 }}>{character}</Text>;
}

export default function TabsLayout() {
    const { colors } = useTheme();
    const { unacknowledgedCount, snapshot } = useFarm();
    const capabilities = snapshot?.capabilities ?? {};

    return (
        <Tabs
            screenOptions={{
                headerStyle: { backgroundColor: colors.background },
                headerTintColor: colors.text,
                tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
                tabBarActiveTintColor: colors.accent,
                tabBarInactiveTintColor: colors.textFaint,
                sceneStyle: { backgroundColor: colors.background },
            }}
        >
            <Tabs.Screen
                name="index"
                options={{ title: 'Fleet', tabBarIcon: ({ color }) => <Glyph character="▦" color={color} /> }}
            />
            <Tabs.Screen
                name="queue"
                options={{ title: 'Queue', tabBarIcon: ({ color }) => <Glyph character="≣" color={color} /> }}
            />
            <Tabs.Screen
                name="content"
                options={{
                    title: 'Content',
                    // An older farm without the drip queue hides the tab rather
                    // than 404-ing on it (`capabilities`, gap 4).
                    href: capabilities.contentQueue === false ? null : undefined,
                    tabBarIcon: ({ color }) => <Glyph character="▶" color={color} />,
                }}
            />
            <Tabs.Screen
                name="alerts"
                options={{
                    title: 'Alerts',
                    tabBarBadge: unacknowledgedCount > 0 ? unacknowledgedCount : undefined,
                    tabBarBadgeStyle: { backgroundColor: colors.danger, color: '#fff', fontSize: 10 },
                    tabBarIcon: ({ color }) => <Glyph character="◉" color={color} />,
                }}
            />
            <Tabs.Screen
                name="settings"
                options={{ title: 'Settings', tabBarIcon: ({ color }) => <Glyph character="⚙" color={color} /> }}
            />
        </Tabs>
    );
}
