import type { CreateTaskInput, JsonObject, ScheduleTiming } from '../types.js';
import type { Key, Point, Swipe, UiNode } from '../drivers/types.js';

/**
 * The narrow shapes the MCP tools need. Structural subsets of the real
 * `SchedulerRepository` rows so the live repository satisfies them unchanged,
 * and a test fake stays small.
 */
export interface ScheduleLike {
    id: string;
    deviceUdid: string;
    pluginId: string;
    taskType: string;
    taskVersion: number;
    payload: JsonObject;
    timing: ScheduleTiming;
    status: string;
    runWindowMinutes: number;
    nextRunAt: Date | null;
    createdAt: Date;
}

export interface ExecutionLike {
    id: string;
    scheduleId: string | null;
    deviceUdid: string;
    pluginId: string;
    taskType: string;
    taskVersion: number;
    payload: JsonObject;
    status: string;
    scheduledFor: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
    exitCode: number | null;
    error: string | null;
}

export interface ExecutionDetailLike extends ExecutionLike {
    logs: string[];
}

export interface AssetLike {
    id: string;
    name: string;
    mimeType: string;
    size?: number;
    createdAt?: Date;
}

export interface SchedulerLike {
    listSchedules(limit?: number, deviceUdid?: string): Promise<readonly ScheduleLike[]>;
    createTask(
        input: CreateTaskInput, devicePluginData?: JsonObject, now?: Date, assetIds?: string[],
    ): Promise<ScheduleLike>;
    setScheduleStatus(id: string, status: 'active' | 'paused' | 'cancelled'): Promise<ScheduleLike | null>;
    listExecutions(limit?: number, deviceUdid?: string): Promise<readonly ExecutionLike[]>;
    execution(id: string): Promise<ExecutionDetailLike | null>;
    requestStop(id: string): Promise<string>;
    retryExecution(id: string): Promise<ExecutionLike | null>;
    registerAssets(files: readonly {
        relativePath: string; originalName: string; mimeType: string; size: number; sha256: string;
    }[]): Promise<Array<{ id: string; name: string; mimeType: string }>>;
}

export interface DeviceLike {
    udid: string;
    name: string;
    platform?: string;
    osVersion?: string;
    disabled?: boolean;
    coordinateProfile?: string;
    pluginData: Record<string, JsonObject>;
}

export interface ConnectedDeviceLike {
    udid: string;
    name: string;
    platform?: string;
    osVersion: string;
    modelName?: string;
}

export interface PluginLike {
    id: string;
    version: string;
    displayName: string;
    tasks: readonly { type: string; version: number; displayName: string }[];
}

/**
 * The part of `DeviceDriver` the agent-facing tools need. A real driver satisfies it as it is;
 * a test fake only has to implement these seven verbs rather than the whole control channel.
 */
export interface DeviceControlLike {
    readonly udid: string;
    uiTree(): Promise<UiNode>;
    screenshot(): Promise<Buffer>;
    tap(point: Point): Promise<void>;
    swipe(swipe: Swipe): Promise<void>;
    pressKey(key: Key): Promise<void>;
    type(text: string): Promise<void>;
    launchApp(appId: string): Promise<void>;
}

/** Everything the tool set calls. Wired to the live farm in `dependencies.ts`, faked in tests. */
export interface McpDependencies {
    scheduler: SchedulerLike;
    loadDevices(): Promise<readonly DeviceLike[]>;
    discoverDevices(): Promise<readonly ConnectedDeviceLike[]>;
    screenshot(udid: string): Promise<Buffer>;
    listAssets(limit: number): Promise<readonly AssetLike[]>;
    listPlugins(): readonly PluginLike[];
    /** Where uploaded media lands. Defaults to SCHEDULER_DATA_DIR. */
    dataDirectory?: string;
    /** Directories `upload_asset`'s `path` may read. Defaults to MCP_UPLOAD_DIRS / the content directory. */
    uploadDirectories?: readonly string[];
    /**
     * A live control channel for one phone. Absent means this deployment does not expose device
     * control over MCP at all, and the read_screen / tap / swipe / type family says so rather
     * than half-working.
     */
    control?(udid: string): Promise<DeviceControlLike>;
    /** Where confirmed selectors are stored. Defaults to `<data dir>/selector-overrides.json`. */
    selectorOverridesPath?: string;
}
