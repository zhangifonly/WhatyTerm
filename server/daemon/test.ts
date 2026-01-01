/**
 * WezTerm Mux Module Test
 *
 * 测试翻译的 mux 模块各组件是否正常工作
 */

import { Mux, DEFAULT_WORKSPACE } from './mux';
import { LocalDomain } from './domain';
import { Tab } from './tab';
import { Activity } from './activity';
import { ClientInfo, createClientId, ClientId } from './client';
import { createDefaultTerminalSize, TerminalSize } from './renderable';

async function runTests(): Promise<void> {
  console.log('=== WezTerm Mux Module Tests ===\n');

  let passed = 0;
  let failed = 0;

  function test(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
    return Promise.resolve(fn()).then(result => {
      if (result) {
        console.log(`✓ ${name}`);
        passed++;
      } else {
        console.log(`✗ ${name}`);
        failed++;
      }
    }).catch(err => {
      console.log(`✗ ${name}: ${err.message}`);
      failed++;
    });
  }

  // Test 1: Activity tracking
  await test('Activity tracking', () => {
    const activity1 = new Activity();
    const count1 = Activity.count();
    const activity2 = new Activity();
    const count2 = Activity.count();
    activity1.dispose();
    const count3 = Activity.count();
    activity2.dispose();
    const count4 = Activity.count();
    return count1 === 1 && count2 === 2 && count3 === 1 && count4 === 0;
  });

  // Test 2: ClientInfo
  await test('ClientInfo creation', () => {
    const clientId = createClientId();
    const info = new ClientInfo(clientId);
    return info.clientId === clientId && info.focusedPaneId === null;
  });

  // Test 3: TerminalSize
  await test('TerminalSize creation', () => {
    const size = createDefaultTerminalSize();
    return size.rows === 24 && size.cols === 80 && size.dpi === 96;
  });

  // Test 4: LocalDomain creation
  await test('LocalDomain creation', () => {
    const domain = new LocalDomain('test-domain');
    return domain.domainName() === 'test-domain' && domain.spawnable() === true;
  });

  // Test 5: Mux singleton
  await test('Mux singleton', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);
    const retrieved = Mux.get();
    const result = retrieved === mux;
    Mux.shutdown();
    return result;
  });

  // Test 6: Mux workspace management
  await test('Mux workspace management', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);

    const workspace = mux.activeWorkspace();
    const result = workspace === DEFAULT_WORKSPACE;

    Mux.shutdown();
    return result;
  });

  // Test 7: Tab creation
  await test('Tab creation', () => {
    const size: TerminalSize = {
      rows: 24,
      cols: 80,
      pixelHeight: 480,
      pixelWidth: 640,
      dpi: 96,
    };
    const tab = new Tab(size);
    const tabId = tab.getTabId();
    const tabSize = tab.getSize();
    return typeof tabId === 'number' && tabSize.rows === 24 && tabSize.cols === 80;
  });

  // Test 8: Mux client registration
  await test('Mux client registration', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);

    const clientId = createClientId();
    mux.registerClient(clientId);
    const clients = mux.iterClients();
    const result = clients.length === 1 && clients[0].clientId === clientId;

    mux.unregisterClient(clientId);
    const clientsAfter = mux.iterClients();
    const result2 = clientsAfter.length === 0;

    Mux.shutdown();
    return result && result2;
  });

  // Test 9: Mux notification subscription
  await test('Mux notification subscription', () => {
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

  // Test 10: Window creation
  await test('Window creation via Mux', () => {
    const domain = new LocalDomain('default');
    const mux = new Mux(domain);
    Mux.setMux(mux);

    const builder = mux.newEmptyWindow('test-workspace');
    const windowId = builder.getWindowId();
    builder.dispose();

    const windows = mux.iterWindows();
    const result = windows.length === 1 && windows[0] === windowId;

    Mux.shutdown();
    return result;
  });

  // Summary
  console.log(`\n=== Test Results ===`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

// Run tests
runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
