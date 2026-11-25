import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate } from "react-router";
import { Button } from "@/components/ui/button";
import { useMe } from "@/lib/auth/me";
import { backFromKeystone, keystoneUrl, leaveForKeystone } from "@/lib/auth/keystone";
import { here, returnTo } from "@/lib/auth/returnTo";
import { cognito, cognitoOn, signOut } from "@/lib/auth/token";
import { ApiError } from "@/lib/api/types";

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md space-y-4 rounded-xl border bg-white p-8 text-center shadow-sm">
        <div className="font-display text-3xl leading-none tracking-[4px]">
          <span className="text-brand">DOLPHIN</span> TRACKER
        </div>
        <h1 className="text-lg font-semibold">{title}</h1>
        <div className="space-y-3 text-sm text-slate-600">{children}</div>
      </div>
    </div>
  );
}

const Waiting = ({ children = "Loading…" }: { children?: ReactNode }) => (
  <div className="p-10 text-center font-mono text-sm text-slate-500">{children}</div>
);

/** `signed-out`: not signed in, on a site that signs in through Keystone: Tracker's own sign-in page shows, with
 *  the way there. `starting`: restoring the session or finishing the redirect back from the login. `leaving`: on the way to the
 *  managed login. `failed`: came back from it still not signed in (or the site is not set up), so no second trip. */
type SignIn = "starting" | "signed-in" | "signed-out" | "leaving" | "failed";

/** The session of the shared Dolphin Nexus login. Nobody clicks "Sign in": not signed in means going straight to
 *  the managed login, unless that was just tried, which is said instead of tried again in a loop. */
function useSignIn(): { state: SignIn; why: string; goToSignIn: (again?: boolean) => void } {
  const on = cognitoOn();
  const [state, setState] = useState<SignIn>(on ? "starting" : "signed-in");
  const [why, setWhy] = useState("");
  const goToSignIn = (again = false) => {
    setState("leaving");
    void cognito().then(async (auth) => {
      if (await auth.signIn(here(), again)) return; // the page is leaving
      setWhy(auth.missingConfig() ? `Sign-in is not set up for this site (${auth.missingConfig()}).` : auth.signInFailure());
      setState("failed");
    });
  };
  useEffect(() => {
    if (!on) return;
    let live = true;
    void cognito()
      .then((auth) => (auth.missingConfig() ? false : auth.init()))
      .then((signedIn) => {
        if (!live) return;
        if (signedIn) setState("signed-in");
        // Through Keystone: say so and let them go there. Back from it, the shared login knows them: finish here.
        else if (keystoneUrl() && !backFromKeystone()) setState("signed-out");
        else goToSignIn();
      });
    return () => {
      live = false;
    };
  }, [on]); // once, when the app starts
  return { state, why, goToSignIn };
}

/** Nothing of the app shows until the server has said who is signed in. No sign-in (or one the server no longer
 *  takes) goes to the shared login; an account with no role here is told so. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const on = cognitoOn();
  const { state, why, goToSignIn } = useSignIn();
  const me = useMe(state === "signed-in");
  const client = useQueryClient();
  const status = me.error instanceof ApiError ? me.error.status : null;
  const answered = me.data !== undefined || status === 403;
  useEffect(() => {
    // The server knows this person: the trip to the login worked, so a later one may be made without asking.
    if (on && answered) void cognito().then((auth) => auth.signInSettled());
  }, [on, answered]);
  useEffect(() => {
    // The server will not take the token, even renewed (the API client tried): sign in again.
    if (on && state === "signed-in" && status === 401) goToSignIn();
  }, [on, state, status]);

  if (state === "failed") {
    return (
      <Notice title="Sign-in did not complete">
        <p>{why || "Dolphin Tracker could not sign you in with your Dolphin Nexus login."}</p>
        <Button size="lg" onClick={() => goToSignIn(true)}>
          Try again
        </Button>
      </Notice>
    );
  }
  if (state === "signed-out") {
    return (
      <Notice title="Sign in to Dolphin Tracker">
        <p>Tracker uses your Dolphin Keystone sign-in: one account for every Dolphin app.</p>
        <Button size="lg" onClick={leaveForKeystone}>
          Sign in through Keystone
        </Button>
        <p className="text-xs text-slate-500">You come back to this page once you are signed in.</p>
      </Notice>
    );
  }
  if (state === "leaving") return <Waiting>Taking you to the Dolphin sign-in…</Waiting>;
  if (state === "starting") return <Waiting />;
  if (me.data) return <>{children}</>;
  if (me.isPending) return <Waiting />;
  if (status === 401) {
    if (on) return <Waiting>Taking you to the Dolphin sign-in…</Waiting>;
    return (
      <Notice title="Sign-in is not set up">
        <p>The server asks for a sign-in, but this site was built without one.</p>
        <p className="text-amber-700">Set VITE_AUTH_MODE=cognito and the VITE_COGNITO_* values for this site.</p>
      </Notice>
    );
  }
  if (status === 403) {
    return (
      <Notice title="No access to Dolphin Tracker">
        <p>{me.error?.message}</p>
        <p>Ask an admin to give your account a role for Dolphin Tracker in Dolphin Nexus.</p>
        {on && (
          <Button variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        )}
      </Notice>
    );
  }
  return (
    <Notice title="Could not reach Dolphin Tracker">
      <p>{me.error?.message ?? "The server did not answer."}</p>
      <Button variant="outline" onClick={() => void client.invalidateQueries({ queryKey: ["me"] })}>
        Try again
      </Button>
    </Notice>
  );
}

/** /auth/callback: where the managed login sends people back. By the time this shows, the code is exchanged and
 *  the server has said who they are, so all that is left is the page they were on. */
export function AuthCallback() {
  return <Navigate to={returnTo()} replace />;
}
