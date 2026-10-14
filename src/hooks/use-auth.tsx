// src/hooks/use-auth.tsx

"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { DEFAULT_CURRENCY } from "@/lib/currency";
import {
  canEditSettings as canEditSettingsFor,
  canManageMembers as canManageMembersFor,
  canSendMessages as canSendMessagesFor,
  isAccountRole,
  type AccountRole,
} from "@/lib/auth/roles";

interface Profile {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  beta_features: string[];
  account_id: string | null;
  account_role: AccountRole | null;
}

interface AccountSummary {
  id: string;
  name: string;
  default_currency: string;
}

export type AccountStatus = "loading" | "ready" | "unlinked" | "error";

interface SimpleUser {
  id: string;
  email: string | null;
  created_at?: string | null;
}

interface AuthContextValue {
  user: SimpleUser | null;
  profile: Profile | null;
  loading: boolean;
  profileLoading: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  accountStatus: AccountStatus;
  accountStatusDetail: string | null;
  accountId: string | null;
  accountRole: AccountRole | null;
  account: AccountSummary | null;
  defaultCurrency: string;
  isOwner: boolean;
  isAdmin: boolean;
  isAgent: boolean;
  isViewer: boolean;
  canManageMembers: boolean;
  canEditSettings: boolean;
  canSendMessages: boolean;
}

/** Shape of GET /api/account/me. */
interface MeResponse {
  user: SimpleUser;
  profile: {
    id: string;
    full_name: string | null;
    email: string;
    avatar_url: string | null;
    role: string | null;
    beta_features: string[] | null;
    account_id: string | null;
    account_role: string | null;
  } | null;
  account: AccountSummary | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const PROFILE_FETCH_ATTEMPTS = 2;
const PROFILE_FETCH_RETRY_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * AuthProvider — wrap this around the dashboard layout.
 *
 * Bootstraps from `/api/account/me`, which validates the session
 * cookie against the database and returns user + profile + account
 * in one call. A 401 means "not signed in".
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SimpleUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);

  const fetchMe = useCallback(async () => {
    setProfileLoading(true);
    setStatusDetail(null);
    try {
      let data: MeResponse | null = null;
      for (let attempt = 1; ; attempt++) {
        const res = await fetch("/api/account/me", { cache: "no-store" });
        if (res.status === 401) {
          setUser(null);
          setProfile(null);
          setAccount(null);
          return;
        }
        if (res.ok) {
          data = await res.json();
          break;
        }
        console.error("[AuthProvider] /api/account/me error:", res.status);
        if (attempt < PROFILE_FETCH_ATTEMPTS) {
          await sleep(PROFILE_FETCH_RETRY_MS);
          continue;
        }
        setStatusDetail(`request failed with status ${res.status}`);
        return;
      }

      setUser(data!.user);
      if (data?.profile) {
        const p = data.profile;
        const accountRole = isAccountRole(p.account_role) ? p.account_role : null;

        setProfile({
          id: p.id,
          full_name: p.full_name,
          email: p.email,
          avatar_url: p.avatar_url,
          role: p.role,
          beta_features: p.beta_features ?? [],
          account_id: p.account_id ?? null,
          account_role: accountRole,
        });
        setAccount(data.account ?? null);

        if (!p.account_id || !accountRole) {
          setStatusDetail(
            `profile ${p.id} has no ${!p.account_id ? "account_id" : "account_role"}`,
          );
        }
      } else {
        setProfile(null);
        setStatusDetail("no profiles row for the signed-in user");
      }
    } catch (err) {
      console.error("[AuthProvider] fetchMe threw:", err);
      setStatusDetail(err instanceof Error ? err.message : "profile fetch failed");
    } finally {
      setProfileLoading(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  const signOut = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      setUser(null);
      setProfile(null);
      setAccount(null);
      window.location.href = "/login";
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    await fetchMe();
  }, [fetchMe]);

  const derived = useMemo(() => {
    const role = profile?.account_role ?? null;
    return {
      accountRole: role,
      accountId: profile?.account_id ?? null,
      isOwner: role === "owner",
      isAdmin: role === "admin",
      isAgent: role === "agent",
      isViewer: role === "viewer",
      canManageMembers: role ? canManageMembersFor(role) : false,
      canEditSettings: role ? canEditSettingsFor(role) : false,
      canSendMessages: role ? canSendMessagesFor(role) : false,
    };
  }, [profile?.account_role, profile?.account_id]);

  const accountStatus: AccountStatus = !user
    ? "loading"
    : profileLoading
      ? "loading"
      : !profile
        ? "error"
        : derived.accountId && derived.accountRole
          ? "ready"
          : "unlinked";

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        profileLoading,
        signOut,
        refreshProfile,
        account,
        defaultCurrency: account?.default_currency ?? DEFAULT_CURRENCY,
        accountStatus,
        accountStatusDetail: statusDetail,
        ...derived,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    return {
      user: null,
      profile: null,
      loading: false,
      profileLoading: false,
      signOut: async () => {
        window.location.href = "/login";
      },
      refreshProfile: async () => {},
      account: null,
      defaultCurrency: DEFAULT_CURRENCY,
      accountStatus: "loading",
      accountStatusDetail: null,
      accountId: null,
      accountRole: null,
      isOwner: false,
      isAdmin: false,
      isAgent: false,
      isViewer: false,
      canManageMembers: false,
      canEditSettings: false,
      canSendMessages: false,
    };
  }
  return ctx;
}