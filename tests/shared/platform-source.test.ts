import { describe, expect, it } from 'bun:test';
import { normalizePlatformSource, sortPlatformSources } from '../../src/shared/platform-source.js';

describe('normalizePlatformSource', () => {
  it('normalizes Devin sources', () => {
    expect(normalizePlatformSource('devin-cli')).toBe('devin');
    expect(normalizePlatformSource('Devin for Terminal')).toBe('devin');
  });
});

describe('sortPlatformSources', () => {
  it('keeps Devin after the established high-priority sources', () => {
    expect(sortPlatformSources(['zed', 'devin', 'claude', 'cursor', 'codex'])).toEqual([
      'claude',
      'codex',
      'cursor',
      'devin',
      'zed',
    ]);
  });
});
