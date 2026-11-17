// End-to-end run of the unpacked extension in Playwright's bundled Chromium, headless.
// Branded Chrome and Edge ignore --load-extension, so this is the browser to test with.
// Run: bunx playwright-core install chromium && bun run test:e2e
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { launchExtension } from '../../scripts/launch-extension.js';

setDefaultTimeout(30000);

let browser;
let context;
let extensionId;

const page = (n) => `data:text/html,<title>Page ${n}</title>`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// An extension page used to drive chrome.* while no list view is open
async function driver() {
  const p = await context.newPage();
  await p.goto(`chrome-extension://${extensionId}/options.html`);
  return p;
}

async function storedOrder(p) {
  return p.evaluate(async () => {
    const { items = [] } = await chrome.storage.local.get('items');
    const tabs = await chrome.tabs.query({});
    const title = id => tabs.find(t => t.id === id)?.title ?? `closed ${id}`;
    return items.map(i => typeof i === 'number' ? title(i) : { [i.name]: i.tabs.map(title) });
  });
}

async function openList() {
  const p = await context.newPage();
  await p.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await p.waitForSelector('.tab-item');
  return p;
}

// Stops the service worker the way the browser does after it was idle; the next extension event
// starts it again. Playwright keeps the old worker handle, which no longer answers.
async function stopWorker(p) {
  const cdp = await context.newCDPSession(p);
  const stopped = new Promise(done => cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
    if (versions.some(v => v.runningStatus === 'stopped')) done();
  }));
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await stopped;
  await cdp.detach();
}

beforeAll(async () => {
  browser = await launchExtension();
  ({ context, extensionId } = browser);
});

afterAll(async () => {
  await browser?.close();
});

beforeEach(async () => {
  // One blank tab, an empty order
  const pages = context.pages();
  const keep = pages[0] ?? await context.newPage();
  await keep.goto('about:blank');
  for (const p of pages.slice(1)) await p.close();
  const d = await driver();
  await d.evaluate(() => chrome.storage.local.set({ items: [] }));
  await d.close();
});

test('tabs opened while no list is open keep their opening order after the worker was stopped', async () => {
  const d = await driver();
  // A list that was open once holds the tabs of that moment
  await (await openList()).close();
  await stopWorker(d);

  await d.evaluate(async (urls) => {
    const ids = [];
    for (const url of urls) {
      ids.push((await chrome.tabs.create({ url, active: true })).id);
      await new Promise(r => setTimeout(r, 100));
    }
    // Most recently used first, as an MRU extension rearranges the tab strip
    for (const [index, id] of [...ids].reverse().entries()) await chrome.tabs.move(id, { index });
  }, [1, 2, 3, 4].map(page));
  await sleep(300);

  // The restarted worker tracked them before any list opened
  const tracked = await storedOrder(d);
  expect(tracked.filter(t => typeof t === 'string' && t.startsWith('Page'))).toEqual(['Page 1', 'Page 2', 'Page 3', 'Page 4']);

  const list = await openList();
  const order = await storedOrder(list);
  expect(order.filter(t => typeof t === 'string' && t.startsWith('Page'))).toEqual(['Page 1', 'Page 2', 'Page 3', 'Page 4']);
  const shown = await list.$$eval('.tab-item .title', els => els.map(e => e.textContent));
  expect(shown.filter(t => t.startsWith('Page'))).toEqual(['Page 1', 'Page 2', 'Page 3', 'Page 4']);
});

test('a closed tab leaves the order while no list is open, a tab opened from a grouped tab joins the group', async () => {
  const d = await driver();
  const opener = await context.newPage();
  await opener.setContent('<title>Page A</title><a href="about:blank#child" target="_blank">child</a>');
  const [a, b] = await d.evaluate(async (url) => {
    const [a] = await chrome.tabs.query({ title: 'Page A' });
    const b = await chrome.tabs.create({ url, active: false });
    return [a.id, b.id];
  }, page('B'));
  await sleep(300);
  await d.evaluate(async (a) => {
    const { items } = await chrome.storage.local.get('items');
    await chrome.storage.local.set({
      items: [...items.filter(i => i !== a), { group: 'g1', name: 'G', color: '#2196f3', tabs: [a] }],
    });
  }, a);

  await opener.click('a');
  await d.evaluate((b) => chrome.tabs.remove(b), b);
  await sleep(500);

  const order = await storedOrder(d);
  expect(order).not.toContain('Page B');
  expect(order).toContainEqual({ G: ['Page A', 'about:blank#child'] });
});

