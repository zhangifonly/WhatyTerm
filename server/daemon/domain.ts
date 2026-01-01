/**
 * Domain - TypeScript translation of WezTerm's mux/src/domain.rs
 *
 * A Domain represents an instance of a multiplexer.
 * For example, the gui frontend has its own domain,
 * and we can connect to a domain hosted by a mux server
 * that may be local, running "remotely" inside a WSL
 * container or actually remote, running on the other end
 * of an ssh session somewhere.
 */

import { IPty, spawn as spawnPty, IPtyForkOptions } from 'node-pty';
import type { Pane, PaneId } from './pane';
import { allocPaneId } from './pane';
import { Tab, TabId, SplitRequest } from './tab';
import type { WindowId } from './window';
import { TerminalSize } from './renderable';

// Domain ID type and allocation
export type DomainId = number;

let nextDomainId = 0;
export function allocDomainId(): DomainId {
  return nextDomainId++;
}

/**
 * Domain state
 */
export enum DomainState {
  Detached = 'detached',
  Attached = 'attached',
}

/**
 * Source for split operation
 */
export type SplitSource =
  | { type: 'spawn'; command: string[] | null; commandDir: string | null }
  | { type: 'movePane'; paneId: PaneId };

/**
 * Command builder for spawning processes
 */
export interface CommandBuilder {
  /** Command arguments (first is the program) */
  argv: string[];
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env: Record<string, string>;
  /** Whether this is the default program */
  isDefaultProg: boolean;
}

export function createDefaultCommandBuilder(): CommandBuilder {
  return {
    argv: [],
    env: {},
    isDefaultProg: true,
  };
}

/**
 * Domain interface - represents a multiplexer instance
 */
export interface Domain {
  /**
   * Spawn a new command within this domain
   */
  spawn(
    size: TerminalSize,
    command: CommandBuilder | null,
    commandDir: string | null,
    window: WindowId
  ): Promise<Tab>;

  /**
   * Split a pane
   */
  splitPane(
    source: SplitSource,
    tabId: TabId,
    paneId: PaneId,
    splitRequest: SplitRequest
  ): Promise<Pane>;

  /**
   * Spawn a pane (internal)
   */
  spawnPane(
    size: TerminalSize,
    command: CommandBuilder | null,
    commandDir: string | null
  ): Promise<Pane>;

  /**
   * Move pane to new tab
   */
  movePaneToNewTab(
    paneId: PaneId,
    windowId: WindowId | null,
    workspaceForNewWindow: string | null
  ): Promise<{ tab: Tab; windowId: WindowId } | null>;

  /**
   * Returns false if spawn will never succeed
   */
  spawnable(): boolean;

  /**
   * Returns true if detach can be used
   */
  detachable(): boolean;

  /**
   * Get domain ID
   */
  domainId(): DomainId;

  /**
   * Get domain name
   */
  domainName(): string;

  /**
   * Get domain label
   */
  domainLabel(): Promise<string>;

  /**
   * Re-attach to pre-existing tabs
   */
  attach(windowId: WindowId | null): Promise<void>;

  /**
   * Detach all tabs
   */
  detach(): void;

  /**
   * Get domain state
   */
  state(): DomainState;
}

// Forward declaration for Mux (will be implemented in mux.ts)
interface MuxInterface {
  get(): MuxInterface;
  addTabAndActivePane(tab: Tab): void;
  addTabToWindow(tab: Tab, windowId: WindowId): void;
  getTab(tabId: TabId): Tab | null;
  resolvePaneId(paneId: PaneId): { domainId: DomainId; windowId: WindowId; tabId: TabId } | null;
  removeTab(tabId: TabId): void;
  addPane(pane: Pane): void;
}

let muxInstance: MuxInterface | null = null;

export function setMuxInstance(mux: MuxInterface): void {
  muxInstance = mux;
}

function getMux(): MuxInterface {
  if (!muxInstance) {
    throw new Error('Mux not initialized');
  }
  return muxInstance;
}

/**
 * Configuration interface
 */
interface Configuration {
  defaultProg: string[] | null;
  defaultCwd: string | null;
}

function getConfiguration(): Configuration {
  return {
    defaultProg: null,
    defaultCwd: null,
  };
}

/**
 * Local domain implementation
 */
export class LocalDomain implements Domain {
  private readonly id: DomainId;
  private readonly name: string;
  private domainStateValue: DomainState = DomainState.Attached;

  constructor(name: string) {
    this.id = allocDomainId();
    this.name = name;
  }

  async spawn(
    size: TerminalSize,
    command: CommandBuilder | null,
    commandDir: string | null,
    windowId: WindowId
  ): Promise<Tab> {
    const pane = await this.spawnPane(size, command, commandDir);

    const tab = new Tab(size);
    tab.assignPane(pane);

    const mux = getMux();
    mux.addTabAndActivePane(tab);
    mux.addTabToWindow(tab, windowId);

    return tab;
  }

