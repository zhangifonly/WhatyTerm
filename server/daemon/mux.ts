/**
 * Mux - TypeScript translation of WezTerm's mux/src/lib.rs
 *
 * The Mux (multiplexer) is the central coordinator for all panes, tabs, windows, and domains.
 * It manages the lifecycle of terminal sessions and provides notifications for state changes.
 */

import { EventEmitter } from 'events';
import type { Pane, PaneId } from './pane';
import { CachePolicy } from './pane';
import { Tab, TabId, SplitRequest, setMuxInstance as setTabMuxInstance } from './tab';
import { Window, WindowId, MuxNotification, Tab as TabInterface, setWindowMuxInstance } from './window';
import type { Domain } from './domain';
import { DomainId, DomainState, SplitSource, setMuxInstance as setDomainMuxInstance } from './domain';
import { ClientId, ClientInfo } from './client';
import { Activity } from './activity';
import { TerminalSize } from './renderable';

export const DEFAULT_WORKSPACE = 'default';

// Re-export MuxNotification
export { MuxNotification } from './window';

/**
 * Extended MuxNotification types specific to Mux
 */
export type ExtendedMuxNotification =
  | MuxNotification
  | { type: 'PaneOutput'; paneId: PaneId }
  | { type: 'PaneAdded'; paneId: PaneId }
  | { type: 'PaneRemoved'; paneId: PaneId }
  | { type: 'WindowCreated'; windowId: WindowId }
  | { type: 'WindowRemoved'; windowId: WindowId }
  | { type: 'Empty' }
  | { type: 'AssignClipboard'; paneId: PaneId; selection: string; clipboard: string | null }
  | { type: 'SaveToDownloads'; name: string | null; data: Uint8Array }
  | { type: 'TabAddedToWindow'; tabId: TabId; windowId: WindowId }
  | { type: 'ActiveWorkspaceChanged'; clientId: ClientId }
  | { type: 'WorkspaceRenamed'; oldWorkspace: string; newWorkspace: string };

/**
 * MuxWindowBuilder - helper for creating windows
 */
export class MuxWindowBuilder {
  private windowId: WindowId;
  private activity: Activity | null;
  private notified = false;
  private mux: Mux;

  constructor(windowId: WindowId, mux: Mux) {
    this.windowId = windowId;
    this.activity = new Activity();
    this.mux = mux;
  }

  getWindowId(): WindowId {
    return this.windowId;
  }

  notify(): void {
    if (this.notified) return;
    this.notified = true;
    this.activity = null;
    this.mux.notify({ type: 'WindowCreated', windowId: this.windowId });
  }

  dispose(): void {
    this.notify();
  }
}

/**
 * IdentityHolder - RAII-style identity management
 */
export class IdentityHolder {
  private prior: ClientId | null;
  private mux: Mux;

  constructor(prior: ClientId | null, mux: Mux) {
    this.prior = prior;
    this.mux = mux;
  }

  dispose(): void {
    this.mux.replaceIdentity(this.prior);
  }
}

/**
 * Mux - The central multiplexer
 */
export class Mux extends EventEmitter {
  private static instance: Mux | null = null;

  private tabs = new Map<TabId, Tab>();
  private panes = new Map<PaneId, Pane>();
  private windows = new Map<WindowId, Window>();
  private defaultDomain: Domain | null = null;
  private domains = new Map<DomainId, Domain>();
  private domainsByName = new Map<string, Domain>();
  private subscribers = new Map<number, (notification: ExtendedMuxNotification) => boolean>();
  private banner: string | null = null;
  private clients = new Map<ClientId, ClientInfo>();
  private identity: ClientId | null = null;
  private numPanesByWorkspace = new Map<string, number>();
  private nextSubId = 0;

  constructor(defaultDomain?: Domain) {
    super();

    if (defaultDomain) {
      this.domains.set(defaultDomain.domainId(), defaultDomain);
      this.domainsByName.set(defaultDomain.domainName(), defaultDomain);
      this.defaultDomain = defaultDomain;
    }

    // Set this instance for other modules
    setDomainMuxInstance(this as any);
    setTabMuxInstance(this as any);
  }

