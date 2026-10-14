import { describe, it, expect } from 'vitest';

import { db } from '@/db';
import { serializeContact, findOrCreateContact, ContactError } from './contacts';

describe('serializeContact', () => {
  it('projects the public shape with tags and ISO timestamps', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const updated = new Date('2026-01-02T00:00:00Z');
    const row = {
      id: 'c1',
      userId: 'u1',
      accountId: 'a1',
      phone: '+14155550123',
      phoneNormalized: '14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatarUrl: null,
      createdAt: created,
      updatedAt: updated,
    };
    expect(serializeContact(row, [{ id: 't1', name: 'vip', color: '#fff' }])).toEqual({
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      tags: [{ id: 't1', name: 'vip', color: '#fff' }],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    });
  });
});

describe('findOrCreateContact', () => {
  it('rejects a non-E.164 phone with a 400 ContactError before touching the database', async () => {
    const attempt = findOrCreateContact(db, 'acc', 'user', { phone: 'not-a-number' });
    await expect(attempt).rejects.toBeInstanceOf(ContactError);
    await expect(
      findOrCreateContact(db, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toMatchObject({ status: 400 });
  });
});
