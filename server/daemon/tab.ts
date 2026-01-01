/**
 * Tab - TypeScript translation of WezTerm's mux/src/tab.rs (Tab class portion)
 *
 * This file contains the Tab class implementation for managing panes within a tab.
 */

import type { Pane, PaneId } from './pane';
import { CloseReason, CachePolicy } from './pane';
import { TerminalSize } from './renderable';
import type { WindowId } from './window';
import { MuxNotification } from './window';
import type { DomainId } from './domain';
import {
  TabId,
  allocateTabId,
  SplitDirection,
  SplitDirectionAndSize,
  SplitRequest,
  SplitSize,
  PositionedPane,
  PositionedSplit,
  PaneDirection,
  PaneNode,
  PaneEntry,
  TabPaneRef,
  defaultSplitRequest,
  splitDirectionAndSizeTopOfSecond,
  splitDirectionAndSizeLeftOfSecond,
  splitDirectionAndSizeWidth,
  splitDirectionAndSizeHeight,
} from './tab-types';
import {
  Tree,
  Cursor,
  PathBranch,
  createEmptyTree,
  createLeafTree,
  treeNumLeaves,
  buildPaneTree,
  buildFromPaneTree,
  computeMinSize,
  adjustXSize,
  adjustYSize,
  applySizesFromSplits,
  cellDimensions,
  intersectsRange,
  isPaneSame,
} from './tab-tree';

// Forward declaration for Mux (will be implemented in mux.ts)
interface MuxInterface {
  get(): MuxInterface;
  tryGet(): MuxInterface | null;
  notify(notification: MuxNotification): void;
  windowContainingTab(tabId: TabId): WindowId | null;
  getWindow(windowId: WindowId): { getWorkspace(): string } | null;
  getPane(paneId: PaneId): TabPaneRef | null;
  removePane(paneId: PaneId): void;
}

// Placeholder - will be replaced with actual Mux singleton
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

function tryGetMux(): MuxInterface | null {
  return muxInstance;
}

// Configuration placeholder
function getConfiguration(): { unzoomOnSwitchPane: boolean } {
  return { unzoomOnSwitchPane: true };
}

/**
 * Recency tracker for pane activation order
 */
class Recency {
  private count = 0;
  private byIdx = new Map<number, number>();

  tag(idx: number): void {
    this.byIdx.set(idx, this.count);
    this.count++;
  }

  score(idx: number): number {
    return this.byIdx.get(idx) ?? 0;
  }
}

/**
 * Tab is a container of Panes arranged in a binary tree structure
 */
export class Tab {
  private readonly _tabId: TabId;
  private pane: Tree | null;
  private size: TerminalSize;
  private sizeBeforeZoom: TerminalSize;
  private active = 0;
  private zoomed: TabPaneRef | null = null;
  private title = '';
  private recency = new Recency();

  constructor(size: TerminalSize) {
    this._tabId = allocateTabId();
    this.pane = createEmptyTree();
    this.size = { ...size };
    this.sizeBeforeZoom = { ...size };
  }

  getTabId(): TabId {
    return this._tabId;
  }

  /** Alias for getTabId() for compatibility */
  tabId(): TabId {
    return this._tabId;
  }

  getTitle(): string {
    return this.title;
  }

  setTitle(title: string): void {
    if (this.title !== title) {
      this.title = title;
      const mux = tryGetMux();
      if (mux) {
        mux.notify({ type: 'TabTitleChanged', tabId: this._tabId, title });
      }
    }
  }

  /**
   * Sync with pane tree from remote
   */
  syncWithPaneTree(size: TerminalSize, root: PaneNode, makePane: (entry: PaneEntry) => TabPaneRef): void {
    const { tree, active, zoomed } = buildFromPaneTree(root, makePane as (entry: PaneEntry) => Pane);
    const cursor = new Cursor(tree);

    this.active = 0;
    if (active) {
      // Resolve active pane to its index
      let index = 0;
      const tempCursor = new Cursor(tree);
      while (true) {
        const leaf = tempCursor.leafMut();
        if (leaf) {
          if (active.paneId() === leaf.paneId()) {
            this.active = index;
            this.recency.tag(index);
            break;
          }
          index++;
        }
        if (!tempCursor.preorderNext()) break;
      }
    }

    this.pane = cursor.tree();
    this.zoomed = zoomed;
    this.size = size;
    this.resize(size);
  }