  // Singleton methods
  static setMux(mux: Mux): void {
    Mux.instance = mux;
    setWindowMuxInstance(mux as any);
    setTabMuxInstance(mux as any);
    setDomainMuxInstance(mux as any);
  }

  static shutdown(): void {
    Mux.instance = null;
    setWindowMuxInstance(null as any);
    setTabMuxInstance(null as any);
    setDomainMuxInstance(null as any);
  }

  static get(): Mux {
    const mux = Mux.tryGet();
    if (!mux) {
      throw new Error('Mux not initialized');
    }
    return mux;
  }

  static tryGet(): Mux | null {
    return Mux.instance;
  }

  // Workspace methods
  private getDefaultWorkspace(): string {
    return DEFAULT_WORKSPACE;
  }

  private recomputePaneCount(): void {
    const count = new Map<string, number>();
    for (const window of this.windows.values()) {
      const workspace = window.getWorkspace();
      for (const tab of window.iter()) {
        const paneCount = tab.countPanes();
        count.set(workspace, (count.get(workspace) || 0) + paneCount);
      }
    }
    this.numPanesByWorkspace = count;
  }

  // Client methods
  clientHadInput(clientId: ClientId): void {
    const info = this.clients.get(clientId);
    if (info) {
      info.updateLastInput();
    }
  }

  recordInputForCurrentIdentity(): void {
    if (this.identity) {
      this.clientHadInput(this.identity);
    }
  }

  recordFocusForCurrentIdentity(paneId: PaneId): void {
    if (this.identity) {
      this.recordFocusForClient(this.identity, paneId);
    }
  }

  resolveFocusedPane(clientId: ClientId): { domainId: DomainId; windowId: WindowId; tabId: TabId; paneId: PaneId } | null {
    const info = this.clients.get(clientId);
    if (!info || info.focusedPaneId === null) return null;

    const resolved = this.resolvePaneId(info.focusedPaneId);
    if (!resolved) return null;

    return { ...resolved, paneId: info.focusedPaneId };
  }

  recordFocusForClient(clientId: ClientId, paneId: PaneId): void {
    const info = this.clients.get(clientId);
    if (!info) return;

    const prior = info.focusedPaneId;
    info.updateFocusedPane(paneId);

    if (prior === paneId) return;

    // Synthesize focus events
    if (prior !== null) {
      const priorPane = this.getPane(prior);
      if (priorPane) {
        priorPane.focusChanged(false);
      }
    }

    const pane = this.getPane(paneId);
    if (pane) {
      pane.focusChanged(true);
    }
  }

  focusPaneAndContainingTab(paneId: PaneId): void {
    const pane = this.getPane(paneId);
    if (!pane) {
      throw new Error(`pane ${paneId} not found`);
    }

    const resolved = this.resolvePaneId(paneId);
    if (!resolved) {
      throw new Error(`cannot find ${paneId} in the mux`);
    }

    // Focus/activate the containing tab within its window
    const window = this.getWindowMut(resolved.windowId);
    if (!window) {
      throw new Error(`window_id ${resolved.windowId} not found`);
    }

    const tabIdx = window.idxById(resolved.tabId);
    if (tabIdx === null) {
      throw new Error(`tab ${resolved.tabId} not in ${resolved.windowId}`);
    }

    window.saveAndThenSetActive(tabIdx);

    // Focus/activate the pane locally
    const tab = this.getTab(resolved.tabId);
    if (!tab) {
      throw new Error(`tab ${resolved.tabId} not found`);
    }

    tab.setActivePane(pane);
  }

  registerClient(clientId: ClientId): void {
    this.clients.set(clientId, new ClientInfo(clientId));
  }

  iterClients(): ClientInfo[] {
    return Array.from(this.clients.values());
  }

  iterWorkspaces(): string[] {
    const names = new Set<string>();
    for (const window of this.windows.values()) {
      names.add(window.getWorkspace());
    }
    return Array.from(names).sort();
  }

  generateWorkspaceName(): string {
    const used = new Set(this.iterWorkspaces());
    let counter = 1;
    while (true) {
      const candidate = `workspace-${counter}`;
      if (!used.has(candidate)) {
        return candidate;
      }
      counter++;
    }
  }

  activeWorkspace(): string {
    if (this.identity) {
      const info = this.clients.get(this.identity);
      if (info?.activeWorkspace) {
        return info.activeWorkspace;
      }
    }
    return this.getDefaultWorkspace();
  }