test('in the side panel, arrows move the cursor without activating, Enter activates', async () => {
  const d = await driver();
  await d.evaluate(async (urls) => {
    for (const url of urls) await chrome.tabs.create({ url, active: false });
  }, [1, 2, 3].map(page));
  await sleep(300);

  const list = await openList();
  const titles = await list.$$eval('.tab-item .title', els => els.map(e => e.textContent));
  const active = () => list.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].title);
  const cursor = () => list.$eval('.tab-item.keyboard-focused .title', e => e.textContent);
  const start = await active();
  expect(await cursor()).toBe(start);

  await list.keyboard.press('Home');
  expect(await cursor()).toBe(titles[0]);
  await list.keyboard.press('ArrowDown');
  await list.keyboard.press('ArrowDown');
  expect(await cursor()).toBe(titles[2]);
  await list.keyboard.press('End');
  await list.keyboard.press('ArrowUp');
  expect(await cursor()).toBe(titles.at(-2));
  expect(await active()).toBe(start);

  await list.keyboard.press('Enter');
  await sleep(200);
  expect(await active()).toBe(titles.at(-2));
});

test('typing a search, Arrow Down moves into the matches, arrows walk them only and Enter opens one', async () => {
  const d = await driver();
  await d.evaluate(async (urls) => {
    for (const url of urls) await chrome.tabs.create({ url, active: false });
  }, ['data:text/html,<title>alpha one</title>', 'data:text/html,<title>beta</title>', 'data:text/html,<title>alpha two</title>']);
  await sleep(300);

  const list = await openList();
  await list.keyboard.press('/');
  await list.keyboard.type('alpha');
  const cursor = () => list.$eval('.tab-item.keyboard-focused .title', e => e.textContent);
  expect(await cursor()).toBe('alpha one');
  await list.keyboard.press('ArrowDown');
  expect(await cursor()).toBe('alpha one');
  await list.keyboard.press('ArrowDown');
  expect(await cursor()).toBe('alpha two');
  await list.keyboard.press('ArrowDown');
  expect(await cursor()).toBe('alpha two');

  await list.keyboard.press('Enter');
  await sleep(200);
  const [tab] = await list.evaluate(() => chrome.tabs.query({ title: 'alpha two' }));
  expect(tab.active).toBe(true);
  expect(await list.inputValue('#search-input')).toBe('');
});

test('Arrow Up on the first entry moves into the search field, Arrow Down back into the list', async () => {
  const d = await driver();
  await d.evaluate(async (urls) => {
    for (const url of urls) await chrome.tabs.create({ url, active: false });
  }, ['data:text/html,<title>gamma one</title>', 'data:text/html,<title>delta</title>', 'data:text/html,<title>gamma two</title>']);
  await sleep(300);

  const list = await openList();
  const cursor = () => list.$eval('.tab-item.keyboard-focused .title', e => e.textContent);
  const inSearch = () => list.evaluate(() => document.activeElement.id === 'search-input');
  await list.keyboard.press('/');
  await list.keyboard.type('gamma');
  await list.keyboard.press('ArrowDown');
  expect(await inSearch()).toBe(false);
  expect(await cursor()).toBe('gamma one');
  await list.keyboard.press('ArrowDown');
  expect(await cursor()).toBe('gamma two');
  await list.keyboard.press('ArrowUp');
  await list.keyboard.press('ArrowUp');
  expect(await inSearch()).toBe(true);
  expect(await list.inputValue('#search-input')).toBe('gamma');
  await list.keyboard.press('ArrowDown');
  expect(await inSearch()).toBe(false);
  expect(await cursor()).toBe('gamma one');
});

// Presses a chord the way the browser's shortcut handling sees it; page.keyboard never fires a command
async function shortcut(p, chord, settle = 1000) {
  const [key] = chord.split('+').slice(-1);
  const code = key.toUpperCase().charCodeAt(0);
  const cdp = await context.newCDPSession(p);
  for (const type of ['rawKeyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type, modifiers: 1, key: key.toUpperCase(), code: `Key${key.toUpperCase()}`,
      windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, commands: [],
    });
  }
  await cdp.detach();
  await sleep(settle);
}

async function sidePanelId(p) {
  const cdp = await context.newCDPSession(p);
  const { targetInfos } = await cdp.send('Target.getTargets');
  await cdp.detach();
  return targetInfos.find(t => t.url === `chrome-extension://${extensionId}/sidepanel.html` && t.type === 'page')?.targetId;
}

