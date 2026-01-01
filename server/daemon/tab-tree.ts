/**
 * Tab tree - TypeScript translation of WezTerm's mux/src/tab.rs (tree portion)
 *
 * This file contains the binary tree implementation for pane layout management:
 * - Tree and Cursor types
 * - Tree traversal and manipulation functions
 * - Size adjustment algorithms
 */

import type { Pane, PaneId } from './pane';
import { CachePolicy } from './pane';
import { TerminalSize } from './renderable';
import type { WindowId } from './window';
import {
  TabId,
  SplitDirection,
  SplitDirectionAndSize,
  PaneNode,
  PaneEntry,
  splitDirectionAndSizeTopOfSecond,
  splitDirectionAndSizeLeftOfSecond,
  splitDirectionAndSizeWidth,
  splitDirectionAndSizeHeight,
} from './tab-types';

/**
 * Path branch indicator for tree traversal
 */
export enum PathBranch {
  IsLeft = 'left',
  IsRight = 'right',
}

/**
 * Binary tree node for pane layout
 */
export type Tree =
  | { type: 'empty' }
  | { type: 'leaf'; pane: Pane }
  | { type: 'node'; left: Tree; right: Tree; data: SplitDirectionAndSize | null };

export function createEmptyTree(): Tree {
  return { type: 'empty' };
}

export function createLeafTree(pane: Pane): Tree {
  return { type: 'leaf', pane };
}

export function createNodeTree(
  left: Tree,
  right: Tree,
  data: SplitDirectionAndSize | null
): Tree {
  return { type: 'node', left, right, data };
}

/**
 * Count the number of leaves in a tree
 */
export function treeNumLeaves(tree: Tree): number {
  switch (tree.type) {
    case 'empty':
      return 0;
    case 'leaf':
      return 1;
    case 'node':
      return treeNumLeaves(tree.left) + treeNumLeaves(tree.right);
  }
}

/**
 * Cursor for navigating and modifying the tree
 */
export class Cursor {
  private path: Array<{ branch: PathBranch; sibling: Tree; data: SplitDirectionAndSize | null }> = [];
  private current: Tree;

  constructor(tree: Tree) {
    this.current = tree;
  }

  /**
   * Get the current tree
   */
  tree(): Tree {
    // Reconstruct tree from path
    let result = this.current;
    for (let i = this.path.length - 1; i >= 0; i--) {
      const { branch, sibling, data } = this.path[i];
      if (branch === PathBranch.IsLeft) {
        result = createNodeTree(result, sibling, data);
      } else {
        result = createNodeTree(sibling, result, data);
      }
    }
    return result;
  }

  /**
   * Check if cursor is at the top of the tree
   */
  isTop(): boolean {
    return this.path.length === 0;
  }

  /**
   * Check if cursor is at a leaf node
   */
  isLeaf(): boolean {
    return this.current.type === 'leaf';
  }

  /**
   * Get mutable reference to leaf pane
   */
  leafMut(): Pane | null {
    if (this.current.type === 'leaf') {
      return this.current.pane;
    }
    return null;
  }

  /**
   * Set the leaf pane
   */
  setLeaf(pane: Pane): void {
    if (this.current.type === 'leaf') {
      this.current = createLeafTree(pane);
    }
  }

  /**
   * Get mutable reference to node data
   */
  nodeMut(): SplitDirectionAndSize | null {
    if (this.current.type === 'node') {
      return this.current.data;
    }
    return null;
  }

  /**
   * Set the node data
   */
  setNodeData(data: SplitDirectionAndSize | null): void {
    if (this.current.type === 'node') {
      this.current = createNodeTree(this.current.left, this.current.right, data);
    }
  }

  /**
   * Assign node data
   */
  assignNode(data: SplitDirectionAndSize | null): Cursor {
    this.setNodeData(data);
    return this;
  }

