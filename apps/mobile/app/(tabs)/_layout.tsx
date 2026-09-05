import type { ColorValue } from 'react-native';
import { Tabs } from 'expo-router/js-tabs';
import { useFarm } from '../../src/context/FarmContext';
import { Icon, type IconName } from '../../src/icons';
import { useTheme } from '../../src/theme';

/**
 * Wall, Schedule, Content, Alerts, Rig — the five the design fixes, in that
 * order. Settings is not a tab: it lives under Rig, which is where the rest of
 * "the machine that runs this" already is.
 *
 * The glyphs are the Backline set drawn as SVG, at 24 as the design says the
 * phone draws them. No emoji, no icon font.
 *
 * The Alerts badge comes from `/api/mobile/bootstrap`'s `unacknowledgedCount`
 * and is per-token, so two teammates see their own.
 */
function tabIcon(name: IconName) {
    return function TabIcon({ color }: { color: ColorValue }) {
        return <Icon name={name} size={24} color={String(color)} strokeWidth={1.8} />;
    };
}

export default function TabsLayout() {
    const { colors } = useTheme();
    const { unacknowledgedCount, snapshot } = useFarm();
    const capabilities = snapshot?.capabilities ?? {};

    return (
        <Tabs
            screenOptions={{
                headerShown: false,
                tabBarStyle: { backgroundColor: colors.panel, borderTopColor: colors.line, borderTopWidth: 1 },
                tabBarActiveTintColor: colors.accent,
                // The mockup's #8a919d is 2.9:1 on white; `text-3` is the
                // nearest token that a 10.5px label can be read at.
                tabBarInactiveTintColor: colors.text3,
                tabBarLabelStyle: { fontSize: 10.5, fontWeight: '600' },
                sceneStyle: { backgroundColor: colors.bg },
            }}
        >
            <Tabs.Screen name="index" options={{ title: 'Wall', tabBarIcon: tabIcon('grid') }} />
            <Tabs.Screen name="schedule" options={{ title: 'Schedule', tabBarIcon: tabIcon('clock') }} />
            <Tabs.Screen
                name="content"
                options={{
                    title: 'Content',
                    // An older farm without the drip queue hides the tab rather
                    // than 404-ing on it (`capabilities`, gap 4).
                    href: capabilities.contentQueue === false ? null : undefined,
                    tabBarIcon: tabIcon('film'),
                }}
            />
            <Tabs.Screen
                name="alerts"
                options={{
                    title: 'Alerts',
                    tabBarBadge: unacknowledgedCount > 0 ? unacknowledgedCount : undefined,
                    tabBarBadgeStyle: {
                        backgroundColor: colors.bad,
                        color: '#ffffff',
                        fontSize: 10.5,
                        minWidth: 17,
                        height: 17,
                        lineHeight: 17,
                        borderRadius: 9,
                    },
                    tabBarIcon: tabIcon('bell'),
                }}
            />
            <Tabs.Screen name="rig" options={{ title: 'Rig', tabBarIcon: tabIcon('rig') }} />
        </Tabs>
    );
}
