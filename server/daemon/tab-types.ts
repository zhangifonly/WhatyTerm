/**
 * Tab types - TypeScript translation of WezTerm's mux/src/tab.rs (types portion)
 *
 * This file contains type definitions for tab management including:
 * - Split direction and size types
 * - Positioned pane and split interfaces
 * - Pane node serialization types
 */

import { TerminalSize, StableCursorPosition, StableRowIndex } from './renderable';

// Re-define ID types locally to avoid circular dependencies
// These are simple type aliases that match the definitions in their respective modules
export type WindowId = number;
export type PaneId = number;
export type DomainId = number;

/**
 * Pane reference type for tab-types
 * Using 'any' to avoid circular dependency with pane.ts
 * The actual Pane interface is in pane.ts
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TabPaneRef = any;

// Tab ID type and allocation
export type TabId = number;

let nextTabId = 0;
export function allocateTabId(): TabId {
  return nextTabId++;
}

/**
 * Split direction for pane splits
 */
export enum SplitDirection {
  Horizontal = 'horizontal',
  Vertical = 'vertical',
}

/**
 * Split size specification
 */
export type SplitSize =
  | { type: 'cells'; value: number }
  | { type: 'percent'; value: number };

export function defaultSplitSize(): SplitSize {
  return { type: 'percent', value: 50 };
}

/**
 * Split request parameters
 */
export interface SplitRequest {
  direction: SplitDirection;
  /** Whether the newly created item will be in the second part of the split (right/bottom) */
  targetIsSecond: boolean;
  /** Split across the top of the tab rather than the active pane */
  topLevel: boolean;
  /** The size of the new item */
  size: SplitSize;
}

export function defaultSplitRequest(): SplitRequest {
  return {
    direction: SplitDirection.Horizontal,
    targetIsSecond: true,
    topLevel: false,
    size: defaultSplitSize(),
  };
}

/**
 * The size is of the (first, second) child of the split
 */
export interface SplitDirectionAndSize {
  direction: SplitDirection;
  first: TerminalSize;
  second: TerminalSize;
}

export function splitDirectionAndSizeTopOfSecond(data: SplitDirectionAndSize): number {
  if (data.direction === SplitDirection.Horizontal) {
    return 0;
  }
  return data.first.rows + 1;
}

export function splitDirectionAndSizeLeftOfSecond(data: SplitDirectionAndSize): number {
  if (data.direction === SplitDirection.Horizontal) {
    return data.first.cols + 1;
  }
  return 0;
}

export function splitDirectionAndSizeWidth(data: SplitDirectionAndSize): number {
  if (data.direction === SplitDirection.Horizontal) {
    return data.first.cols + data.second.cols + 1;
  }
  return data.first.cols;
}

export function splitDirectionAndSizeHeight(data: SplitDirectionAndSize): number {
  if (data.direction === SplitDirection.Vertical) {
    return data.first.rows + data.second.rows + 1;
  }
  return data.first.rows;
}

export function splitDirectionAndSizeSize(data: SplitDirectionAndSize): TerminalSize {
  const cellWidth = Math.floor(data.first.pixelWidth / data.first.cols) || 1;
  const cellHeight = Math.floor(data.first.pixelHeight / data.first.rows) || 1;

  const rows = splitDirectionAndSizeHeight(data);
  const cols = splitDirectionAndSizeWidth(data);

  return {
    rows,
    cols,
    pixelHeight: cellHeight * rows,
    pixelWidth: cellWidth * cols,
    dpi: data.first.dpi,
  };
}

/**
 * Positioned pane with layout information
 */
export interface PositionedPane {
  /** The topological pane index that can be used to reference this pane */
  index: number;
  /** true if this is the active pane at the time the position was computed */
  isActive: boolean;
  /** true if this pane is zoomed */
  isZoomed: boolean;
  /** The offset from the top left corner of the containing tab to the top left corner of this pane, in cells */
  left: number;
  /** The offset from the top left corner of the containing tab to the top left corner of this pane, in cells */
  top: number;
  /** The width of this pane in cells */
  width: number;
  pixelWidth: number;
  /** The height of this pane in cells */
  height: number;
  pixelHeight: number;
  /** The pane instance */
  pane: TabPaneRef;
}

/**
 * Positioned split divider with layout information
 */
export interface PositionedSplit {
  /** The topological node index that can be used to reference this split */
  index: number;
  direction: SplitDirection;
  /** The offset from the top left corner of the containing tab to the top left corner of this split, in cells */
  left: number;
  /** The offset from the top left corner of the containing tab to the top left corner of this split, in cells */
  top: number;
  /** For Horizontal splits, how tall the split should be, for Vertical splits how wide it should be */
  size: number;
}

/**
 * Pane direction for navigation
 */
export enum PaneDirection {
  Up = 'up',
  Down = 'down',
  Left = 'left',
  Right = 'right',
  Next = 'next',
  Prev = 'prev',
}

/**
 * URL wrapper for serialization
 */
export interface SerdeUrl {
  url: string;
}

/**
 * Pane entry for serialization - used by codec
 */
export interface PaneEntry {
  windowId: WindowId;
  tabId: TabId;
  paneId: PaneId;
  title: string;
  size: TerminalSize;
  workingDir: SerdeUrl | null;
  isActivePane: boolean;
  isZoomedPane: boolean;
  workspace: string;
  cursorPos: StableCursorPosition;
  physicalTop: StableRowIndex;
  topRow: number;
  leftCol: number;
  ttyName: string | null;
}

/**
 * Pane node for tree serialization - used by codec
 */
export type PaneNode =
  | { type: 'empty' }
  | { type: 'split'; left: PaneNode; right: PaneNode; node: SplitDirectionAndSize }
  | { type: 'leaf'; entry: PaneEntry };

export function paneNodeRootSize(node: PaneNode): TerminalSize | null {
  switch (node.type) {
    case 'empty':
      return null;
    case 'split':
      return splitDirectionAndSizeSize(node.node);
    case 'leaf':
      return node.entry.size;
  }
}

export function paneNodeWindowAndTabIds(node: PaneNode): { windowId: WindowId; tabId: TabId } | null {
  switch (node.type) {
    case 'empty':
      return null;
    case 'split': {
      const leftResult = paneNodeWindowAndTabIds(node.left);
      if (leftResult) return leftResult;
      return paneNodeWindowAndTabIds(node.right);
    }
    case 'leaf':
      return { windowId: node.entry.windowId, tabId: node.entry.tabId };
  }
}