  /**
   * Assign a pane to the top of an empty tree
   */
  assignTop(pane: Pane): Cursor {
    if (this.current.type === 'empty' && this.isTop()) {
      this.current = createLeafTree(pane);
      return this;
    }
    throw new Error('Cannot assign top to non-empty tree');
  }

  /**
   * Get path to root with node data
   */
  *pathToRoot(): Generator<[PathBranch, SplitDirectionAndSize | null]> {
    for (let i = this.path.length - 1; i >= 0; i--) {
      yield [this.path[i].branch, this.path[i].data];
    }
  }

  /**
   * Move to left child
   */
  goLeft(): Cursor | null {
    if (this.current.type === 'node') {
      this.path.push({
        branch: PathBranch.IsLeft,
        sibling: this.current.right,
        data: this.current.data,
      });
      this.current = this.current.left;
      return this;
    }
    return null;
  }

  /**
   * Move to right child
   */
  goRight(): Cursor | null {
    if (this.current.type === 'node') {
      this.path.push({
        branch: PathBranch.IsRight,
        sibling: this.current.left,
        data: this.current.data,
      });
      this.current = this.current.right;
      return this;
    }
    return null;
  }

  /**
   * Move up to parent
   */
  goUp(): Cursor | null {
    if (this.path.length === 0) {
      return null;
    }
    const { branch, sibling, data } = this.path.pop()!;
    if (branch === PathBranch.IsLeft) {
      this.current = createNodeTree(this.current, sibling, data);
    } else {
      this.current = createNodeTree(sibling, this.current, data);
    }
    return this;
  }

  /**
   * Preorder traversal to next node
   */
  preorderNext(): Cursor | null {
    // Try to go left first
    if (this.current.type === 'node') {
      const left = this.goLeft();
      if (left) return left;
    }

    // Try to go to right sibling or up
    while (this.path.length > 0) {
      const last = this.path[this.path.length - 1];
      if (last.branch === PathBranch.IsLeft) {
        // We came from left, go to right sibling
        this.path.pop();
        this.path.push({
          branch: PathBranch.IsRight,
          sibling: this.current,
          data: last.data,
        });
        this.current = last.sibling;
        return this;
      }
      // We came from right, go up
      this.goUp();
    }

    return null;
  }

  /**
   * Postorder traversal to next node
   */
  postorderNext(): Cursor | null {
    // If we're at root, we're done
    if (this.path.length === 0) {
      return null;
    }

    const last = this.path[this.path.length - 1];
    if (last.branch === PathBranch.IsLeft) {
      // Go to right sibling and descend to leftmost leaf
      this.path.pop();
      this.path.push({
        branch: PathBranch.IsRight,
        sibling: this.current,
        data: last.data,
      });
      this.current = last.sibling;

      // Descend to leftmost leaf
      while (this.current.type === 'node') {
        this.goLeft();
      }
      return this;
    }

    // We came from right, go up to parent
    this.goUp();
    return this;
  }

  /**
   * Go to nth leaf (0-indexed)
   */
  goToNthLeaf(n: number): Cursor | null {
    // Reset to root
    while (this.path.length > 0) {
      this.goUp();
    }

    let count = 0;
    const traverse = (): boolean => {
      if (this.current.type === 'leaf') {
        if (count === n) {
          return true;
        }
        count++;
        return false;
      }
      if (this.current.type === 'node') {
        if (this.goLeft()) {
          if (traverse()) return true;
          this.goUp();
          if (this.goRight()) {
            if (traverse()) return true;
            this.goUp();
          }
        }
      }
      return false;
    };

    // Start traversal
    if (this.current.type === 'leaf') {
      if (n === 0) return this;
      return null;
    }
    if (this.current.type === 'node') {
      if (this.goLeft()) {
        if (traverse()) return this;
        this.goUp();
        if (this.goRight()) {
          if (traverse()) return this;
        }
      }
    }
    return null;
  }

