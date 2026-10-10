import type { SystemSnapshot } from '../contracts';
import { snapshot } from '../mocks/snapshot';
export type SnapshotScenario = 'live' | 'normal' | 'empty' | 'blocked' | 'error' | 'loading';
export interface BackendAdapter {
    readSnapshot(signal?: AbortSignal, scenario?: SnapshotScenario): Promise<SystemSnapshot>;
}
/** Single future authorized public-read integration seam; no mutations or replay. */
export const backendAdapter: BackendAdapter = { async readSnapshot(signal, scenario = 'live') {
        if (scenario === 'live') {
            const response = await fetch('/api/r1/snapshot', {signal, cache:'no-store'});
            if (!response.ok) throw new Error('READ_UNAVAILABLE');
            return await response.json() as SystemSnapshot;
        }
        await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 100); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true }); });
        if (signal?.aborted)
            throw new DOMException('Aborted', 'AbortError');
        if (scenario === 'error')
            throw new Error('READ_UNAVAILABLE');
        const result = structuredClone(snapshot);
        if (scenario === 'blocked' || scenario === 'empty') {
            for (const key of ['projects', 'tasks', 'nodes', 'runs', 'dependencies', 'effects', 'resources', 'events', 'connections', 'responsibilities'] as const)
                result[key] = [];
            if (scenario === 'blocked')
                result.access = 'denied';
        }
        return result;
    } };
