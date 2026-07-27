export interface PublicBranding {
  displayName: string;
  logoPath: string;
  theme: {
    brandPrimary: string;
    brandPrimaryHover: string;
    brandPrimaryActive: string;
    brandSurfaceSubtle: string;
    brandBorder: string;
    canvas: string;
    surface: string;
    border: string;
    textPrimary: string;
    textSecondary: string;
    statusSuccess: string;
    statusWarning: string;
    statusDanger: string;
  };
}

export interface CurrentUser {
  id: string;
  kind: string;
  displayName: string | null;
}

export interface MeResponse {
  user: CurrentUser;
  csrfToken: string;
  sessionExpiresAt: string;
}
