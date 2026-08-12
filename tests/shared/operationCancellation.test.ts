import { describe, expect, it } from 'vitest';
import { isExpectedOperationCancellation } from '../../src/shared/operationCancellation';

describe('expected operation cancellation', () => {
  it.each([
    new Error('operation replaced'),
    new Error('remote refresh superseded by manual refresh'),
    new DOMException('This operation was aborted', 'AbortError'),
    new Error('outer failure', { cause: new Error('operation canceled') }),
    new AggregateError([new Error('operation canceled'), new Error('operation replaced')], 'planned handoff')
  ])('recognizes planned ownership handoffs', (error) => {
    expect(isExpectedOperationCancellation(error)).toBe(true);
  });

  it.each([
    new Error('connection aborted by peer'),
    new Error('The operation was aborted due to timeout'),
    new AggregateError([new Error('operation canceled'), new Error('proxy rollback failed')], 'rollback failed'),
    new AggregateError(
      [new Error('operation canceled'), new Error('proxy rollback failed')],
      'operation canceled and rollback failed'
    ),
    new Error('request timed out')
  ])('does not hide operational failures', (error) => {
    expect(isExpectedOperationCancellation(error)).toBe(false);
  });
});
