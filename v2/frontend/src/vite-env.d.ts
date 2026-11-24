/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** "cognito": sign in through the shared Dolphin Nexus login. Anything else: no login (local work). */
  readonly VITE_AUTH_MODE?: string;
  readonly VITE_COGNITO_USER_POOL_ID?: string;
  readonly VITE_COGNITO_CLIENT_ID?: string;
  /** The managed login's domain, without https://. */
  readonly VITE_COGNITO_DOMAIN?: string;
  /** "Google" goes straight to Google; empty shows the login page with Google and the password form. */
  readonly VITE_COGNITO_PROVIDER?: string;
  readonly VITE_GOOGLE_MAPS_BROWSER_KEY?: string;
}
