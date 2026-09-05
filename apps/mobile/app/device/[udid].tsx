import { useLocalSearchParams } from 'expo-router';
import { EmptyState } from '../../src/components';
import { DeviceScreen } from '../../src/screens/DeviceScreen';

export default function DeviceRoute() {
    const { udid } = useLocalSearchParams<{ udid: string }>();
    if (!udid) return <EmptyState title="No device" />;
    return <DeviceScreen udid={udid} />;
}
