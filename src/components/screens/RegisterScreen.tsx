import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { AccountBannedError, register } from '../../net/AuthClient';
import { formatBannedError } from '../../net/formatBannedError';
import { LoginScene } from '../../scenes/LoginScene';
import type { SceneManager } from '../../scenes/SceneManager';
import './AuthScreen.css';

/** Below this, reject client-side before ever hitting the network - purely a sanity floor, not a real password-strength policy (there's no real account system to protect yet, see this component's own doc comment). */
const MIN_PASSWORD_LENGTH = 4;

export interface RegisterScreenProps {
  sceneManager: SceneManager;
  /** Registration auto-logs-in on success (see net/AuthClient.ts's register()) - same token shape/purpose as LoginScreen's onLoggedIn. */
  onRegistered: (token: string) => void;
  /** Switches back to LoginScreen (same background scene, different form/endpoint). */
  onSwitchToLogin: () => void;
}

/**
 * Account creation - same demo-auth backend as LoginScreen (no real
 * persisted user table as of writing, see AuthClient.register()'s doc
 * comment), so this doesn't yet do anything a plain login couldn't; it
 * exists so the client/backend contract (a real POST /register, real
 * validation, a real issued session token) is in place ahead of the
 * backend adding actual account persistence/uniqueness checks behind it.
 */
export default function RegisterScreen({ sceneManager, onRegistered, onSwitchToLogin }: RegisterScreenProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const domElement = sceneManager.renderer.domElement;
    const loginScene = new LoginScene(domElement.clientWidth / domElement.clientHeight);
    // Disposal is SceneManager's job once this scene is superseded (by
    // whichever screen's mount effect calls setScene() next) or on full app
    // unmount - see the equivalent note in RfViewer's mount effect.
    void sceneManager.setScene(loginScene);
  }, [sceneManager]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isRegistering) return;

    if (!username.trim()) {
      setError('Username is required.');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setIsRegistering(true);
    setError('');
    register(username, password)
      .then((result) => onRegistered(result.token))
      .catch((err: unknown) => {
        setError(err instanceof AccountBannedError ? formatBannedError(err) : err instanceof Error ? err.message : 'Registration failed');
        setIsRegistering(false);
      });
  };

  return (
    <div className="auth-screen">
      <form className="auth-screen-panel" onSubmit={handleSubmit}>
        <h1>Create Account</h1>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus disabled={isRegistering} />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={isRegistering}
          />
        </label>
        <label>
          Confirm Password
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={isRegistering}
          />
        </label>
        <button type="submit" disabled={isRegistering}>
          {isRegistering ? 'Creating account…' : 'Register'}
        </button>
        {error && <p className="auth-screen-error">{error}</p>}
        <button type="button" className="auth-screen-switch" onClick={onSwitchToLogin} disabled={isRegistering}>
          Already have an account? Log in
        </button>
        <p className="auth-screen-hint">Demo registration - any username/password creates a session.</p>
      </form>
    </div>
  );
}
