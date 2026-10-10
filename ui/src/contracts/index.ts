import type { Localized } from '../localization/copy';
export type WorkState = 'working' | 'waiting' | 'completed' | 'uncertain' | 'error';
export type Progress = {
    kind: 'exact';
    completed: number;
    total: number;
} | {
    kind: 'estimated';
    percent: number;
    basis: Localized;
} | {
    kind: 'state-only';
};
export interface AssignmentView {
    nodeId: string;
    state: WorkState;
    role: Localized;
    blocker?: Localized;
}
export interface AssignmentGroup {
    groupId: string;
    step: Localized;
    parallel: boolean;
    assignments: AssignmentView[];
}
export interface TaskView {
    id: string;
    projectId: string;
    displayName: Localized;
    canonicalName: string;
    state: WorkState;
    progress: Progress;
    goal: Localized;
    next: Localized;
    groups: AssignmentGroup[];
    outputs: Localized[];
    error?: {
        code: string;
        category: string;
        reason: Localized;
        reviewEvidence?: string;
    };
    uncertainty?: Localized;
    runIds: string[];
    responsibilityId?: string;
}
export interface ProjectView {
    id: string;
    displayName: Localized;
    goal: Localized;
    state: WorkState;
    progress: Progress;
    taskIds: string[];
    recent: Localized[];
}
export interface RunView {
    id: string;
    taskId: string;
    sequence: number;
    state: string;
    targetSessionId: string;
    hostTurnEnded: boolean;
    checkpoint: Localized;
}
export interface NodeView {
    id: string;
    displayName: string;
    health: string;
    modelBinding: {
        id: string;
        provider: string;
        modelId: string;
    };
    sessions: {
        id: string;
        state: 'active' | 'standby' | 'retired';
        hostId: string;
        hytheId: string;
        locatorRef: string;
        health?: {state:string; observedAt?:string; meaning?:string};
    }[];
}
export type EvidenceState = 'recorded' | 'pending' | 'unknown' | 'rejected' | 'not_applicable';
export interface EffectView {
    id: string;
    taskId: string;
    requestId: string;
    targetSessionId: string;
    state: WorkState;
    scope: Localized;
    reservation: Localized;
    stages: {
        stage: string;
        state: EvidenceState;
        evidenceRef?: string;
    }[];
}
export interface SystemSnapshot {
    source: 'mock' | 'live';
    readStatus?: 'available' | 'unavailable' | 'denied' | 'uncertain';
    readCode?: string;
    worldId?: string;
    truncated?: boolean;
    health?: {title:string; state:string; observedAt:string; evidence:string}[];
    capturedAt: string;
    access: 'authorized' | 'denied';
    projects: ProjectView[];
    tasks: TaskView[];
    nodes: NodeView[];
    runs: RunView[];
    dependencies: {
        id: string;
        parentRunId: string;
        childTaskId: string;
        state: 'pending' | 'satisfied';
    }[];
    effects: EffectView[];
    resources: {
        id: string;
        title: Localized;
        scope: string;
        type: string;
    }[];
    events: {
        id: string;
        title: Localized;
        attests: string[];
    }[];
    connections: {
        id: string;
        title: string;
        state: string;
    }[];
    responsibilities: {
        id: string;
        state: string;
        deferReason?: Localized;
        tensionRef?: string;
    }[];
}
/** Exhaustive public projection: abnormal or unknown runtime states never become working. */
export function projectState(state: string): WorkState { switch (state) {
    case 'running':
    case 'active': return 'working';
    case 'queued':
    case 'waiting':
    case 'waiting_dependency': return 'waiting';
    case 'completed': return 'completed';
    case 'uncertain': return 'uncertain';
    default: return 'error';
} }
