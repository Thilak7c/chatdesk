// src/components/settings/profile-form.tsx

'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Trash2, CircleAlert } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@/components/ui/avatar';
import { Card, CardContent } from '@/components/ui/card';
import { useTranslations } from 'next-intl';
import { SettingsPanelHead } from './settings-panel-head';

export function ProfileForm() {
  const t = useTranslations('Settings.profile');
  const { user, profile, refreshProfile } = useAuth();

  const [fullName, setFullName] = useState('');
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setFullName(profile.full_name ?? '');
  }, [profile]);

  const currentAvatar = !removeAvatar ? profile?.avatar_url ?? null : null;

  const initial = (fullName || profile?.full_name || profile?.email || 'U')
    .charAt(0)
    .toUpperCase();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !profile) return;

    const trimmedName = fullName.trim();
    if (!trimmedName) {
      toast.error(t('nameRequired'));
      return;
    }

    setSaving(true);
    try {
      const body: { full_name: string; avatar_url?: null } = {
        full_name: trimmedName,
      };
      if (removeAvatar) body.avatar_url = null;

      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          t('saveFailed', { message: data?.error ?? res.statusText }),
        );
      }

      setRemoveAvatar(false);
      await refreshProfile();
      toast.success(t('profileSaved'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    !!profile && (fullName.trim() !== (profile.full_name ?? '') || removeAvatar);

  const joined = user?.created_at
    ? new Date(user.created_at).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : '—';

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
      />
      <form onSubmit={onSubmit} className="space-y-4">
        <Card>
          <CardContent className="space-y-6">
            <div className="flex flex-wrap items-center gap-5">
              <Avatar size="lg" className="size-16">
                {currentAvatar ? (
                  <AvatarImage src={currentAvatar} alt={fullName || 'Avatar'} />
                ) : null}
                <AvatarFallback className="bg-primary/10 text-base text-primary">
                  {initial}
                </AvatarFallback>
              </Avatar>

              {currentAvatar && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setRemoveAvatar(true)}
                  disabled={saving}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Trash2 className="size-4" />
                  {t('remove')}
                </Button>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="profile-full-name" className="text-foreground">
                {t('displayName')}
              </Label>
              <Input
                id="profile-full-name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Ada Lovelace"
                maxLength={120}
                disabled={saving}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="profile-email" className="text-foreground">
                {t('email')}
              </Label>
              <Input
                id="profile-email"
                type="email"
                value={profile?.email ?? ''}
                disabled
                readOnly
              />
            </div>

            <div className="rounded-lg border border-border bg-muted p-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t('accountDetails')}
              </p>
              <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">{t('role')}</dt>
                  <dd className="mt-0.5 font-mono text-foreground">
                    {profile?.role ?? 'user'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('joined')}</dt>
                  <dd className="mt-0.5 text-foreground">{joined}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">{t('userId')}</dt>
                  <dd className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
                    {user?.id ?? '—'}
                  </dd>
                </div>
              </dl>
            </div>

            {!profile && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CircleAlert className="size-4" />
                {t('loading')}
              </p>
            )}
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" disabled={saving || !dirty || !profile}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('saveChanges')
            )}
          </Button>
        </div>
      </form>
    </section>
  );
}