  async splitPane(
    source: SplitSource,
    tabId: TabId,
    paneId: PaneId,
    splitRequest: SplitRequest
  ): Promise<Pane> {
    const mux = getMux();
    const tab = mux.getTab(tabId);
    if (!tab) {
      throw new Error(`Invalid tab id ${tabId}`);
    }

    const panes = tab.iterPanesIgnoringZoom();
    const paneInfo = panes.find((p) => p.pane.paneId() === paneId);
    if (!paneInfo) {
      throw new Error(`Invalid pane id ${paneId}`);
    }

    const splitSize = tab.computeSplitSize(paneInfo.index, splitRequest);
    if (!splitSize) {
      throw new Error(`Invalid pane index ${paneInfo.index}`);
    }

    let pane: Pane;

    if (source.type === 'spawn') {
      const cmd = source.command
        ? { argv: source.command, env: {}, isDefaultProg: false }
        : null;
      pane = await this.spawnPane(splitSize.second, cmd, source.commandDir);
    } else {
      // MovePane
      const resolved = mux.resolvePaneId(source.paneId);
      if (!resolved) {
        throw new Error(`Pane ${source.paneId} not found`);
      }

      const srcTab = mux.getTab(resolved.tabId);
      if (!srcTab) {
        throw new Error(`Invalid tab id ${resolved.tabId}`);
      }

      const removedPane = srcTab.removePane(source.paneId);
      if (!removedPane) {
        throw new Error(`Pane ${source.paneId} not found in its containing tab`);
      }

      if (srcTab.isDead()) {
        mux.removeTab(srcTab.getTabId());
      }

      pane = removedPane;
    }

    // pane_index may have changed if src_pane was also in the same tab
    const updatedPanes = tab.iterPanesIgnoringZoom();
    const finalPaneInfo = updatedPanes.find((p) => p.pane.paneId() === paneId);
    if (!finalPaneInfo) {
      throw new Error(`Invalid pane id ${paneId}`);
    }

    tab.splitAndInsert(finalPaneInfo.index, splitRequest, pane);
    return pane;
  }

  async spawnPane(
    size: TerminalSize,
    command: CommandBuilder | null,
    commandDir: string | null
  ): Promise<Pane> {
    const paneId = allocPaneId();
    const cmd = await this.buildCommand(command, commandDir, paneId);

    // Determine shell and args
    let shell: string;
    let args: string[];

    if (cmd.argv.length > 0) {
      shell = cmd.argv[0];
      args = cmd.argv.slice(1);
    } else {
      // Use default shell
      shell = process.platform === 'win32' ? 'cmd.exe' : process.env.SHELL || '/bin/bash';
      args = process.platform === 'win32' ? [] : ['-l'];
    }

    // Spawn PTY
    const ptyOptions: IPtyForkOptions = {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: cmd.cwd || commandDir || process.cwd(),
      env: { ...process.env, ...cmd.env } as Record<string, string>,
    };

    const pty = spawnPty(shell, args, ptyOptions);

    const commandDescription = `"${[shell, ...args].join(' ')}" in domain "${this.name}"`;

    // Create LocalPane (imported from local-pane.ts)
    const { LocalPane } = await import('./local-pane');
    const pane = new LocalPane(paneId, pty, this.id, commandDescription, size);

    const mux = getMux();
    mux.addPane(pane);

    return pane;
  }

  async movePaneToNewTab(
    _paneId: PaneId,
    _windowId: WindowId | null,
    _workspaceForNewWindow: string | null
  ): Promise<{ tab: Tab; windowId: WindowId } | null> {
    // Let mux handle the movement
    return null;
  }

  spawnable(): boolean {
    return true;
  }

  detachable(): boolean {
    return false;
  }

  domainId(): DomainId {
    return this.id;
  }

  domainName(): string {
    return this.name;
  }

  async domainLabel(): Promise<string> {
    return this.name;
  }

  async attach(_windowId: WindowId | null): Promise<void> {
    // Local domain is always attached
  }

  detach(): void {
    throw new Error('Detach not implemented for LocalDomain');
  }

  state(): DomainState {
    return this.domainStateValue;
  }

  private async buildCommand(
    command: CommandBuilder | null,
    commandDir: string | null,
    paneId: PaneId
  ): Promise<CommandBuilder> {
    const config = getConfiguration();

    let cmd: CommandBuilder;
    if (command) {
      cmd = { ...command };
      // Apply defaults if needed
      if (cmd.argv.length === 0 && config.defaultProg) {
        cmd.argv = [...config.defaultProg];
      }
    } else {
      cmd = {
        argv: config.defaultProg ? [...config.defaultProg] : [],
        env: {},
        isDefaultProg: true,
      };
    }

    if (commandDir) {
      cmd.cwd = commandDir;
    } else if (config.defaultCwd) {
      cmd.cwd = config.defaultCwd;
    }

    // Set environment variables
    cmd.env = cmd.env || {};
    cmd.env['WEZTERM_PANE'] = paneId.toString();

    // Platform-specific fixups
    await this.fixupCommand(cmd);

    return cmd;
  }

  private async fixupCommand(cmd: CommandBuilder): Promise<void> {
    // Check if cwd exists and is accessible
    if (cmd.cwd) {
      try {
        const fs = await import('fs');
        await fs.promises.access(cmd.cwd, fs.constants.R_OK);
      } catch {
        console.warn(
          `Directory ${cmd.cwd} is not readable and will not be used for the command we are spawning`
        );
        delete cmd.cwd;
      }
    }
  }
}

/**
 * Writer wrapper for sharing between Pane and Terminal
 */
export class WriterWrapper {
  private writer: (data: string | Uint8Array) => void;

  constructor(writer: (data: string | Uint8Array) => void) {
    this.writer = writer;
  }

  write(data: string | Uint8Array): void {
    this.writer(data);
  }
}

/**
 * Failed spawn placeholder for error cases
 */
export class FailedProcessSpawn {
  tryWait(): { exitCode: number } | null {
    return { exitCode: 1 };
  }

  wait(): { exitCode: number } {
    return { exitCode: 1 };
  }

  processId(): number | null {
    return null;
  }

  kill(): void {
    // No-op
  }
}
