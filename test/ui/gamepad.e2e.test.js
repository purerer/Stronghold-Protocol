// SP_E2E=1 node --test test/ui/gamepad.e2e.test.js
// Real browser DOM and game UI with an injected standard controller; no physical gamepad required.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stickVector } from '../../public/js/ui/gamepad.js';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = fileURLToPath(new URL('../e2e/out/', import.meta.url));

test('stick dead zone rejects drift/non-finite values and bounds diagonal travel', () => {
  assert.deepEqual(stickVector(0.1, -0.1), { x: 0, y: 0 });
  assert.deepEqual(stickVector(NaN, 1), { x: 0, y: 0 });
  assert.deepEqual(stickVector(1, 0), { x: 1, y: 0 });
  assert.ok(Math.hypot(...Object.values(stickVector(1, 1))) <= 1.000001);
  assert.ok(stickVector(0.3, 0).x > 0 && stickVector(0.3, 0).x < stickVector(0.8, 0).x);
});

describe('gamepad browser input', { skip: !(process.env.SP_E2E === '1' && existsSync(CHROME)) }, () => {
  let server, browser;
  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
    mkdirSync(OUT, { recursive: true });
  });
  after(async () => { await browser?.close(); await server?.close(); });

  async function open(t, fixture = false, renderer = 'fallback') {
    const context = await browser.createBrowserContext();
    t.after(() => context.close());
    const page = await context.newPage();
    await page.bringToFront();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${server.url}/dev/game-mock.html?shot=1&render=${renderer}&phase=PREP`, { waitUntil: 'domcontentloaded' });
    if (renderer === 'engine') await page.waitForFunction(() => window.__SP_VIEW__?.kind === 'engine');
    else await page.waitForSelector('.ff-piece');
    // Preact effects bind keyboard listeners after the first paint, not when the first DOM nodes appear.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150)))));
    await page.addStyleTag({ url: `${server.url}/css/gamepad.css` });
    await page.evaluate(async (useFixture) => {
      const { installGamepad } = await import('/js/ui/gamepad.js');
      const { settingsStore } = await import('/js/ui/settings.js');
      if (useFixture) {
        const root = document.createElement('div');
        root.style.cssText = 'position:fixed;inset:0;z-index:10000;background:#123';
        root.innerHTML = '<canvas id="gp-canvas" style="position:absolute;left:100px;top:100px;width:400px;height:300px"></canvas>'
          + '<button id="gp-button" style="position:absolute;left:700px;top:100px;width:120px;height:60px">Button</button>'
          + '<div id="gp-scroll" style="position:absolute;left:700px;top:300px;width:200px;height:100px;overflow:auto"><div style="height:1000px">Scroll</div></div>';
        document.body.append(root);
        window.__gpEvents = [];
        for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click', 'contextmenu', 'keydown']) {
          root.addEventListener(name, (e) => window.__gpEvents.push({ type: name, target: e.target.id, key: e.key, buttons: e.buttons }));
        }
      }
      const pad = { index: 0, id: 'Browser test controller', connected: true, mapping: 'standard', axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
      let callback, time = 0;
      const env = { document, navigator: { getGamepads: () => [pad] }, PointerEvent, MouseEvent, KeyboardEvent, Event,
        get innerWidth() { return window.innerWidth; }, get innerHeight() { return window.innerHeight; },
        getComputedStyle: window.getComputedStyle.bind(window), addEventListener: window.addEventListener.bind(window),
        removeEventListener: window.removeEventListener.bind(window), requestAnimationFrame: (fn) => { callback = fn; return 1; }, cancelAnimationFrame() {} };
      const stop = installGamepad({ settings: settingsStore, win: env });
      const tick = () => { time += 16; const fn = callback; fn(time); };
      const button = (i, down) => { pad.buttons[i] = { pressed: down, value: Number(down) }; tick(); };
      const move = (tx, ty) => {
        for (let i = 0; i < 300; i++) {
          const r = document.querySelector('.gamepad-cursor').getBoundingClientRect();
          const dx = tx - r.x - r.width / 2, dy = ty - r.y - r.height / 2, distance = Math.hypot(dx, dy);
          if (distance < 0.1) break;
          const speed = pad.buttons[6].pressed ? 150 : Math.max(450, Math.min(1000, innerWidth * 0.55));
          const strength = 0.2 + 0.8 * Math.sqrt(Math.min(1, distance / (speed * 0.016)));
          pad.axes[0] = dx / distance * strength; pad.axes[1] = dy / distance * strength; tick();
        }
        pad.axes[0] = 0; pad.axes[1] = 0; tick();
      };
      window.__gp = { pad, tick, button, move, stop, settingsStore };
      window.dispatchEvent(new Event('focus'));
      tick(); tick();
    }, fixture);
    return page;
  }
  const moveTo = (page, selector) => page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect(); window.__gp.move(r.x + r.width / 2, r.y + r.height / 2);
  });
  const press = (page, index, down) => page.evaluate((i, d) => window.__gp.button(i, d), index, down);
  const tap = async (page, index) => { await press(page, index, true); await press(page, index, false); };

  test('click, held drag, context menu, scrolling and input cancellation', async (t) => {
    const page = await open(t, true);
    await moveTo(page, '#gp-button'); await tap(page, 0);
    assert.equal(await page.evaluate(() => window.__gpEvents.filter((e) => e.type === 'click' && e.target === 'gp-button').length), 1);
    await moveTo(page, '#gp-canvas'); await press(page, 0, true);
    await page.evaluate(() => window.__gp.move(550, 450)); await press(page, 0, false);
    const drag = await page.evaluate(() => window.__gpEvents);
    assert.ok(drag.some((e) => e.type === 'pointermove' && e.target === 'gp-canvas' && e.buttons === 1));
    assert.ok(drag.some((e) => e.type === 'pointerup' && e.target === 'gp-canvas'));
    assert.equal(drag.filter((e) => e.type === 'click' && e.target === 'gp-canvas').length, 0);
    await moveTo(page, '#gp-button'); await tap(page, 7);
    assert.ok(await page.evaluate(() => window.__gpEvents.some((e) => e.type === 'contextmenu' && e.target === 'gp-button')));
    await moveTo(page, '#gp-scroll');
    await page.evaluate(() => { window.__gp.pad.axes[3] = 1; for (let i = 0; i < 10; i++) window.__gp.tick(); window.__gp.pad.axes[3] = 0; });
    assert.ok(await page.$eval('#gp-scroll', (el) => el.scrollTop > 0));
    for (const reason of ['cancel', 'blur', 'disconnect', 'disable', 'mouse']) {
      await page.evaluate(() => { window.__gp.pad.connected = true; window.__gp.settingsStore.set({ gamepadEnabled: true }); window.dispatchEvent(new Event('focus')); window.__gp.button(0, false); window.__gp.tick(); });
      await moveTo(page, '#gp-canvas'); await press(page, 0, true);
      await page.evaluate(() => window.__gp.move(450, 350));
      const before = await page.evaluate(() => window.__gpEvents.filter((e) => e.type === 'pointerup').length);
      if (reason === 'mouse') await page.mouse.move(20, 20);
      else await page.evaluate((why) => {
        const g = window.__gp;
        if (why === 'cancel') g.button(1, true);
        if (why === 'blur') window.dispatchEvent(new Event('blur'));
        if (why === 'disconnect') { g.pad.connected = false; g.tick(); }
        if (why === 'disable') g.settingsStore.set({ gamepadEnabled: false });
      }, reason);
      const result = await page.evaluate(() => ({ cancel: window.__gpEvents.filter((e) => e.type === 'pointercancel').length,
        up: window.__gpEvents.filter((e) => e.type === 'pointerup').length }));
      assert.ok(result.cancel > 0, reason); assert.equal(result.up, before, `${reason} does not drop`);
      await page.evaluate(() => { window.__gp.button(0, false); window.__gp.button(1, false); });
    }
  });

  test('game shortcuts follow current bindings; modal blocks them; settings persist', async (t) => {
    const page = await open(t);
    await page.evaluate(() => { window.__gpKeys = []; window.addEventListener('keydown', (e) => window.__gpKeys.push([e.code, e.key])); });
    const frozen = () => page.evaluate(() => window.__MOCK__.S().priv.shop.frozen);
    const old = await frozen(); await tap(page, 4);
    await page.waitForFunction((value) => window.__MOCK__.S().priv.shop.frozen === value, { timeout: 5000 }, !old).catch(async (error) => {
      console.log('controller diagnostics', await page.evaluate(async () => ({ keys: window.__gpKeys, hidden: document.hidden,
        focused: document.hasFocus(), settings: window.__gp.settingsStore.get(), status: (await import('/js/ui/gamepad.js')).gamepadStatus.get(),
        requests: window.__MOCK__.S().requests, overlays: [...document.querySelectorAll('.modal,.guide,.offerov')].map((e) => e.className) })));
      throw error;
    });
    assert.equal(await frozen(), !old);
    await page.evaluate(async () => {
      const { rebindHotkey } = await import('/js/ui/gameLogic/shortcuts.js');
      const s = window.__gp.settingsStore;
      s.set({ keys: rebindHotkey(s.get().keys, 'freeze', 'KeyZ').keys });
    });
    await tap(page, 4);
    await page.waitForFunction((value) => window.__MOCK__.S().priv.shop.frozen === value, {}, old);
    assert.equal(await frozen(), old);
    await page.click('.gm__gear'); await page.waitForSelector('.set-gamepad');
    await tap(page, 4);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)));
    assert.equal(await frozen(), old, 'modal owns input');
    assert.match(await page.$eval('.set-gamepad', (el) => el.textContent), /Browser test controller/);
    await page.$eval('.set-gamepad', (el) => el.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: `${OUT}/gamepad-settings.png` });
    await page.click('.set-gamepad [role="switch"]');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sp.pref.settings')).gamepadEnabled), false);
  });

  test('gamepad drags an operator, previews facing and commits exactly one deployment', async (t) => {
    const page = await open(t);
    const { uid, row, col } = await page.evaluate(() => {
      window.__MOCK__.mutate((s) => { s.priv.board.splice(0, 1); });
      const p = window.__MOCK__.S().priv;
      const piece = p.hand.find((v) => v?.kind === 'chess');
      const tile = [[9, 9], [9, 8], [12, 6], [11, 7], [10, 7], [9, 7]].find(([r, c]) => !p.board.some((v) => v.row === r && v.col === c));
      return { uid: piece.uid, row: tile[0], col: tile[1] };
    });
    await page.waitForFunction((id) => !!document.querySelector(`.ff-piece[data-uid="${id}"]`), {}, uid);
    await moveTo(page, `.ff-piece[data-uid="${uid}"]`);
    await press(page, 0, true);
    await page.evaluate(() => {
      const r = document.querySelector('.gamepad-cursor').getBoundingClientRect();
      window.__gp.move(r.x + r.width / 2 + 25, r.y + r.height / 2);
    });
    await moveTo(page, `.ff-tile[data-row="${row}"][data-col="${col}"]`);
    await press(page, 0, false);
    await page.waitForSelector('.fwheel');
    assert.equal(await page.evaluate(() => window.__MOCK__.S().requests.filter(([name]) => name === 'g.move').length), 0);
    await press(page, 15, true);
    await page.waitForSelector('.fwheel.is-right');
    await press(page, 15, false);
    await page.screenshot({ path: `${OUT}/gamepad-facing.png` });
    await tap(page, 0);
    await page.waitForFunction((id) => window.__MOCK__.S().priv.board.some((v) => v.uid === id), {}, uid);
    const result = await page.evaluate((id) => ({ piece: window.__MOCK__.S().priv.board.find((v) => v.uid === id),
      moves: window.__MOCK__.S().requests.filter(([name]) => name === 'g.move') }), uid);
    assert.equal(result.moves.length, 1);
    assert.deepEqual([result.piece.row, result.piece.col, result.piece.dir], [row, col, 'RIGHT']);
  });

  test('real entry boots with a controller and persists its enable switch', async (t) => {
    const context = await browser.createBrowserContext(); t.after(() => context.close());
    const page = await context.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'getGamepads', { value: () => [{ index: 0, id: 'Entry test controller', connected: true,
        mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) }] });
    });
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__SP__);
    await page.click('.title-settings'); await page.waitForSelector('.set-gamepad');
    await page.waitForFunction(() => document.querySelector('.set-gamepad')?.textContent.includes('Entry test controller'));
    await page.$eval('.set-gamepad', (el) => el.scrollIntoView({ block: 'center' }));
    await page.click('.set-gamepad [role="switch"]');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__SP__);
    await page.click('.title-settings'); await page.waitForSelector('.set-gamepad');
    assert.equal(await page.$eval('.set-gamepad [role="switch"]', (el) => el.getAttribute('aria-checked')), 'false');
    assert.deepEqual(errors, []);
  });

  test('rendered canvas accepts gamepad dragging and facing confirmation', async (t) => {
    const page = await open(t, false, 'engine');
    const target = await page.evaluate(() => {
      const p = window.__MOCK__.S().priv;
      const view = window.__SP_VIEW__;
      // Select a visible point on the drawn model, not its ground tile (the perspective body is offset).
      for (const piece of p.board.filter((v) => v.kind === 'chess')) {
        const r = view.pieceScreenRect(piece.uid);
        if (!r) continue;
        for (const fy of [0.5, 0.7, 0.9]) for (const fx of [0.5, 0.3, 0.7]) {
          const x = r.left + r.width * fx, y = r.top + r.height * fy;
          if (document.elementFromPoint(x, y)?.tagName !== 'CANVAS' || view.pieceAtClientPoint(x, y) !== piece.uid) continue;
          window.__gp.move(x, y);
          return { uid: piece.uid, row: piece.row, col: piece.col };
        }
      }
      throw new Error('No visible rendered piece can be picked');
    });
    await press(page, 0, true);
    await page.evaluate(() => {
      const r = document.querySelector('.gamepad-cursor').getBoundingClientRect();
      window.__gp.move(r.x + r.width / 2 + 25, r.y + r.height / 2);
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(({ row, col }) => {
      const point = window.__SP_VIEW__.tileScreen(row, col); window.__gp.move(point.x, point.y);
    }, target);
    await press(page, 0, false); await page.waitForSelector('.fwheel');
    await press(page, 12, true); await page.waitForSelector('.fwheel.is-up'); await press(page, 12, false);
    await page.screenshot({ path: `${OUT}/gamepad-engine.png` });
    await tap(page, 0);
    await page.waitForFunction(({ uid, row, col }) => window.__MOCK__.S().priv.board.some((v) => v.uid === uid && v.row === row && v.col === col && v.dir === 'UP'), {}, target);
    assert.equal(await page.evaluate(() => window.__MOCK__.S().requests.filter(([name]) => name === 'g.move').length), 1);
  });
});
