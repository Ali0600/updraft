import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/index.js';

describe('cli program', () => {
  it('exposes the ota program name', () => {
    expect(buildProgram().name()).toBe('ota');
  });
});
