import { describe, expect, it } from 'vitest';
import { receptionistName } from '../src/lib/receptionist-name.js';

describe('receptionistName', () => {
  it('uses the name the owner chose, trimmed', () => {
    expect(receptionistName({ name: '  Maya ' })).toBe('Maya');
  });

  it('falls back to Blake when there is no usable name', () => {
    expect(receptionistName(undefined)).toBe('Blake');
    expect(receptionistName(null)).toBe('Blake');
    expect(receptionistName({})).toBe('Blake');
    expect(receptionistName({ name: '   ' })).toBe('Blake');
    expect(receptionistName(/** @type {any} */ ({ name: 42 }))).toBe('Blake');
  });
});