  activeWorkspaceForClient(clientId: ClientId): string {
    const info = this.clients.get(clientId);
    return info?.activeWorkspace || this.getDefaultWorkspace();
  }

  setActiveWorkspaceForClient(clientId: ClientId, workspace: string): void {
    const info = this.clients.get(clientId);
    if (info) {
      info.activeWorkspace = workspace;
      this.notify({ type: 'ActiveWorkspaceChanged', clientId });
    }
  }

  setActiveWorkspace(workspace: string): void {
    if (this.identity) {
      this.setActiveWorkspaceForClient(this.identity, workspace);
    }
  }

  renameWorkspace(oldWorkspace: string, newWorkspace: string): void {
    if (oldWorkspace === newWorkspace) return;

    this.notify({ type: 'WorkspaceRenamed', oldWorkspace, newWorkspace });

    for (const window of this.windows.values()) {
      if (window.getWorkspace() === oldWorkspace) {
        window.setWorkspace(newWorkspace);
      }
    }

    this.recomputePaneCount();

    for (const client of this.clients.values()) {
      if (client.activeWorkspace === oldWorkspace) {
        client.activeWorkspace = newWorkspace;
        this.notify({ type: 'ActiveWorkspaceChanged', clientId: client.clientId });
      }
    }
  }

  withIdentity(id: ClientId | null): IdentityHolder {
    const prior = this.replaceIdentity(id);
    return new IdentityHolder(prior, this);
  }

  replaceIdentity(id: ClientId | null): ClientId | null {
    const prior = this.identity;
    this.identity = id;
    return prior;
  }

  activeIdentity(): ClientId | null {
    return this.identity;
  }

  unregisterClient(clientId: ClientId): void {
    this.clients.delete(clientId);
  }

  // Subscription methods
  subscribe(subscriber: (notification: ExtendedMuxNotification) => boolean): number {
    const subId = this.nextSubId++;
    this.subscribers.set(subId, subscriber);
    return subId;
  }

  unsubscribe(subId: number): void {
    this.subscribers.delete(subId);
  }

  notify(notification: ExtendedMuxNotification): void {
    const toRemove: number[] = [];
    for (const [id, subscriber] of this.subscribers) {
      if (!subscriber(notification)) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      this.subscribers.delete(id);
    }
    this.emit('notification', notification);
  }

  static notifyFromAnyThread(notification: ExtendedMuxNotification): void {
    const mux = Mux.tryGet();
    if (mux) {
      mux.notify(notification);
    }
  }

  // Domain methods
  getDefaultDomain(): Domain {
    if (!this.defaultDomain) {
      throw new Error('No default domain');
    }
    return this.defaultDomain;
  }

  setDefaultDomain(domain: Domain): void {
    this.defaultDomain = domain;
  }

  getDomain(id: DomainId): Domain | null {
    return this.domains.get(id) || null;
  }

  getDomainByName(name: string): Domain | null {
    return this.domainsByName.get(name) || null;
  }

  addDomain(domain: Domain): void {
    if (!this.defaultDomain) {
      this.defaultDomain = domain;
    }
    this.domains.set(domain.domainId(), domain);
    this.domainsByName.set(domain.domainName(), domain);
  }

  // Pane methods
  getPane(paneId: PaneId): Pane | null {
    return this.panes.get(paneId) || null;
  }

  addPane(pane: Pane): void {
    if (this.panes.has(pane.paneId())) return;

    this.panes.set(pane.paneId(), pane);
    this.recomputePaneCount();
    this.notify({ type: 'PaneAdded', paneId: pane.paneId() });
  }

  private removePaneInternal(paneId: PaneId): void {
    const pane = this.panes.get(paneId);
    if (pane) {
      pane.kill();
      this.panes.delete(paneId);
      this.notify({ type: 'PaneRemoved', paneId });
      this.recomputePaneCount();
    }
  }

  removePane(paneId: PaneId): void {
    this.removePaneInternal(paneId);
    this.pruneDeadWindows();
  }

  iterPanes(): Pane[] {
    return Array.from(this.panes.values());
  }

  // Tab methods
  getTab(tabId: TabId): Tab | null {
    return this.tabs.get(tabId) || null;
  }

