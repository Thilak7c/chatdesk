import { describe, expect, it } from 'vitest';

import {
  renderTemplateBody,
  templateBodyParams,
  templateContentText,
} from './template-body';
import type { MessageTemplate } from '@/types';

function row(over: Partial<MessageTemplate>): MessageTemplate {
  return {
    id: 'tpl-1',
    user_id: 'u-1',
    name: 'order_update',
    category: 'Utility',
    language: 'en_US',
    body_text: 'Your order {{1}} ships on {{2}}',
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  } as MessageTemplate;
}

describe('renderTemplateBody', () => {
  it('substitutes positional placeholders', () => {
    expect(
      renderTemplateBody('Your order {{1}} ships on {{2}}', ['A123', 'Friday'])
    ).toBe('Your order A123 ships on Friday');
  });

  it('leaves a placeholder visible when the param is missing', () => {
    expect(renderTemplateBody('Hi {{1}}, code {{2}}', ['Sam'])).toBe(
      'Hi Sam, code {{2}}'
    );
  });

  it('handles a body with no placeholders and repeated indexes', () => {
    expect(renderTemplateBody('No variables here', ['x'])).toBe(
      'No variables here'
    );
    expect(renderTemplateBody('{{1}} and {{1}}', ['twice'])).toBe(
      'twice and twice'
    );
  });
});

describe('templateBodyParams', () => {
  it('prefers structured body values over the legacy array', () => {
    expect(templateBodyParams(['legacy'], { body: ['structured'] })).toEqual([
      'structured',
    ]);
  });

  it('falls back to the legacy array when structured body is absent', () => {
    expect(templateBodyParams(['a', 'b'], { headerText: 'x' })).toEqual([
      'a',
      'b',
    ]);
    expect(templateBodyParams(['a'], undefined)).toEqual(['a']);
  });

  it('returns an empty array for junk input', () => {
    expect(templateBodyParams(null, null)).toEqual([]);
    expect(templateBodyParams(undefined, { body: 'not-an-array' })).toEqual([]);
  });

  it('drops non-string entries from the structured body', () => {
    expect(templateBodyParams([], { body: ['ok', 7, null] })).toEqual(['ok']);
  });
});

describe('templateContentText', () => {
  it('renders the substituted body from the local row', () => {
    expect(templateContentText(row({}), ['A123', 'Friday'])).toBe(
      'Your order A123 ships on Friday'
    );
  });

  it("prefers the caller's pre-rendered text (the dashboard composer)", () => {
    expect(
      templateContentText(row({}), ['A123', 'Friday'], 'composer rendered')
    ).toBe('composer rendered');
  });

  it('is null when there is no local row to render from', () => {
    expect(templateContentText(null, ['A123'])).toBeNull();
  });
});
