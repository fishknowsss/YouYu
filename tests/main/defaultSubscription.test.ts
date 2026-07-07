import { describe, expect, it } from 'vitest';
import { resolveDefaultSubscriptionUrl } from '../../src/main/defaultSubscription';

describe('default subscription', () => {
  it('keeps an empty bundled resource empty for public builds', () => {
    expect(resolveDefaultSubscriptionUrl('')).toBe('');
    expect(resolveDefaultSubscriptionUrl('   ')).toBe('');
  });

  it('keeps a bundled subscription resource when one is present', () => {
    expect(resolveDefaultSubscriptionUrl(' https://example.com/sub \n')).toBe('https://example.com/sub');
  });
});