  /**
   * Get codec pane tree for serialization
   */
  codecPaneTree(): PaneNode {
    const mux = getMux();
    const windowId = mux.windowContainingTab(this._tabId);
    if (windowId === null) {
      console.error(`no window contains tab ${this._tabId}`);
      return { type: 'empty' };
    }

    const window = mux.getWindow(windowId);
    if (!window) {
      console.error(`window id ${windowId} doesn't have a window!?`);
      return { type: 'empty' };
    }

    const workspace = window.getWorkspace();
    const active = this.getActivePane();
    const zoomed = this.zoomed;

    if (this.pane) {
      return buildPaneTree(this.pane, this._tabId, windowId, active, zoomed, workspace, 0, 0);
    }
    return { type: 'empty' };
  }

  /**
   * Returns count of panes in this tab
   */
  countPanes(): number {
    if (!this.pane) return 0;
    return treeNumLeaves(this.pane);
  }

  /**
   * Sets zoom state, returns prior state
   */
  setZoomed(zoomed: boolean): boolean {
    if ((this.zoomed !== null) === zoomed) {
      return zoomed;
    }
    this.toggleZoom();
    return !zoomed;
  }

  toggleZoom(): void {
    const size = this.size;
    if (this.zoomed) {
      // Was zoomed, now unzoom
      const pane = this.getActivePane();
      if (pane) {
        pane.setZoomed(false);
      }
      this.zoomed = null;
      this.size = this.sizeBeforeZoom;
      this.resize(size);
    } else {
      // Wasn't zoomed, now zoom
      this.sizeBeforeZoom = size;
      const pane = this.getActivePane();
      if (pane) {
        pane.setZoomed(true);
        pane.resize(size);
        this.zoomed = pane;
      }
    }
    const mux = tryGetMux();
    if (mux) {
      mux.notify({ type: 'TabResized', tabId: this._tabId });
    }
  }

  containsPane(paneId: PaneId): boolean {
    function contains(tree: Tree, id: PaneId): boolean {
      switch (tree.type) {
        case 'empty':
          return false;
        case 'leaf':
          return tree.pane.paneId() === id;
        case 'node':
          return contains(tree.left, id) || contains(tree.right, id);
      }
    }
    return this.pane ? contains(this.pane, paneId) : false;
  }

  /**
   * Get positioned panes (respects zoom state)
   */
  iterPanes(): PositionedPane[] {
    return this.iterPanesImpl(true);
  }

  /**
   * Get positioned panes (ignores zoom state)
   */
  iterPanesIgnoringZoom(): PositionedPane[] {
    return this.iterPanesImpl(false);
  }

  private iterPanesImpl(respectZoomState: boolean): PositionedPane[] {
    const panes: PositionedPane[] = [];

    if (respectZoomState && this.zoomed) {
      const size = this.size;
      panes.push({
        index: 0,
        isActive: true,
        isZoomed: true,
        left: 0,
        top: 0,
        width: size.cols,
        pixelWidth: size.pixelWidth,
        height: size.rows,
        pixelHeight: size.pixelHeight,
        pane: this.zoomed,
      });
      return panes;
    }

    if (!this.pane) return panes;

    const activeIdx = this.active;
    const zoomedId = this.zoomed?.paneId();
    const rootSize = this.size;

    const traverse = (tree: Tree, path: Array<{ branch: PathBranch; data: SplitDirectionAndSize | null }>): void => {
      switch (tree.type) {
        case 'empty':
          return;

        case 'leaf': {
          const index = panes.length;
          let left = 0;
          let top = 0;
          let parentSize: TerminalSize | null = null;

          for (let i = path.length - 1; i >= 0; i--) {
            const { branch, data } = path[i];
            if (data) {
              if (!parentSize) {
                parentSize = branch === PathBranch.IsRight ? data.second : data.first;
              }
              if (branch === PathBranch.IsRight) {
                top += splitDirectionAndSizeTopOfSecond(data);
                left += splitDirectionAndSizeLeftOfSecond(data);
              }
            }
          }

          const dims = parentSize ?? rootSize;
          panes.push({
            index,
            isActive: index === activeIdx,
            isZoomed: zoomedId === tree.pane.paneId(),
            left,
            top,
            width: dims.cols,
            height: dims.rows,
            pixelWidth: dims.pixelWidth,
            pixelHeight: dims.pixelHeight,
            pane: tree.pane,
          });
          return;
        }

        case 'node': {
          traverse(tree.left, [...path, { branch: PathBranch.IsLeft, data: tree.data }]);
          traverse(tree.right, [...path, { branch: PathBranch.IsRight, data: tree.data }]);
          return;
        }
      }
    };

    traverse(this.pane, []);
    return panes;
  }