  addTabNoPanes(tab: Tab): void {
    this.tabs.set(tab.getTabId(), tab);
    this.recomputePaneCount();
  }

  addTabAndActivePane(tab: Tab): void {
    this.tabs.set(tab.getTabId(), tab);
    const pane = tab.getActivePane();
    if (pane) {
      this.addPane(pane);
    }
  }

  private removeTabInternal(tabId: TabId): Tab | null {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;

    this.tabs.delete(tabId);

    // Remove from windows
    for (const window of this.windows.values()) {
      window.removeById(tabId);
    }

    // Remove panes
    for (const pos of tab.iterPanesIgnoringZoom()) {
      this.removePaneInternal(pos.pane.paneId());
    }

    this.recomputePaneCount();
    return tab;
  }

  removeTab(tabId: TabId): Tab | null {
    const tab = this.removeTabInternal(tabId);
    this.pruneDeadWindows();
    return tab;
  }

  // Window methods
  getWindow(windowId: WindowId): Window | null {
    return this.windows.get(windowId) || null;
  }

  getWindowMut(windowId: WindowId): Window | null {
    return this.windows.get(windowId) || null;
  }

  getActiveTabForWindow(windowId: WindowId): Tab | null {
    const window = this.getWindow(windowId);
    return (window?.getActive() as Tab | null) || null;
  }

  newEmptyWindow(workspace?: string, position?: any): MuxWindowBuilder {
    const window = new Window(workspace, position);
    const windowId = window.windowId();
    this.windows.set(windowId, window);
    return new MuxWindowBuilder(windowId, this);
  }

  addTabToWindow(tab: Tab, windowId: WindowId): void {
    const window = this.getWindowMut(windowId);
    if (!window) {
      throw new Error(`add_tab_to_window: no such window_id ${windowId}`);
    }
    window.push(tab);
    this.recomputePaneCount();
    this.notify({ type: 'TabAddedToWindow', tabId: tab.getTabId(), windowId });
  }

  windowContainingTab(tabId: TabId): WindowId | null {
    for (const window of this.windows.values()) {
      for (const tab of window.iter()) {
        if (tab.getTabId() === tabId) {
          return window.windowId();
        }
      }
    }
    return null;
  }

  private removeWindowInternal(windowId: WindowId): void {
    const window = this.windows.get(windowId);
    if (!window) return;

    // Gather domains
    const domainsOfWindow = new Set<DomainId>();
    for (const tab of window.iter()) {
      for (const pos of tab.iterPanesIgnoringZoom()) {
        domainsOfWindow.add(pos.pane.domainId());
      }
    }

    // Detach detachable domains
    for (const domainId of domainsOfWindow) {
      const domain = this.getDomain(domainId);
      if (domain?.detachable()) {
        try {
          domain.detach();
        } catch (err) {
          console.error(`while detaching domain ${domainId}: ${err}`);
        }
      }
    }

    // Remove tabs
    for (const tab of window.iter()) {
      this.removeTabInternal(tab.getTabId());
    }

    this.windows.delete(windowId);
    this.notify({ type: 'WindowRemoved', windowId });
    this.recomputePaneCount();
  }

  killWindow(windowId: WindowId): void {
    this.removeWindowInternal(windowId);
    this.pruneDeadWindows();
  }

  iterWindowsInWorkspace(workspace: string): WindowId[] {
    const windows: WindowId[] = [];
    for (const [id, window] of this.windows) {
      if (window.getWorkspace() === workspace) {
        windows.push(id);
      }
    }
    return windows.sort((a, b) => a - b);
  }

  iterWindows(): WindowId[] {
    return Array.from(this.windows.keys());
  }

  iterDomains(): Domain[] {
    return Array.from(this.domains.values());
  }

  // Resolution methods
  resolvePaneId(paneId: PaneId): { domainId: DomainId; windowId: WindowId; tabId: TabId } | null {
    let tabId: TabId | null = null;
    let domainId: DomainId | null = null;

    for (const tab of this.tabs.values()) {
      for (const pos of tab.iterPanesIgnoringZoom()) {
        if (pos.pane.paneId() === paneId) {
          tabId = tab.getTabId();
          domainId = pos.pane.domainId();
          break;
        }
      }
      if (tabId !== null) break;
    }

    if (tabId === null || domainId === null) return null;

    const windowId = this.windowContainingTab(tabId);
    if (windowId === null) return null;

    return { domainId, windowId, tabId };
  }