test('Alt+A opens the side panel and opens it again when it is open, Alt+Y closes it', async () => {
  const p = await context.newPage();
  await p.goto(page('shortcuts'));
  const d = await driver();
  await d.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, panelReopenPause: 500 } });
  });
  await d.close();
  expect(await sidePanelId(p)).toBeUndefined();

  await shortcut(p, 'Alt+A');
  const first = await sidePanelId(p);
  expect(first).toBeDefined();

  // The open panel closes at once and comes back as a new document only after the pause
  await shortcut(p, 'Alt+A', 250);
  expect(await sidePanelId(p)).toBeUndefined();
  await sleep(1000);
  const second = await sidePanelId(p);
  expect(second).toBeDefined();
  expect(second).not.toBe(first);

  await shortcut(p, 'Alt+Y');
  expect(await sidePanelId(p)).toBeUndefined();
  await shortcut(p, 'Alt+Y');
  expect(await sidePanelId(p)).toBeUndefined();
});

test('with the toggle setting, Alt+A closes an open side panel', async () => {
  const p = await context.newPage();
  await p.goto(page('toggle'));
  const d = await driver();
  await d.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, panelShortcutToggles: true } });
  });
  await d.close();

  await shortcut(p, 'Alt+A');
  expect(await sidePanelId(p)).toBeDefined();
  await shortcut(p, 'Alt+A');
  expect(await sidePanelId(p)).toBeUndefined();
});

// Evaluates an expression in the service worker. Playwright's own worker handle stops answering
// once the worker was restarted, so this attaches to the worker target running now.
async function inWorker(p, expression) {
  const cdp = await context.newCDPSession(p);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const { targetId } = targetInfos.find(t => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`));
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: false });
  const reply = new Promise(done => cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
    const { id, result } = JSON.parse(message);
    if (id === 1) done(result);
  }));
  await cdp.send('Target.sendMessageToTarget', {
    sessionId,
    message: JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }),
  });
  const result = await reply;
  await cdp.detach();
  return result;
}

test('next and previous tab follow the list across groups and windows, wrap around, and keep up with quick presses', async () => {
  const d = await driver();
  const [one, two, three, firstWindow] = await d.evaluate(async (urls) => {
    const one = await chrome.tabs.create({ url: urls[0], active: false });
    const two = await chrome.tabs.create({ url: urls[1], active: false });
    const other = await chrome.windows.create({ url: urls[2], focused: false });
    return [one.id, two.id, other.tabs[0].id, one.windowId];
  }, [1, 2, 3].map(page));
  await sleep(300);
  await d.evaluate(async ([one, two, three]) => {
    await chrome.storage.local.set({ items: [three, { group: 'g1', name: 'G', color: '#2196f3', tabs: [one, two] }] });
    await chrome.tabs.update(one, { active: true });
  }, [one, two, three]);

  // Headless Chromium does not move focus back to an older window, so this checks the tab only
  const active = (id) => d.evaluate(async (id) => (await chrome.tabs.get(id)).active, id);

  await inWorker(d, 'switchTab(1)');
  expect(await active(two)).toBe(true);
  // Past the end of the list into the first entry, which is in the other window
  await inWorker(d, 'switchTab(1)');
  expect(await d.evaluate(async (three) => {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    return win.id === (await chrome.tabs.get(three)).windowId;
  }, three)).toBe(true);
  // Two presses before the first one has finished
  await inWorker(d, 'Promise.all([switchTab(-1), switchTab(-1)])');
  expect(await active(one)).toBe(true);

  // Once the presses have settled, the last focused browser window's tab is the starting point,
  // also from a popup window. The other window goes, as focus would not return from it.
  await d.evaluate((three) => chrome.tabs.remove(three), three);
  await sleep(1100);
  await d.evaluate(() => chrome.windows.create({ url: 'about:blank', type: 'popup', focused: true }));
  await inWorker(d, 'switchTab(1)');
  const tab = await d.evaluate(async (two) => chrome.tabs.get(two), two);
  expect(tab.active).toBe(true);
  expect(tab.windowId).toBe(firstWindow);
});

test('settings written without some keys, as by an older backup, get the missing defaults back', async () => {
  const d = await driver();
  await d.evaluate(() => chrome.storage.local.set({ settings: { newTabPosition: 'top' } }));
  await sleep(300);
  const { settings } = await d.evaluate(() => chrome.storage.local.get('settings'));
  expect(settings.newTabPosition).toBe('top');
  expect(settings.panelReopenPause).toBe(100);
  expect(settings.sessionSortOrder).toBe('modified');
  await d.evaluate((s) => chrome.storage.local.set({ settings: { ...s, newTabPosition: 'bottom' } }), settings);
});
