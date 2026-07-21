import { describe, expect, it } from 'vitest';
import { ControlService } from '../src/auth/control.js';

describe('ControlService', () => {
  it('keeps one client active, supports takeover, and expires abandoned control', () => {
    let now = 1_000;
    const control = new ControlService(() => now, 100);
    expect(control.connect('first')).toBe(true);
    expect(control.connect('second')).toBe(false);
    expect(control.active('first')).toBe(true);
    control.take('second');
    expect(control.active('first')).toBe(false);
    expect(control.active('second')).toBe(true);
    now += 101;
    expect(control.connect('first')).toBe(true);
  });
});