  rotateCounterClockwise(): void {
    const panes = this.iterPanesIgnoringZoom();
    if (panes.length === 0) return;

    let paneToSwap = panes[0].pane;
    // Implementation would require mutable tree traversal
    // Simplified for now
    const mux = tryGetMux();
    if (mux) {
      mux.notify({ type: 'TabResized', tabId: this._tabId });
    }
  }

  rotateClockwise(): void {
    const panes = this.iterPanesIgnoringZoom();
    if (panes.length === 0) return;

    // Implementation would require mutable tree traversal
    const mux = tryGetMux();
    if (mux) {
      mux.notify({ type: 'TabResized', tabId: this._tabId });
    }
  }

  /**
   * Get positioned splits (dividers between panes)
   */
  iterSplits(): PositionedSplit[] {
    const dividers: PositionedSplit[] = [];
    if (this.zoomed || !this.pane) return dividers;

    let index = 0;

    const traverse = (
      tree: Tree,
      path: Array<{ branch: PathBranch; data: SplitDirectionAndSize | null }>
    ): void => {
      switch (tree.type) {
        case 'empty':
        case 'leaf':
          return;

        case 'node': {
          let left = 0;
          let top = 0;

          for (let i = path.length - 1; i >= 0; i--) {
            const { branch, data } = path[i];
            if (data && branch === PathBranch.IsRight) {
              left += splitDirectionAndSizeLeftOfSecond(data);
              top += splitDirectionAndSizeTopOfSecond(data);
            }
          }

          if (tree.data) {
            if (tree.data.direction === SplitDirection.Horizontal) {
              left += tree.data.first.cols;
            } else {
              top += tree.data.first.rows;
            }

            dividers.push({
              index,
              direction: tree.data.direction,
              left,
              top,
              size:
                tree.data.direction === SplitDirection.Horizontal
                  ? splitDirectionAndSizeHeight(tree.data)
                  : splitDirectionAndSizeWidth(tree.data),
            });
          }
          index++;

          traverse(tree.left, [...path, { branch: PathBranch.IsLeft, data: tree.data }]);
          traverse(tree.right, [...path, { branch: PathBranch.IsRight, data: tree.data }]);
          return;
        }
      }
    };

    traverse(this.pane, []);
    return dividers;
  }

  getSize(): TerminalSize {
    return { ...this.size };
  }

  /**
   * Resize the tab and all contained panes
   */
  resize(size: TerminalSize): void {
    if (size.rows === 0 || size.cols === 0) return;

    if (this.zoomed) {
      this.size = size;
      this.zoomed.resize(size);
    } else if (this.pane) {
      const dims = cellDimensions(size);
      const { minX, minY } = computeMinSize(this.pane);
      const currentSize = this.size;

      const cols = Math.max(size.cols, minX);
      const rows = Math.max(size.rows, minY);
      const newSize: TerminalSize = {
        rows,
        cols,
        pixelWidth: cols * dims.pixelWidth,
        pixelHeight: rows * dims.pixelHeight,
        dpi: dims.dpi,
      };

      this.pane = adjustXSize(this.pane, cols - currentSize.cols, dims);
      this.pane = adjustYSize(this.pane, rows - currentSize.rows, dims);
      this.size = newSize;
      applySizesFromSplits(this.pane, newSize);
    }

    const mux = tryGetMux();
    if (mux) {
      mux.notify({ type: 'TabResized', tabId: this._tabId });
    }
  }

