let accessToken: string | null = null;

/** Set by the auth provider; read by the API client. Cognito wires this up in Phase 6. */
export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}
