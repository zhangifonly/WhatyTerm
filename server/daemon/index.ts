/**
 * WezTerm Mux Module - TypeScript Translation
 *
 * This is a 1:1 translation of WezTerm's mux module from Rust to TypeScript.
 * The mux (multiplexer) manages terminal sessions, panes, tabs, windows, and domains.
 *
 * Original source: https://github.com/wez/wezterm/tree/main/mux/src
 *
 * Module structure:
 * - activity.ts    - Activity tracking for preventing premature cleanup
 * - client.ts      - Client identification and info
 * - renderable.ts  - Terminal size and cursor types
 * - pane.ts        - Pane interface and base implementation
 * - window.ts      - Window management
 * - tab-types.ts   - Tab-related type definitions
 * - tab-tree.ts    - Binary tree for pane layout
 * - tab.ts         - Tab class implementation
 * - local-pane.ts  - Local PTY pane implementation
 * - domain.ts      - Domain interface and LocalDomain
 * - mux.ts         - Central multiplexer
 */

// Core types
export { Activity } from './activity';
export { ClientId, ClientInfo } from './client';
export {
  TerminalSize,
  RenderableDimensions,
  StableCursorPosition,
  StableRowIndex,
  CursorVisibility,
  CursorShape,
} from './renderable';

// Pane
export {
  Pane,
  PaneId,
  allocPaneId,
  CachePolicy,
  CloseReason,
  ExitBehavior,
  AbstractPane,
} from './pane';

// Window
export {
  Window,
  WindowId,
  allocWindowId,
  GuiPosition,
  MuxNotification,
} from './window';

// Tab types
export {
  TabId,
  allocateTabId,
  SplitDirection,
  SplitSize,
  SplitRequest,
  SplitDirectionAndSize,
  PositionedPane,
  PositionedSplit,
  PaneDirection,
  PaneNode,
  PaneEntry,
  SerdeUrl,
  defaultSplitRequest,
  defaultSplitSize,
} from './tab-types';

// Tab tree utilities
export {
  Tree,
  Cursor,
  PathBranch,
  createEmptyTree,
  createLeafTree,
  createNodeTree,
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

// Tab
export { Tab } from './tab';

// Local pane
export { LocalPane } from './local-pane';

// Domain
export {
  Domain,
  DomainId,
  allocDomainId,
  DomainState,
  SplitSource,
  CommandBuilder,
  createDefaultCommandBuilder,
  LocalDomain,
  WriterWrapper,
  FailedProcessSpawn,
} from './domain';

// Mux
export {
  Mux,
  MuxWindowBuilder,
  IdentityHolder,
  ExtendedMuxNotification,
  DEFAULT_WORKSPACE,
  getMux,
  tryGetMux,
} from './mux';