  /**
   * Split leaf and insert pane to the right
   */
  splitLeafAndInsertRight(pane: Pane): Cursor {
    if (this.current.type !== 'leaf') {
      throw new Error('Cannot split non-leaf');
    }
    const existingPane = this.current.pane;
    this.current = createNodeTree(
      createLeafTree(existingPane),
      createLeafTree(pane),
      null
    );
    return this;
  }

  /**
   * Split node and insert pane to the right
   */
  splitNodeAndInsertRight(pane: Pane): Cursor {
    if (this.current.type !== 'node') {
      throw new Error('Cannot split non-node');
    }
    this.current = createNodeTree(
      this.current,
      createLeafTree(pane),
      null
    );
    return this;
  }

  /**
   * Split node and insert pane to the left
   */
  splitNodeAndInsertLeft(pane: Pane): Cursor {
    if (this.current.type !== 'node') {
      throw new Error('Cannot split non-node');
    }
    this.current = createNodeTree(
      createLeafTree(pane),
      this.current,
      null
    );
    return this;
  }

  /**
   * Unsplit a leaf, removing it and returning the sibling
   * Returns [cursor, removed pane, parent data]
   */
  unsplitLeaf(): { cursor: Cursor; removed: Pane; parentData: SplitDirectionAndSize | null } | null {
    if (this.current.type !== 'leaf' || this.path.length === 0) {
      return null;
    }

    const removed = this.current.pane;
    const { branch, sibling, data } = this.path.pop()!;
    this.current = sibling;

    return { cursor: this, removed, parentData: data };
  }
}

/**
 * Check if two panes are the same
 */
export function isPaneSame(pane: Pane, other: Pane | null): boolean {
  if (!other) return false;
  return pane.paneId() === other.paneId();
}

/**
 * Build PaneNode tree from Tree for serialization
 */
export function buildPaneTree(
  tree: Tree,
  tabId: TabId,
  windowId: WindowId,
  active: Pane | null,
  zoomed: Pane | null,
  workspace: string,
  leftCol: number,
  topRow: number
): PaneNode {
  switch (tree.type) {
    case 'empty':
      return { type: 'empty' };

    case 'node': {
      const data = tree.data;
      if (!data) {
        return { type: 'empty' };
      }
      return {
        type: 'split',
        left: buildPaneTree(tree.left, tabId, windowId, active, zoomed, workspace, leftCol, topRow),
        right: buildPaneTree(
          tree.right,
          tabId,
          windowId,
          active,
          zoomed,
          workspace,
          data.direction === SplitDirection.Vertical
            ? leftCol
            : leftCol + splitDirectionAndSizeLeftOfSecond(data),
          data.direction === SplitDirection.Horizontal
            ? topRow
            : topRow + splitDirectionAndSizeTopOfSecond(data)
        ),
        node: data,
      };
    }

    case 'leaf': {
      const pane = tree.pane;
      const dims = pane.getDimensions();
      const workingDir = pane.getCurrentWorkingDir(CachePolicy.AllowStale);
      const cursorPos = pane.getCursorPosition();

      return {
        type: 'leaf',
        entry: {
          windowId,
          tabId,
          paneId: pane.paneId(),
          title: pane.getTitle(),
          isActivePane: isPaneSame(pane, active),
          isZoomedPane: isPaneSame(pane, zoomed),
          size: {
            cols: dims.cols,
            rows: dims.viewportRows,
            pixelHeight: dims.pixelHeight,
            pixelWidth: dims.pixelWidth,
            dpi: dims.dpi,
          },
          workingDir: workingDir ? { url: workingDir } : null,
          workspace,
          cursorPos,
          physicalTop: dims.physicalTop,
          leftCol,
          topRow,
          ttyName: pane.ttyName(),
        },
      };
    }
  }
}

/**
 * Build Tree from PaneNode for deserialization
 */
