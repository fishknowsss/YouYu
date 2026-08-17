import { describe, expect, it } from 'vitest';
import { isActionErrorMessage } from '../../src/renderer/actionMessages';

describe('renderer action messages', () => {
  it.each(['操作失败', '操作超时', '没有可用节点', '口令不对', '请求太频繁', '请重新登记'])(
    'treats %s as an error',
    (message) => {
      expect(isActionErrorMessage(message)).toBe(true);
    }
  );

  it.each(['已同步', '已保存', '已修复', '已取消', '已停止', '日本节点均不可用，已自动切换至美国节点'])(
    'keeps %s as a non-error status',
    (message) => {
      expect(isActionErrorMessage(message)).toBe(false);
    }
  );
});
