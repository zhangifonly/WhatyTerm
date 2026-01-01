/**
 * WezTerm Mux Full Integration Tests
 *
 * 完整的 Mux 模块集成测试，验证所有翻译的模块是否正常工作
 */

import { Mux, DEFAULT_WORKSPACE, MuxWindowBuilder } from './mux';
import { LocalDomain, DomainState } from './domain';
import { Tab } from './tab';
import { Window } from './window';
import { Activity } from './activity';
import { ClientInfo, createClientId, ClientId } from './client';
import { createDefaultTerminalSize, TerminalSize, RangeSet } from './renderable';
import { CloseReason } from './pane';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
  return Promise.resolve(fn()).then(result => {
    if (result) {
      console.log(`  ✓ ${name}`);
      passed++;
    } else {
      console.log(`  ✗ ${name}`);
      failed++;
    }
  }).catch(err => {
    console.log(`  ✗ ${name}: ${err.message}`);
    failed++;
  });
}

async function runTests(): Promise<void> {
  console.log('=== WezTerm Mux Full Integration Tests ===\n');

  // ==========================================
  // 1. 基础类型测试
  // ==========================================
  console.log('1. Basic Types Tests:');

  await test('Activity tracking - create and dispose', () => {
    const activity1 = new Activity();
    const activity2 = new Activity();
    const count1 = Activity.count();
    activity1.dispose();
    const count2 = Activity.count();
    activity2.dispose();
    const count3 = Activity.count();
    return count1 === 2 && count2 === 1 && count3 === 0;
  });

  await test('ClientId uniqueness', () => {
    const ids = new Set<number>();
    for (let i = 0; i < 100; i++) {
      ids.add(createClientId().id);
    }
    return ids.size === 100;
  });

  await test('ClientInfo - update focused pane', () => {
    const clientId = createClientId();
    const info = new ClientInfo(clientId);
    info.updateFocusedPane(42);
    info.updateFocusedPane(100);
    return info.focusedPaneId === 100;
  });

  await test('TerminalSize defaults', () => {
    const size = createDefaultTerminalSize();
    return size.rows === 24 && size.cols === 80 && size.dpi === 96 &&
           size.pixelHeight === 0 && size.pixelWidth === 0;
  });

  await test('RangeSet - add and contains', () => {
    const set = new RangeSet();
    set.add(5);
    set.add(10);
    set.addRange(20, 25);
    return set.contains(5) && set.contains(10) && set.contains(22) &&
           !set.contains(6) && !set.contains(30);
  });

  // ==========================================
  // 2. Domain 测试
  // ==========================================
  console.log('\n2. Domain Tests:');

  await test('LocalDomain creation', () => {
    const domain = new LocalDomain('test-domain');
    return domain.domainName() === 'test-domain' &&
           domain.state() === DomainState.Attached &&
           domain.spawnable() === true;
  });

  await test('LocalDomain - multiple domains have unique IDs', () => {
    const domain1 = new LocalDomain('domain1');
    const domain2 = new LocalDomain('domain2');
    const domain3 = new LocalDomain('domain3');
    return domain1.domainId() !== domain2.domainId() &&
           domain2.domainId() !== domain3.domainId();
  });

  // ==========================================
  // 3. Window 测试 (需要先初始化 Mux)
  // ==========================================
  console.log('\n3. Window Tests:');

  // 初始化 Mux 以便 Window 可以正常工作
  const windowTestDomain = new LocalDomain('window-test');
  const windowTestMux = new Mux(windowTestDomain);
  Mux.setMux(windowTestMux);

  await test('Window creation with workspace', () => {
    const window = new Window('my-workspace');
    return window.getWorkspace() === 'my-workspace' && window.isEmpty();
  });

  await test('Window - default workspace', () => {
    const window = new Window();
    return window.getWorkspace() === DEFAULT_WORKSPACE;
  });

  await test('Window - set workspace', () => {
    const window = new Window('old');
    window.setWorkspace('new');
    return window.getWorkspace() === 'new';
  });

  await test('Window - unique IDs', () => {
    const w1 = new Window();
    const w2 = new Window();
    const w3 = new Window();
    return w1.windowId() !== w2.windowId() && w2.windowId() !== w3.windowId();
  });

  Mux.shutdown();

  // ==========================================
  // 4. Tab 测试
  // ==========================================
  console.log('\n4. Tab Tests:');

  await test('Tab creation with size', () => {
    const size: TerminalSize = {
      rows: 30,
      cols: 100,
      pixelHeight: 600,
      pixelWidth: 1000,
      dpi: 96,
    };
    const tab = new Tab(size);
    const tabSize = tab.getSize();
    return tabSize.rows === 30 && tabSize.cols === 100;
  });

  await test('Tab - unique IDs', () => {
    const size = createDefaultTerminalSize();
    const t1 = new Tab(size);
    const t2 = new Tab(size);
    const t3 = new Tab(size);
    return t1.getTabId() !== t2.getTabId() && t2.getTabId() !== t3.getTabId();
  });

  await test('Tab - tabId() method', () => {
    const size = createDefaultTerminalSize();
    const tab = new Tab(size);
    return tab.tabId() === tab.getTabId();
  });

  await test('Tab - resize', () => {
    const size = createDefaultTerminalSize();
    const tab = new Tab(size);
    const newSize: TerminalSize = {
      rows: 50,
      cols: 120,
      pixelHeight: 1000,
      pixelWidth: 1200,
      dpi: 96,
    };
    tab.resize(newSize);
    const tabSize = tab.getSize();
    return tabSize.rows === 50 && tabSize.cols === 120;
  });

  // ==========================================
  // 5. Mux 单例测试
  // ==========================================
  console.log('\n5. Mux Singleton Tests:');

  await test('Mux singleton - set and get', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);
    const retrieved = Mux.get();
    const result = retrieved === mux;
    Mux.shutdown();
    return result;
  });

  await test('Mux singleton - tryGet returns null after shutdown', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);
    Mux.shutdown();
    return Mux.tryGet() === null;
  });

  await test('Mux singleton - get throws after shutdown', () => {
    Mux.shutdown();
    try {
      Mux.get();
      return false;
    } catch (e) {
      return true;
    }
  });

  // ==========================================
  // 6. Mux 客户端管理测试
  // ==========================================
  console.log('\n6. Mux Client Management Tests:');

  await test('Mux - register and unregister client', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);

    const clientId = createClientId();
    mux.registerClient(clientId);
    const clients1 = mux.iterClients();

    mux.unregisterClient(clientId);
    const clients2 = mux.iterClients();

    Mux.shutdown();
    return clients1.length === 1 && clients2.length === 0;
  });

  await test('Mux - multiple clients', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);

    const client1 = createClientId();
    const client2 = createClientId();
    const client3 = createClientId();

    mux.registerClient(client1);
    mux.registerClient(client2);
    mux.registerClient(client3);

    const clients = mux.iterClients();

    Mux.shutdown();
    return clients.length === 3;
  });

  // ==========================================
  // 7. Mux Workspace 管理测试
  // ==========================================
  console.log('\n7. Mux Workspace Management Tests:');

  await test('Mux - default workspace', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);

    const workspace = mux.activeWorkspace();

    Mux.shutdown();
    return workspace === DEFAULT_WORKSPACE;
  });

  await test('Mux - set active workspace for client', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);

    const clientId = createClientId();
    mux.registerClient(clientId);
    mux.setActiveWorkspaceForClient(clientId, 'my-workspace');

    const workspace = mux.activeWorkspaceForClient(clientId);

    Mux.shutdown();
    return workspace === 'my-workspace';
  });

  await test('Mux - generate workspace name', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);

    const name1 = mux.generateWorkspaceName();
    const name2 = mux.generateWorkspaceName();

    Mux.shutdown();
    // Both should be workspace-1 since no windows exist
    return name1 === 'workspace-1' && name2 === 'workspace-1';
  });

  // ==========================================
  // 8. Mux 通知系统测试
  // ==========================================
  console.log('\n8. Mux Notification System Tests:');

  await test('Mux - subscribe and receive notification', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);

    let received = false;
    mux.subscribe((notification) => {
      if (notification.type === 'Empty') {
        received = true;
      }
      return true;
    });

    mux.notify({ type: 'Empty' });

    Mux.shutdown();
    return received;
  });

  await test('Mux - unsubscribe by returning false', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);

    let count = 0;
    mux.subscribe((notification) => {
      count++;
      return false; // Unsubscribe after first notification
    });

    mux.notify({ type: 'Empty' });
    mux.notify({ type: 'Empty' });
    mux.notify({ type: 'Empty' });

    Mux.shutdown();
    return count === 1;
  });

  await test('Mux - multiple subscribers', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);

    let count1 = 0;
    let count2 = 0;

    mux.subscribe(() => { count1++; return true; });
    mux.subscribe(() => { count2++; return true; });

    mux.notify({ type: 'Empty' });

    Mux.shutdown();
    return count1 === 1 && count2 === 1;
  });

  // ==========================================
  // 9. Mux Window 管理测试
  // ==========================================
  console.log('\n9. Mux Window Management Tests:');

  await test('Mux - create empty window', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);

    const builder = mux.newEmptyWindow('test-workspace');
    const windowId = builder.getWindowId();
    builder.dispose();

    const windows = mux.iterWindows();

    Mux.shutdown();
    return windows.length === 1 && windows[0] === windowId;
  });

  await test('Mux - multiple windows', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);

    const b1 = mux.newEmptyWindow('ws1');
    const b2 = mux.newEmptyWindow('ws2');
    const b3 = mux.newEmptyWindow('ws3');
    b1.dispose();
    b2.dispose();
    b3.dispose();

    const windows = mux.iterWindows();

    Mux.shutdown();
    return windows.length === 3;
  });

  await test('Mux - iter windows in workspace', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);

    const b1 = mux.newEmptyWindow('ws-a');
    const b2 = mux.newEmptyWindow('ws-a');
    const b3 = mux.newEmptyWindow('ws-b');
    b1.dispose();
    b2.dispose();
    b3.dispose();

    const wsA = mux.iterWindowsInWorkspace('ws-a');
    const wsB = mux.iterWindowsInWorkspace('ws-b');

    Mux.shutdown();
    return wsA.length === 2 && wsB.length === 1;
  });

  await test('Mux - get window', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);

    const builder = mux.newEmptyWindow('test');
    const windowId = builder.getWindowId();
    builder.dispose();

    const window = mux.getWindow(windowId);

    Mux.shutdown();
    return window !== null && window.getWorkspace() === 'test';
  });

  // ==========================================
  // 10. Mux Domain 管理测试
  // ==========================================
  console.log('\n10. Mux Domain Management Tests:');

  await test('Mux - get default domain', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);

    const defaultDomain = mux.getDefaultDomain();

    Mux.shutdown();
    return defaultDomain === domain;
  });

  await test('Mux - add and get domain by ID', () => {
    const domain1 = new LocalDomain('domain1');
    const mux = new Mux(domain1);
    Mux.setMux(mux);

    const domain2 = new LocalDomain('domain2');
    mux.addDomain(domain2);

    const retrieved = mux.getDomain(domain2.domainId());

    Mux.shutdown();
    return retrieved === domain2;
  });

  await test('Mux - get domain by name', () => {
    const domain1 = new LocalDomain('domain1');
    const mux = new Mux(domain1);
    Mux.setMux(mux);

    const domain2 = new LocalDomain('domain2');
    mux.addDomain(domain2);

    const retrieved = mux.getDomainByName('domain2');

    Mux.shutdown();
    return retrieved === domain2;
  });

  await test('Mux - iter domains', () => {
    const domain1 = new LocalDomain('domain1');
    const mux = new Mux(domain1);
    Mux.setMux(mux);

    const domain2 = new LocalDomain('domain2');
    const domain3 = new LocalDomain('domain3');
    mux.addDomain(domain2);
    mux.addDomain(domain3);

    const domains = mux.iterDomains();

    Mux.shutdown();
    return domains.length === 3;
  });

  // ==========================================
  // 11. Mux 状态测试
  // ==========================================
  console.log('\n11. Mux State Tests:');

  await test('Mux - isEmpty when no panes', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);

    const empty = mux.isEmpty();

    Mux.shutdown();
    return empty === true;
  });

  await test('Mux - banner get/set', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);

    mux.setBanner('Test Banner');
    const banner = mux.getBanner();

    Mux.shutdown();
    return banner === 'Test Banner';
  });

  await test('Mux - identity management', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);

    const clientId = createClientId();
    mux.registerClient(clientId);

    const holder = mux.withIdentity(clientId);
    const activeId = mux.activeIdentity();
    holder.dispose();
    const afterDispose = mux.activeIdentity();

    Mux.shutdown();
    return activeId === clientId && afterDispose === null;
  });

  // ==========================================
  // Summary
  // ==========================================
  console.log('\n' + '='.repeat(50));
  console.log('=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);
  console.log('='.repeat(50));

  if (failed > 0) {
    process.exit(1);
  }
}

// Run tests
runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
