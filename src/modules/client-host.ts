import { systemKey } from './manifest.js';
import type {
  SystemClientContext,
  SystemClientLoader,
  SystemClientModule,
  SystemRuntimeInfo,
} from './client-contract.js';
import type { CharacterSheet } from '../shared/board.js';
import type { SystemSheetRenderOptions } from './client-contract.js';

export type SystemActivationResult =
  | { status: 'mounted' }
  | { status: 'already-mounted' }
  | { status: 'inactive' }
  | { status: 'stale' }
  | { status: 'error'; error: Error };

export interface SystemHostOptions {
  load: SystemClientLoader;
  createContext(system: SystemRuntimeInfo): SystemClientContext;
  onError?(error: Error, system: SystemRuntimeInfo): void;
}

interface MountedSystem {
  roomId: string;
  key: string;
  system: SystemRuntimeInfo;
  instance: SystemClientModule;
}

/**
 * Room-scoped client module lifecycle.
 *
 * The module code is cached by `load`, but every successful mount creates a new
 * instance. A monotonically increasing generation plus the captured room id
 * prevents a slow import from mounting after the user has left the room.
 */
export class SystemHost {
  private generation = 0;
  private mounted?: MountedSystem;

  constructor(private readonly options: SystemHostOptions) {}

  get activeKey(): string | undefined {
    return this.mounted?.key;
  }

  get activeRoomId(): string | undefined {
    return this.mounted?.roomId;
  }

  get instance(): SystemClientModule | undefined {
    return this.mounted?.instance;
  }

  get system(): SystemRuntimeInfo | undefined {
    return this.mounted?.system;
  }

  isActive(roomId: string, system: Pick<SystemRuntimeInfo, 'id' | 'version'>): boolean {
    return this.mounted?.roomId === roomId && this.mounted.key === systemKey(system.id, system.version);
  }

  async activate(roomId: string, system: SystemRuntimeInfo | null | undefined): Promise<SystemActivationResult> {
    if (!system?.id || !system.version) {
      this.deactivate();
      return { status: 'inactive' };
    }
    const key = systemKey(system.id, system.version);
    if (this.mounted?.roomId === roomId && this.mounted.key === key) {
      return { status: 'already-mounted' };
    }

    const generation = ++this.generation;
    this.disposeMounted();

    let instance: SystemClientModule | undefined;
    try {
      const factory = await this.options.load(system.id, system.version);
      if (generation !== this.generation) return { status: 'stale' };

      instance = factory.createClientModule();
      if (generation !== this.generation) {
        instance.dispose();
        return { status: 'stale' };
      }

      await instance.mount(this.options.createContext(system));
      if (generation !== this.generation) {
        instance.dispose();
        return { status: 'stale' };
      }

      this.mounted = { roomId, key, system, instance };
      return { status: 'mounted' };
    } catch (error) {
      instance?.dispose();
      if (generation !== this.generation) return { status: 'stale' };
      const failure = error instanceof Error ? error : new Error('Не удалось загрузить системный модуль.');
      this.options.onError?.(failure, system);
      return { status: 'error', error: failure };
    }
  }

  /** Called on logout, room change or a room without a fixed system. */
  deactivate(): void {
    this.generation += 1;
    this.disposeMounted();
  }

  renderSheet(sheet: CharacterSheet, options: SystemSheetRenderOptions): void {
    this.mounted?.instance.renderSheet?.(sheet, options);
  }

  /** True when the mounted module draws its own profile/header controls. */
  get ownsProfile(): boolean {
    return this.mounted?.instance.ownsProfile === true;
  }

  renderRollControls(): void {
    this.mounted?.instance.renderRollControls?.();
  }

  private disposeMounted(): void {
    const mounted = this.mounted;
    this.mounted = undefined;
    if (!mounted) return;
    try {
      mounted.instance.dispose();
    } catch {
      /* Disposal must never prevent switching rooms. */
    }
  }
}
