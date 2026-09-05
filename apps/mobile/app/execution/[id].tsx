import { useLocalSearchParams } from 'expo-router';
import { EmptyState } from '../../src/components';
import { ExecutionScreen } from '../../src/screens/ExecutionScreen';

export default function ExecutionRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    if (!id) return <EmptyState title="No execution" />;
    return <ExecutionScreen id={id} />;
}
