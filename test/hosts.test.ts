import { describe, expect, it } from 'vitest';
import { sameOrigin } from '../src/shared/hosts';

describe('sameOrigin', () => {
  it('accepts URLs on the API host', () => {
    expect(sameOrigin('https://api.github.com/repos/o/r/pulls/1', 'https://api.github.com')).toBe(true);
    expect(sameOrigin('https://github.acme.corp/api/graphql', 'https://github.acme.corp/api/v3')).toBe(true);
  });

  it('rejects a path that changes the host when appended to the API base', () => {
    expect(sameOrigin('https://api.github.com' + '.evil.com/x', 'https://api.github.com')).toBe(false);
    expect(sameOrigin('https://api.github.com' + '@evil.com/x', 'https://api.github.com')).toBe(false);
  });

  it('rejects a pagination link to another host', () => {
    expect(sameOrigin('https://evil.com/repos/o/r/pulls?page=2', 'https://api.github.com')).toBe(false);
  });
});
