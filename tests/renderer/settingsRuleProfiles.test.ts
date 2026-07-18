import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('settings rule profiles', () => {
  it('offers only smart rules and airport rules', async () => {
    const source = await readFile('src/renderer/pages/Settings.tsx', 'utf8');

    expect(source.match(/<option value=/g)).toHaveLength(6);
    expect(source).toContain('<option value="ruleset">智能规则</option>');
    expect(source).toContain('<option value="subscription">机场规则</option>');
    expect(source).not.toContain('<option value="smart">');
    expect(source).not.toContain('<option value="global">');
    expect(source).not.toContain('兼容机场');
  });
});