export function buildFromPaneTree(
  node: PaneNode,
  makePane: (entry: PaneEntry) => Pane
): { tree: Tree; active: Pane | null; zoomed: Pane | null } {
  let active: Pane | null = null;
  let zoomed: Pane | null = null;

  function build(n: PaneNode): Tree {
    switch (n.type) {
      case 'empty':
        return createEmptyTree();

      case 'split':
        return createNodeTree(build(n.left), build(n.right), n.node);

      case 'leaf': {
        const pane = makePane(n.entry);
        if (n.entry.isZoomedPane) {
          zoomed = pane;
        }
        if (n.entry.isActivePane) {
          active = pane;
        }
        return createLeafTree(pane);
      }
    }
  }

  const tree = build(node);
  return { tree, active, zoomed };
}

/**
 * Compute minimum (x, y) size based on panes in tree
 */
export function computeMinSize(tree: Tree): { minX: number; minY: number } {
  switch (tree.type) {
    case 'empty':
      return { minX: 1, minY: 1 };

    case 'leaf':
      return { minX: 1, minY: 1 };

    case 'node': {
      if (!tree.data) {
        return { minX: 1, minY: 1 };
      }
      const leftMin = computeMinSize(tree.left);
      const rightMin = computeMinSize(tree.right);

      if (tree.data.direction === SplitDirection.Vertical) {
        return {
          minX: Math.max(leftMin.minX, rightMin.minX),
          minY: leftMin.minY + rightMin.minY + 1,
        };
      } else {
        return {
          minX: leftMin.minX + rightMin.minX + 1,
          minY: Math.max(leftMin.minY, rightMin.minY),
        };
      }
    }
  }
}

/**
 * Adjust X size of tree
 */
export function adjustXSize(tree: Tree, xAdjust: number, cellDimensions: TerminalSize): Tree {
  if (xAdjust === 0) return tree;

  switch (tree.type) {
    case 'empty':
    case 'leaf':
      return tree;

    case 'node': {
      if (!tree.data) return tree;

      const data = { ...tree.data };
      const { minX } = computeMinSize(tree);

      data.first = { ...data.first, dpi: cellDimensions.dpi };
      data.second = { ...data.second, dpi: cellDimensions.dpi };

      if (data.direction === SplitDirection.Vertical) {
        const newCols = Math.max(minX, data.first.cols + xAdjust);
        const actualAdjust = newCols - data.first.cols;

        if (actualAdjust !== 0) {
          const newLeft = adjustXSize(tree.left, actualAdjust, cellDimensions);
          data.first.cols = newCols;
          data.first.pixelWidth = data.first.cols * cellDimensions.pixelWidth;

          const newRight = adjustXSize(tree.right, actualAdjust, cellDimensions);
          data.second.cols = data.first.cols;
          data.second.pixelWidth = data.first.pixelWidth;

          return createNodeTree(newLeft, newRight, data);
        }
        return tree;
      } else {
        // Horizontal split - distribute adjustment between children
        let remaining = xAdjust;
        let newLeft = tree.left;
        let newRight = tree.right;

        if (xAdjust > 0) {
          newLeft = adjustXSize(tree.left, 1, cellDimensions);
          data.first.cols += 1;
          data.first.pixelWidth = data.first.cols * cellDimensions.pixelWidth;
          remaining -= 1;

          if (remaining > 0) {
            newRight = adjustXSize(tree.right, 1, cellDimensions);
            data.second.cols += 1;
            data.second.pixelWidth = data.second.cols * cellDimensions.pixelWidth;
            remaining -= 1;
          }
        } else {
          if (data.first.cols > 1) {
            newLeft = adjustXSize(tree.left, -1, cellDimensions);
            data.first.cols -= 1;
            data.first.pixelWidth = data.first.cols * cellDimensions.pixelWidth;
            remaining += 1;
          }
          if (remaining < 0 && data.second.cols > 1) {
            newRight = adjustXSize(tree.right, -1, cellDimensions);
            data.second.cols -= 1;
            data.second.pixelWidth = data.second.cols * cellDimensions.pixelWidth;
            remaining += 1;
          }
        }

        const result = createNodeTree(newLeft, newRight, data);
        if (remaining !== 0) {
          return adjustXSize(result, remaining, cellDimensions);
        }
        return result;
      }
    }
  }
}