  // Lifecycle methods
  isEmpty(): boolean {
    return this.panes.size === 0;
  }

  isWorkspaceEmpty(workspace: string): boolean {
    return (this.numPanesByWorkspace.get(workspace) || 0) === 0;
  }

  isActiveWorkspaceEmpty(): boolean {
    return this.isWorkspaceEmpty(this.activeWorkspace());
  }

  pruneDeadWindows(): void {
    if (Activity.count() > 0) return;

    const liveTabIds = Array.from(this.tabs.keys());
    const deadWindows: WindowId[] = [];
    const deadTabIds: TabId[] = [];

    // Prune dead tabs from windows
    for (const [windowId, window] of this.windows) {
      window.pruneDeadTabs(liveTabIds);
      if (window.isEmpty()) {
        deadWindows.push(windowId);
      }
    }

    // Find dead tabs
    for (const [tabId, tab] of this.tabs) {
      if (tab.isDead()) {
        deadTabIds.push(tabId);
      }
    }

    // Remove dead tabs
    for (const tabId of deadTabIds) {
      this.removeTabInternal(tabId);
    }

    // Remove dead windows
    for (const windowId of deadWindows) {
      this.removeWindowInternal(windowId);
    }

    if (this.isEmpty()) {
      this.notify({ type: 'Empty' });
    }
  }

  domainWasDetached(domainId: DomainId): void {
    const deadPanes: PaneId[] = [];
    for (const pane of this.panes.values()) {
      if (pane.domainId() === domainId) {
        deadPanes.push(pane.paneId());
      }
    }

    for (const window of this.windows.values()) {
      for (const tab of window.iter()) {
        tab.killPanesInDomain(domainId);
      }
    }

    for (const paneId of deadPanes) {
      this.removePaneInternal(paneId);
    }

    this.pruneDeadWindows();
  }

  setBanner(banner: string | null): void {
    this.banner = banner;
  }

  getBanner(): string | null {
    return this.banner;
  }

  // Spawn methods
  async spawnTabOrWindow(
    windowId: WindowId | null,
    domain: Domain,
    command: any | null,
    commandDir: string | null,
    size: TerminalSize,
    currentPaneId: PaneId | null,
    workspaceForNewWindow: string,
    windowPosition?: any
  ): Promise<{ tab: Tab; pane: Pane; windowId: WindowId }> {
    let builder: MuxWindowBuilder | null = null;
    let termConfig: any = null;
    let finalWindowId: WindowId;
    let finalSize: TerminalSize;

    if (windowId !== null) {
      const window = this.getWindowMut(windowId);
      if (!window) {
        throw new Error(`window_id ${windowId} not found on this server`);
      }
      const tab = window.getActive();
      if (!tab) {
        throw new Error(`window ${windowId} has no tabs`);
      }
      const pane = tab.getActivePane();
      if (pane) {
        termConfig = (pane as any).getConfig?.();
      }
      finalSize = tab.getSize();
      finalWindowId = windowId;
    } else {
      builder = this.newEmptyWindow(workspaceForNewWindow, windowPosition);
      finalWindowId = builder.getWindowId();
      finalSize = size;
    }

    if (domain.state() === DomainState.Detached) {
      await domain.attach(finalWindowId);
    }

    const cwd = this.resolveCwd(commandDir, currentPaneId, domain.domainId());

    const tab = await domain.spawn(finalSize, command, cwd, finalWindowId);
    const pane = tab.getActivePane();
    if (!pane) {
      throw new Error('missing active pane on tab');
    }

    if (termConfig && (pane as any).setConfig) {
      (pane as any).setConfig(termConfig);
    }

    const window = this.getWindowMut(finalWindowId);
    if (window) {
      const idx = window.idxById(tab.getTabId());
      if (idx !== null) {
        window.saveAndThenSetActive(idx);
      }
    }

    if (builder) {
      builder.dispose();
    }

    return { tab, pane, windowId: finalWindowId };
  }

