// Standard Gamepad API → the same pointer/keyboard input used by mouse and keyboard players.
// [ASSUMED] Fork-specific bindings and a virtual mouse; no game rules or network intents here.
// Synthetic pointers cannot use browser capture: retain the press target until release/cancellation.
// Disconnect, blur, real pointer input and disabling cancel a drag rather than committing it.
import { createStore } from '../store.js';
import { keyValueForCode } from './gameLogic/shortcuts.js';

export const gamepadStatus = createStore({ state: 'waiting', name: '' });

/** Radial dead zone with a continuous, finer-at-centre response. */
export function stickVector(x = 0, y = 0, deadzone = 0.2) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 };
  const length = Math.hypot(x, y);
  if (length <= deadzone) return { x: 0, y: 0 };
  const gain = ((Math.min(length, 1) - deadzone) / (1 - deadzone)) ** 2 / length;
  return { x: x * gain, y: y * gain };
}

/** Install after boot. Disposal removes listeners, DOM and the animation loop. */
export function installGamepad({ settings, win = window }) {
  const doc = win.document;
  if (typeof win.navigator.getGamepads !== 'function' || typeof win.PointerEvent !== 'function') {
    gamepadStatus.set({ state: 'unsupported', name: '' });
    return () => {};
  }
  const cursor = doc.createElement('div');
  cursor.className = 'gamepad-cursor';
  cursor.setAttribute('aria-hidden', 'true');
  cursor.hidden = true;
  doc.body.append(cursor);
  let x = win.innerWidth / 2, y = win.innerHeight / 2;
  let press = null, hover = null, outlined = null;
  let previous = [], padIndex = null, armed = false, suspended = !doc.hasFocus();
  let lastTime = 0, directionAt = 0, lastDirection = '', raf = 0, disposed = false;
  const removers = [];
  const on = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    removers.push(() => target.removeEventListener(type, fn, options));
  };
  const status = (state, name = '') => {
    const old = gamepadStatus.get();
    if (old.state !== state || old.name !== name) gamepadStatus.set({ state, name });
  };
  const hit = () => doc.elementFromPoint(x, y);
  const editable = () => doc.activeElement?.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  const pointer = (target, type, button = 0, buttons = 0, relatedTarget = null) => target?.dispatchEvent(new win.PointerEvent(type, {
    bubbles: !type.endsWith('enter') && !type.endsWith('leave'), cancelable: true, pointerId: 9001, pointerType: 'mouse', isPrimary: true,
    clientX: x, clientY: y, button, buttons, relatedTarget,
  }));
  const mouse = (target, type, button = 0, buttons = 0, relatedTarget = null) => target?.dispatchEvent(new win.MouseEvent(type, {
    bubbles: !type.endsWith('enter') && !type.endsWith('leave'), cancelable: true,
    clientX: x, clientY: y, button, buttons, relatedTarget,
  }));
  function transition(next) {
    if (next === hover) return;
    if (hover) {
      pointer(hover, 'pointerout', -1, 0, next);
      mouse(hover, 'mouseout', 0, 0, next);
      for (let el = hover; el && !el.contains(next); el = el.parentElement) {
        pointer(el, 'pointerleave', -1, 0, next); mouse(el, 'mouseleave', 0, 0, next);
      }
    }
    if (next) {
      pointer(next, 'pointerover', -1, 0, hover);
      mouse(next, 'mouseover', 0, 0, hover);
      for (let el = next; el && !el.contains(hover); el = el.parentElement) {
        pointer(el, 'pointerenter', -1, 0, hover); mouse(el, 'mouseenter', 0, 0, hover);
      }
    }
    outlined?.removeAttribute('data-gamepad-hover');
    outlined = next?.closest('button, a[href], input, select, summary, [role="button"]') ?? null;
    outlined?.setAttribute('data-gamepad-hover', '');
    hover = next;
  }
  function cancel() {
    const held = press;
    press = null;
    if (held) {
      pointer(held.target, 'pointercancel');
      mouse(held.target, 'mouseup');
    }
    cursor.classList.remove('is-pressed');
  }
  function hide() {
    cancel(); transition(null); cursor.hidden = true; armed = false; previous = [];
  }
  function updateRange(range) {
    const rect = range.getBoundingClientRect();
    if (!rect.width) return;
    const min = Number(range.min || 0), max = Number(range.max || 100);
    const step = range.step === 'any' ? 0 : Number(range.step || 1);
    let value = min + Math.max(0, Math.min(1, (x - rect.left) / rect.width)) * (max - min);
    if (step > 0) value = min + Math.round((value - min) / step) * step;
    const next = String(Math.max(min, Math.min(max, value)));
    if (range.value !== next) {
      range.value = next;
      range.dispatchEvent(new win.Event('input', { bubbles: true }));
    }
  }
  function move() {
    x = Math.max(1, Math.min(win.innerWidth - 2, x));
    y = Math.max(1, Math.min(win.innerHeight - 2, y));
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    const target = press?.target ?? hit();
    if (!press) transition(target);
    pointer(target, 'pointermove', -1, press ? 1 : 0);
    mouse(target, 'mousemove', 0, press ? 1 : 0);
    if (press && Math.hypot(x - press.x, y - press.y) > 6) press.moved = true;
    if (press?.range) updateRange(press.range);
  }
  function down() {
    const target = hit();
    if (!target || target.closest(':disabled, [aria-disabled="true"], [inert]')) return;
    const focus = target.closest('button, input, textarea, select, a[href], [tabindex]');
    focus?.focus({ preventScroll: true });
    const range = target.matches('input[type="range"]') ? target : null;
    press = { target, x, y, moved: false, range };
    cursor.classList.add('is-pressed');
    const allowed = pointer(target, 'pointerdown', 0, 1);
    if (allowed !== false) mouse(target, 'mousedown', 0, 1);
    if (range) updateRange(range);
  }
  function up() {
    const held = press;
    if (!held) return;
    press = null;
    cursor.classList.remove('is-pressed');
    const over = hit(); // hit-test before pointerup can open a new dialog over the release point
    pointer(held.target, 'pointerup');
    mouse(held.target, 'mouseup');
    if (!held.moved && held.target.isConnected && over && (over === held.target || held.target.contains(over))) mouse(held.target, 'click');
    if (held.range?.isConnected) held.range.dispatchEvent(new win.Event('change', { bubbles: true }));
  }
  function key(code) {
    const value = keyValueForCode(code);
    const target = doc.activeElement ?? doc.body;
    for (const type of ['keydown', 'keyup']) target.dispatchEvent(new win.KeyboardEvent(type, { key: value, code, bubbles: true, cancelable: true }));
  }
  function action(name) {
    if (editable() || press || doc.querySelector('.set-key.is-waiting')) return;
    key(settings.get().keys[name]);
  }
  function scroll(dx, dy) {
    for (let el = hit(); el; el = el.parentElement) {
      const style = win.getComputedStyle(el);
      let moved = false;
      for (const [axis, amount, overflow] of [['Top', dy, style.overflowY], ['Left', dx, style.overflowX]]) {
        if (!amount || !/auto|scroll/.test(overflow)) continue;
        const before = el[`scroll${axis}`];
        el[`scroll${axis}`] += amount;
        moved ||= el[`scroll${axis}`] !== before;
      }
      if (moved) return;
    }
  }
  function frame(time) {
    if (disposed) return;
    raf = win.requestAnimationFrame(frame);
    const dt = Math.max(0, Math.min((time - lastTime) / 1000 || 0, 0.04));
    lastTime = time;
    if (doc.hidden || suspended || settings.get().gamepadEnabled === false) { hide(); return; }
    let pads;
    try { pads = Array.from(win.navigator.getGamepads()); }
    catch { status('blocked'); hide(); return; }
    const connected = pads.filter((p) => p?.connected);
    const pad = connected.find((p) => p.index === padIndex && p.mapping === 'standard')
      ?? connected.find((p) => p.mapping === 'standard');
    if (!pad) {
      status(connected.length ? 'nonstandard' : 'waiting');
      padIndex = null; hide(); return;
    }
    status('connected', pad.id);
    const buttons = pad.buttons.map((b) => b.pressed || b.value > 0.5);
    if (padIndex !== pad.index) { hide(); padIndex = pad.index; }
    if (!armed) {
      previous = buttons;
      armed = !buttons.some(Boolean); // neutral after connecting/resuming; held buttons cannot fire
      return;
    }
    const pressed = (i) => !!buttons[i] && !previous[i];
    const released = (i) => !buttons[i] && !!previous[i];
    const left = stickVector(pad.axes[0], pad.axes[1]);
    const right = stickVector(pad.axes[2], pad.axes[3]);
    const dpad = { x: Number(!!buttons[15]) - Number(!!buttons[14]), y: Number(!!buttons[13]) - Number(!!buttons[12]) };
    const active = left.x || left.y || right.x || right.y || buttons.some(Boolean) || previous.some(Boolean);
    if (cursor.hidden && active) cursor.hidden = false;
    if (!cursor.hidden) {
      if (press && !press.target.isConnected) cancel();
      const wheel = doc.querySelector('.fwheel');
      const speed = buttons[6] ? 150 : Math.max(450, Math.min(1000, win.innerWidth * 0.55));
      x += (left.x + (wheel ? 0 : dpad.x * 0.25)) * speed * dt;
      y += (left.y + (wheel ? 0 : dpad.y * 0.25)) * speed * dt;
      move();
      if (wheel && !press) {
        const sx = dpad.x || left.x, sy = dpad.y || left.y;
        const direction = Math.abs(sx) > Math.abs(sy) ? (sx > 0 ? 'ArrowRight' : sx < 0 ? 'ArrowLeft' : '')
          : (sy > 0 ? 'ArrowDown' : sy < 0 ? 'ArrowUp' : '');
        if (direction && (direction !== lastDirection || time - directionAt > 160)) {
          key(direction); lastDirection = direction; directionAt = time;
        }
        if (!direction) lastDirection = '';
      } else lastDirection = '';
      if (!press) scroll(right.x * 650 * dt, right.y * 650 * dt);
      if (pressed(1)) { cancel(); key('Escape'); }
      else {
        if (pressed(0)) {
          if (wheel) { if (doc.activeElement !== wheel) wheel.focus({ preventScroll: true }); key('Enter'); }
          else down();
        }
        if (released(0)) up();
        if (pressed(7) && !press) {
          const target = hit();
          pointer(target, 'pointerdown', 2, 2); mouse(target, 'mousedown', 2, 2);
          pointer(target, 'pointerup', 2); mouse(target, 'mouseup', 2); mouse(target, 'contextmenu', 2);
        }
        if (pressed(2)) action('refresh');
        if (pressed(3)) action('buy');
        if (pressed(4)) action('freeze');
        if (pressed(5)) action('levelUp');
        if (pressed(9)) action('ready');
      }
    }
    previous = buttons;
  }
  const physicalPointer = (e) => { if (e.isTrusted) hide(); };
  on(win, 'pointermove', physicalPointer, true);
  on(win, 'pointerdown', physicalPointer, true);
  on(win, 'blur', () => { suspended = true; hide(); });
  on(win, 'focus', () => { suspended = false; hide(); });
  on(doc, 'visibilitychange', hide);
  on(win, 'gamepaddisconnected', (e) => { if (e.gamepad.index === padIndex) { padIndex = null; hide(); } });
  const offSettings = settings.subscribe((s) => { if (s.gamepadEnabled === false) hide(); });
  raf = win.requestAnimationFrame(frame);
  return () => {
    disposed = true; win.cancelAnimationFrame(raf);
    hide(); cursor.remove(); offSettings(); removers.forEach((off) => off());
  };
}
