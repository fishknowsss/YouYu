import { describe, expect, it } from 'vitest';
import { createNodeSwitchCooldown } from '../../src/main/nodeSwitchCooldown';

describe('createNodeSwitchCooldown', () => {
  it('keeps a recently abandoned node out of the next same-region recovery', () => {
    let now = 1_000;
    const cooldown = createNodeSwitchCooldown({
      cooldownMs: 15 * 60 * 1000,
      now: () => now
    });

    cooldown.remember('日本 春日野 悠');

    expect(cooldown.avoidWith('日本 春日野 穹')).toEqual(['日本 春日野 穹', '日本 春日野 悠']);

    now += 15 * 60 * 1000 - 1;
    expect(cooldown.avoidWith('日本 春日野 穹')).toContain('日本 春日野 悠');

    now += 1;
    expect(cooldown.avoidWith('日本 春日野 穹')).toEqual(['日本 春日野 穹']);
  });
});
