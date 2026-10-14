// src/components/layout/account-access-alert.tsx

"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, TriangleAlert } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";

/**
 * Tells the user when their account context didn't resolve.
 *
 * Without it the app looks completely normal and simply refuses to
 * save anything: the API rejects every write that has no account
 * context to check against, and `useCan` returns false for every
 * capability when the role is null, so buttons sit disabled with no
 * explanation — "nothing saves, nothing changes, all blocked", with
 * no visible cause.
 *
 * Renders nothing on the happy path.
 */
export function AccountAccessAlert() {
  const { accountStatus, accountStatusDetail, refreshProfile } = useAuth();
  const t = useTranslations("AccountAccess");
  const [retrying, setRetrying] = useState(false);

  if (accountStatus === "loading" || accountStatus === "ready") return null;

  const retry = async () => {
    setRetrying(true);
    try {
      await refreshProfile();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Alert variant="destructive" className="mb-4">
      <TriangleAlert />
      <AlertTitle>
        {accountStatus === "unlinked" ? t("unlinkedTitle") : t("errorTitle")}
      </AlertTitle>
      <AlertDescription>
        {accountStatus === "unlinked" ? t("unlinkedBody") : t("errorBody")}
        {accountStatusDetail ? (
          // The raw reason, so a self-hoster reading a bug report has
          // something to act on instead of just "it's broken".
          <span className="mt-1 block font-mono text-xs opacity-70">
            {accountStatusDetail}
          </span>
        ) : null}
      </AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" onClick={retry} disabled={retrying}>
          {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {t("retry")}
        </Button>
      </AlertAction>
    </Alert>
  );
}
