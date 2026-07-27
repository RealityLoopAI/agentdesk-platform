import { describe, expect, it } from 'bun:test';

import { defaultMockResponse } from './mock.js';

describe('MockProvider deterministic response marker', () => {
  it('returns a marked response so real-container E2E can exercise A2A output', () => {
    expect(
      defaultMockResponse('User input\n[mock-response]<message to="worker">delegate</message>[/mock-response]\nEnd'),
    ).toBe('<message to="worker">delegate</message>');
  });

  it('decodes formatter entities inside the explicit test marker', () => {
    expect(
      defaultMockResponse(
        '[mock-response]&lt;message to=&quot;worker&quot;&gt;A &amp; B&lt;/message&gt;[/mock-response]',
      ),
    ).toBe('<message to="worker">A & B</message>');
  });

  it('keeps the historical canned response when no marker exists', () => {
    expect(defaultMockResponse('hello')).toBe('Mock response to: hello');
  });
});