/**
 * Adjust Y size of tree
 */
export function adjustYSize(tree: Tree, yAdjust: number, cellDimensions: TerminalSize): Tree {
  if (yAdjust === 0) return tree;

  switch (tree.type) {
    case 'empty':
    case 'leaf':
      return tree;

    case 'node': {
      if (!tree.data) return tree;

      const data = { ...tree.data };
      const { minY } = computeMinSize(tree);

      data.first = { ...data.first, dpi: cellDimensions.dpi };
      data.second = { ...data.second, dpi: cellDimensions.dpi };

      if (data.direction === SplitDirection.Horizontal) {
        const newRows = Math.max(minY, data.first.rows + yAdjust);
        const actualAdjust = newRows - data.first.rows;

        if (actualAdjust !== 0) {
          const newLeft = adjustYSize(tree.left, actualAdjust, cellDimensions);
          data.first.rows = newRows;
          data.first.pixelHeight = data.first.rows * cellDimensions.pixelHeight;

          const newRight = adjustYSize(tree.right, actualAdjust, cellDimensions);
          data.second.rows = data.first.rows;
          data.second.pixelHeight = data.first.pixelHeight;

          return createNodeTree(newLeft, newRight, data);
        }
        return tree;
      } else {
        // Vertical split - distribute adjustment between children
        let remaining = yAdjust;
        let newLeft = tree.left;
        let newRight = tree.right;

        if (yAdjust > 0) {
          newLeft = adjustYSize(tree.left, 1, cellDimensions);
          data.first.rows += 1;
          data.first.pixelHeight = data.first.rows * cellDimensions.pixelHeight;
          remaining -= 1;

          if (remaining > 0) {
            newRight = adjustYSize(tree.right, 1, cellDimensions);
            data.second.rows += 1;
            data.second.pixelHeight = data.second.rows * cellDimensions.pixelHeight;
            remaining -= 1;
          }
        } else {
          if (data.first.rows > 1) {
            newLeft = adjustYSize(tree.left, -1, cellDimensions);
            data.first.rows -= 1;
            data.first.pixelHeight = data.first.rows * cellDimensions.pixelHeight;
            remaining += 1;
          }
          if (remaining < 0 && data.second.rows > 1) {
            newRight = adjustYSize(tree.right, -1, cellDimensions);
            data.second.rows -= 1;
            data.second.pixelHeight = data.second.rows * cellDimensions.pixelHeight;
            remaining += 1;
          }
        }

        const result = createNodeTree(newLeft, newRight, data);
        if (remaining !== 0) {
          return adjustYSize(result, remaining, cellDimensions);
        }
        return result;
      }
    }
  }
}

/**
 * Apply sizes from split nodes to leaf panes
 */
export function applySizesFromSplits(tree: Tree, size: TerminalSize): void {
  switch (tree.type) {
    case 'empty':
      return;

    case 'node': {
      if (!tree.data) return;
      applySizesFromSplits(tree.left, tree.data.first);
      applySizesFromSplits(tree.right, tree.data.second);
      return;
    }

    case 'leaf': {
      tree.pane.resize(size);
      return;
    }
  }
}

/**
 * Get cell dimensions from terminal size
 */
export function cellDimensions(size: TerminalSize): TerminalSize {
  return {
    rows: 1,
    cols: 1,
    pixelWidth: Math.floor(size.pixelWidth / size.cols) || 1,
    pixelHeight: Math.floor(size.pixelHeight / size.rows) || 1,
    dpi: size.dpi,
  };
}

/**
 * Check if two ranges intersect
 */
export function intersectsRange(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}