  private resolveCwd(
    commandDir: string | null,
    currentPaneId: PaneId | null,
    targetDomainId: DomainId
  ): string | null {
    if (commandDir) return commandDir;

    if (currentPaneId !== null) {
      const pane = this.getPane(currentPaneId);
      if (pane && pane.domainId() === targetDomainId) {
        const url = pane.getCurrentWorkingDir(CachePolicy.FetchImmediate);
        if (url) {
          // Parse URL and extract path
          try {
            const parsed = new URL(url);
            let path = decodeURIComponent(parsed.pathname);
            // Windows path fixup
            if (path.length > 2 && path[0] === '/' && path[2] === ':') {
              path = path.substring(1);
            }
            return path;
          } catch {
            return null;
          }
        }
      }
    }

    return null;
  }

  async splitPane(
    paneId: PaneId,
    request: SplitRequest,
    source: SplitSource,
    domain: Domain
  ): Promise<{ pane: Pane; size: TerminalSize }> {
    const resolved = this.resolvePaneId(paneId);
    if (!resolved) {
      throw new Error(`pane_id ${paneId} invalid`);
    }

    if (domain.state() === DomainState.Detached) {
      await domain.attach(resolved.windowId);
    }

    const currentPane = this.getPane(paneId);
    if (!currentPane) {
      throw new Error(`pane_id ${paneId} is invalid`);
    }

    const termConfig = (currentPane as any).getConfig?.();

    let finalSource = source;
    if (source.type === 'spawn') {
      finalSource = {
        type: 'spawn',
        command: source.command,
        commandDir: this.resolveCwd(source.commandDir, paneId, domain.domainId()),
      };
    }

    const pane = await domain.splitPane(finalSource, resolved.tabId, paneId, request);

    if (termConfig && (pane as any).setConfig) {
      (pane as any).setConfig(termConfig);
    }

    const dims = pane.getDimensions();
    const size: TerminalSize = {
      cols: dims.cols,
      rows: dims.viewportRows,
      pixelHeight: 0,
      pixelWidth: 0,
      dpi: dims.dpi,
    };

    return { pane, size };
  }

  async movePaneToNewTab(
    paneId: PaneId,
    windowId: WindowId | null,
    workspaceForNewWindow: string | null
  ): Promise<{ tab: Tab; windowId: WindowId }> {
    const resolved = this.resolvePaneId(paneId);
    if (!resolved) {
      throw new Error(`pane ${paneId} not found`);
    }

    const domain = this.getDomain(resolved.domainId);
    if (!domain) {
      throw new Error(`domain ${resolved.domainId} of pane ${paneId} not found`);
    }

    const domainResult = await domain.movePaneToNewTab(paneId, windowId, workspaceForNewWindow);
    if (domainResult) {
      return domainResult;
    }

    const srcTab = this.getTab(resolved.tabId);
    if (!srcTab) {
      throw new Error(`Invalid tab id ${resolved.tabId}`);
    }

    let builder: MuxWindowBuilder | null = null;
    let finalWindowId: WindowId;
    let size: TerminalSize;

    if (windowId !== null) {
      const window = this.getWindowMut(windowId);
      if (!window) {
        throw new Error(`window_id ${windowId} not found on this server`);
      }
      const tab = window.getActive();
      if (!tab) {
        throw new Error(`window ${windowId} has no tabs`);
      }
      size = tab.getSize();
      finalWindowId = windowId;
    } else {
      builder = this.newEmptyWindow(workspaceForNewWindow || undefined);
      finalWindowId = builder.getWindowId();
      size = srcTab.getSize();
    }

    const pane = srcTab.removePane(paneId);
    if (!pane) {
      throw new Error(`pane ${paneId} was not in its containing tab`);
    }

    const tab = new Tab(size);
    tab.assignPane(pane);
    pane.resize(size);
    this.addTabAndActivePane(tab);
    this.addTabToWindow(tab, finalWindowId);

    if (srcTab.isDead()) {
      this.removeTab(srcTab.getTabId());
    }

    if (builder) {
      builder.dispose();
    }

    return { tab, windowId: finalWindowId };
  }
}

// Export singleton access
export function getMux(): Mux {
  return Mux.get();
}

export function tryGetMux(): Mux | null {
  return Mux.tryGet();
}
