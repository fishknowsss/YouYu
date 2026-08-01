import { describe, expect, it } from 'vitest';
import { ruleProfileOptions } from '../../src/renderer/pages/Settings';

describe('settings rule profiles', () => {
  it('offers only smart rules and airport rules', () => {
    expect(ruleProfileOptions).toEqual([
      { value: 'ruleset', label: '智能规则' },
      { value: 'subscription', label: '机场规则' }
    ]);
  });
});
