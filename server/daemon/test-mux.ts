/**
 * Mux Module Tests (without Tab)
 *
 * Tests for Mux, Domain, Window modules
 */

import { Activity } from './activity';
import { ClientInfo, createClientId } from './client';
import { createDefaultTerminalSize, RangeSet, createDefaultCursorPosition } from './renderable';
import { LocalDomain } from './domain';
import { Window } from './window';
import { Mux } from './mux';

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

  // Test 4: RangeSet
  await test('RangeSet operations', () => {
    const set = new RangeSet();
    set.add(5);
    set.addRange(10, 15);
    return set.contains(5) && set.contains(12) && !set.contains(20) && set.size === 6;
  });

  // Test 5: CursorPosition
  await test('CursorPosition creation', () => {
    const pos = createDefaultCursorPosition();
    return pos.x === 0 && pos.y === 0 && pos.visibility === 'visible';
  });

  // Test 6: LocalDomain creation
  await test('LocalDomain creation', () => {
    const domain = new LocalDomain('test-domain');
    return domain.domainName() === 'test-domain' && domain.spawnable() === true;
  });

  // Initialize Mux for Window tests
  const testDomain = new LocalDomain('test-mux-domain');
  const testMux = new Mux(testDomain);
  Mux.setMux(testMux);

  // Test 7: Window creation
  await test('Window creation', () => {
    const window = new Window('test-workspace');
    return window.getWorkspace() === 'test-workspace' && window.isEmpty() === true;
  });

  // Test 8: Window workspace change
  await test('Window workspace change', () => {
    const window = new Window('workspace1');
    window.setWorkspace('workspace2');
    return window.getWorkspace() === 'workspace2';
  });

  // Cleanup Mux
  Mux.shutdown();

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