  rebuildSplitsSizesFromContainedPanes(): void {
    if (this.zoomed || !this.pane) return;

    function computeSize(tree: Tree): TerminalSize | null {
      switch (tree.type) {
        case 'empty':
          return null;
        case 'leaf': {
          const dims = tree.pane.getDimensions();
          return {
            cols: dims.cols,
            rows: dims.viewportRows,
            pixelHeight: dims.pixelHeight,
            pixelWidth: dims.pixelWidth,
            dpi: dims.dpi,
          };
        }
        case 'node': {
          if (!tree.data) return null;
          // Note: This would need mutable tree to update data
          return null;
        }
      }
    }

    const mux = tryGetMux();
    if (mux) {
      mux.notify({ type: 'TabResized', tabId: this._tabId });
    }
  }

  resizeSplitBy(splitIndex: number, delta: number): void {
    if (this.zoomed || !this.pane) return;
    // Implementation requires mutable cursor navigation
    const mux = tryGetMux();
    if (mux) {
      mux.notify({ type: 'TabResized', tabId: this._tabId });
    }
  }

  adjustPaneSize(direction: PaneDirection, amount: number): void {
    if (this.zoomed) return;
    // Implementation requires cursor navigation to active pane
  }

  activatePaneDirection(direction: PaneDirection): void {
    if (this.zoomed) {
      if (!getConfiguration().unzoomOnSwitchPane) return;
      this.toggleZoom();
    }

    const panelIdx = this.getPaneDirection(direction, false);
    if (panelIdx !== null) {
      this.setActiveIdx(panelIdx);
    }

    const mux = getMux();
    const windowId = mux.windowContainingTab(this._tabId);
    if (windowId !== null) {
      mux.notify({ type: 'WindowInvalidated', windowId });
    }
  }

  getPaneDirection(direction: PaneDirection, ignoreZoom: boolean): number | null {
    const panes = ignoreZoom ? this.iterPanesIgnoringZoom() : this.iterPanes();
    const active = panes.find((p) => p.isActive);
    if (!active) return 0;

    if (direction === PaneDirection.Next || direction === PaneDirection.Prev) {
      const maxPaneId = Math.max(...panes.map((p) => p.index));
      if (direction === PaneDirection.Next) {
        return active.index === maxPaneId ? 0 : active.index + 1;
      } else {
        return active.index === 0 ? maxPaneId : active.index - 1;
      }
    }

    let best: { score: number; pane: PositionedPane } | null = null;

    for (const pane of panes) {
      let score = 0;

      const edgeIntersects = (
        activeStart: number,
        activeSize: number,
        currentStart: number,
        currentSize: number
      ): boolean => {
        return intersectsRange(
          { start: activeStart, end: activeStart + activeSize },
          { start: currentStart, end: currentStart + currentSize }
        );
      };

      switch (direction) {
        case PaneDirection.Right:
          if (
            pane.left === active.left + active.width + 1 &&
            edgeIntersects(active.top, active.height, pane.top, pane.height)
          ) {
            score = 1 + this.recency.score(pane.index);
          }
          break;
        case PaneDirection.Left:
          if (
            pane.left + pane.width + 1 === active.left &&
            edgeIntersects(active.top, active.height, pane.top, pane.height)
          ) {
            score = 1 + this.recency.score(pane.index);
          }
          break;
        case PaneDirection.Up:
          if (
            pane.top + pane.height + 1 === active.top &&
            edgeIntersects(active.left, active.width, pane.left, pane.width)
          ) {
            score = 1 + this.recency.score(pane.index);
          }
          break;
        case PaneDirection.Down:
          if (
            active.top + active.height + 1 === pane.top &&
            edgeIntersects(active.left, active.width, pane.left, pane.width)
          ) {
            score = 1 + this.recency.score(pane.index);
          }
          break;
      }

      if (score > 0) {
        if (!best || score > best.score) {
          best = { score, pane };
        }
      }
    }

    return best?.pane.index ?? null;
  }

