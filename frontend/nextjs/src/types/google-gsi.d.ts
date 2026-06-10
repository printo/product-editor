// Minimal type surface for Google Identity Services (the "Sign in with Google"
// button loaded from https://accounts.google.com/gsi/client). Only the members
// the login page uses are declared. See:
// https://developers.google.com/identity/gsi/web/reference/js-reference

interface GoogleIdCredentialResponse {
  credential?: string; // the Google ID token (a JWT)
  select_by?: string;
}

interface GoogleIdConfiguration {
  client_id: string;
  callback: (response: GoogleIdCredentialResponse) => void;
  hd?: string; // Workspace hosted-domain hint (advisory only)
  ux_mode?: 'popup' | 'redirect';
  auto_select?: boolean;
  nonce?: string;
  use_fedcm_for_prompt?: boolean;
}

interface GoogleIdButtonOptions {
  type?: 'standard' | 'icon';
  theme?: 'outline' | 'filled_blue' | 'filled_black';
  size?: 'small' | 'medium' | 'large';
  text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
  shape?: 'rectangular' | 'pill' | 'circle' | 'square';
  logo_alignment?: 'left' | 'center';
  width?: number | string;
}

interface Window {
  google?: {
    accounts: {
      id: {
        initialize: (config: GoogleIdConfiguration) => void;
        renderButton: (parent: HTMLElement, options: GoogleIdButtonOptions) => void;
        prompt: () => void;
        cancel: () => void;
        disableAutoSelect: () => void;
      };
    };
  };
}