  pruneDeadPanes(): boolean {
    const mux = getMux();
    const removed = this.removePaneIf(
      (_, pane) => {
        const inMux = mux.getPane(pane.paneId()) !== null;
        const dead = pane.isDead();
        return dead || !inMux;
      },
      true
    );
    return removed.length > 0;
  }

  killPane(paneId: PaneId): boolean {
    const removed = this.removePaneIf((_, pane) => pane.paneId() === paneId, true);
    return removed.length > 0;
  }

  killPanesInDomain(domain: DomainId): boolean {
    const removed = this.removePaneIf((_, pane) => pane.domainId() === domain, true);
    return removed.length > 0;
  }

  removePane(paneId: PaneId): TabPaneRef | null {
    const panes = this.removePaneIf((_, pane) => pane.paneId() === paneId, false);
    return panes[0] ?? null;
  }

  private removePaneIf(
    predicate: (index: number, pane: TabPaneRef) => boolean,
    kill: boolean
  ): TabPaneRef[] {
    const deadPanes: TabPaneRef[] = [];
    // Implementation requires mutable tree traversal
    // Simplified for now
    return deadPanes;
  }

  canCloseWithoutPrompting(reason: CloseReason): boolean {
    const panes = this.iterPanesIgnoringZoom();
    for (const pos of panes) {
      if (pos.pane.canCloseWithoutPrompting && !pos.pane.canCloseWithoutPrompting(reason)) {
        return false;
      }
    }
    return true;
  }

  isDead(): boolean {
    const panes = this.iterPanesIgnoringZoom();
    let deadCount = 0;
    for (const pos of panes) {
      if (pos.pane.isDead()) {
        deadCount++;
      }
    }
    return deadCount === panes.length;
  }

  getActivePane(): TabPaneRef | null {
    if (this.zoomed) return this.zoomed;
    const panes = this.iterPanesIgnoringZoom();
    return panes[this.active]?.pane ?? null;
  }

  getActiveIdx(): number {
    return this.active;
  }

  setActivePane(pane: TabPaneRef): void {
    const prior = this.getActivePane();
    if (isPaneSame(pane, prior)) return;

    if (this.zoomed) {
      if (!getConfiguration().unzoomOnSwitchPane) return;
      this.toggleZoom();
    }

    const panes = this.iterPanesIgnoringZoom();
    const item = panes.find((p) => p.pane.paneId() === pane.paneId());
    if (item) {
      this.active = item.index;
      this.recency.tag(item.index);
      this.adviseFocusChange(prior);
    }
  }

  private adviseFocusChange(prior: TabPaneRef | null): void {
    const mux = getMux();
    const current = this.getActivePane();

    if (prior && current && prior.paneId() !== current.paneId()) {
      prior.focusChanged(false);
      current.focusChanged(true);
      mux.notify({ type: 'PaneFocused', paneId: current.paneId() });
    } else if (!prior && current) {
      current.focusChanged(true);
      mux.notify({ type: 'PaneFocused', paneId: current.paneId() });
    } else if (prior && !current) {
      prior.focusChanged(false);
    }
  }

  setActiveIdx(paneIndex: number): void {
    const prior = this.getActivePane();
    this.active = paneIndex;
    this.recency.tag(paneIndex);
    this.adviseFocusChange(prior);
  }

  /**
   * Assign root pane (for new tabs)
   */
  assignPane(pane: TabPaneRef): void {
    this.pane = createLeafTree(pane as unknown as Pane);
  }

  swapActiveWithIndex(paneIndex: number, keepFocus: boolean): boolean {
    // Implementation requires mutable cursor navigation
    return false;
  }

  /**
   * Compute split size for a potential split
   */
  computeSplitSize(paneIndex: number, request: SplitRequest): SplitDirectionAndSize | null {
    const cellDims = cellDimensions(this.size);

    const splitDimension = (dim: number, req: SplitRequest): [number, number] => {
      let targetSize: number;
      if (req.size.type === 'cells') {
        targetSize = req.size.value;
      } else {
        targetSize = Math.floor((dim * req.size.value) / 100);
      }
      targetSize = Math.max(1, targetSize);

      const remain = Math.max(0, dim - targetSize - 1);
      return req.targetIsSecond ? [remain, targetSize] : [targetSize, remain];
    };

    if (request.topLevel) {
      const size = this.size;
      let width1: number, width2: number, height1: number, height2: number;

      if (request.direction === SplitDirection.Horizontal) {
        [width1, width2] = splitDimension(size.cols, request);
        height1 = height2 = size.rows;
      } else {
        width1 = width2 = size.cols;
        [height1, height2] = splitDimension(size.rows, request);
      }

      return {
        direction: request.direction,
        first: {
          rows: height1,
          cols: width1,
          pixelHeight: cellDims.pixelHeight * height1,
          pixelWidth: cellDims.pixelWidth * width1,
          dpi: cellDims.dpi,
        },
        second: {
          rows: height2,
          cols: width2,
          pixelHeight: cellDims.pixelHeight * height2,
          pixelWidth: cellDims.pixelWidth * width2,
          dpi: cellDims.dpi,
        },
      };
    }

    this.setZoomed(false);

    const panes = this.iterPanes();
    const pos = panes[paneIndex];
    if (!pos) return null;

    let width1: number, width2: number, height1: number, height2: number;

    if (request.direction === SplitDirection.Horizontal) {
      [width1, width2] = splitDimension(pos.width, request);
      height1 = height2 = pos.height;
    } else {
      width1 = width2 = pos.width;
      [height1, height2] = splitDimension(pos.height, request);
    }

    return {
      direction: request.direction,
      first: {
        rows: height1,
        cols: width1,
        pixelHeight: cellDims.pixelHeight * height1,
        pixelWidth: cellDims.pixelWidth * width1,
        dpi: cellDims.dpi,
      },
      second: {
        rows: height2,
        cols: width2,
        pixelHeight: cellDims.pixelHeight * height2,
        pixelWidth: cellDims.pixelWidth * width2,
        dpi: cellDims.dpi,
      },
    };
  }

  /**
   * Split pane and insert new pane
   */
  splitAndInsert(paneIndex: number, request: SplitRequest, pane: TabPaneRef): number {
    if (this.zoomed) {
      throw new Error('cannot split while zoomed');
    }

    const splitInfo = this.computeSplitSize(paneIndex, request);
    if (!splitInfo) {
      throw new Error(`invalid pane_index ${paneIndex}; cannot split!`);
    }

    // Validate split has space
    const tabSize = this.size;
    if (
      splitInfo.first.rows === 0 ||
      splitInfo.first.cols === 0 ||
      splitInfo.second.rows === 0 ||
      splitInfo.second.cols === 0 ||
      splitDirectionAndSizeTopOfSecond(splitInfo) + splitInfo.second.rows > tabSize.rows ||
      splitDirectionAndSizeLeftOfSecond(splitInfo) + splitInfo.second.cols > tabSize.cols
    ) {
      throw new Error('No space for split!');
    }

    // Implementation requires mutable cursor navigation
    // Simplified: just update active index
    if (request.targetIsSecond) {
      this.active = paneIndex + 1;
      this.recency.tag(paneIndex + 1);
      return paneIndex + 1;
    }
    return paneIndex;
  }

  getZoomedPane(): TabPaneRef | null {
    return this.zoomed;
  }
}

// Re-export types
export {
  TabId,
  SplitDirection,
  SplitDirectionAndSize,
  SplitRequest,
  SplitSize,
  PositionedPane,
  PositionedSplit,
  PaneDirection,
  PaneNode,
  PaneEntry,
} from './tab-types';
