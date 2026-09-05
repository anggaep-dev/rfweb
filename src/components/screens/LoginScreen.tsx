import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { AccountBannedError, login } from '../../net/AuthClient';
import { formatBannedError } from '../../net/formatBannedError';
import { LoginScene } from '../../scenes/LoginScene';
import type { SceneManager } from '../../scenes/SceneManager';
import './AuthScreen.css';

export interface LoginScreenProps {
  sceneManager: SceneManager;
  /** The session token issued by a successful login - pass this on to OnlineScreen so the WS connection can authenticate. */
  onLoggedIn: (token: string) => void;
  /** Switches to RegisterScreen (same background scene, different form/endpoint). */
  onSwitchToRegister: () => void;
}

export default function LoginScreen({ sceneManager, onLoggedIn, onSwitchToRegister }: LoginScreenProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
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
    if (!username.trim() || isLoggingIn) return;
    setIsLoggingIn(true);
    setError('');
    // No real account system on the backend yet - any non-empty username/
    // password logs in, but this is now a real network round-trip against
    // the game server (not a client-only fake), issuing a real session
    // token the WS connection authenticates with - see net/AuthClient.ts.
    login(username, password)
      .then((result) => onLoggedIn(result.token))
      .catch((err: unknown) => {
        setError(err instanceof AccountBannedError ? formatBannedError(err) : err instanceof Error ? err.message : 'Login failed');
        setIsLoggingIn(false);
      });
  };

  return (
    <div className="auth-screen">
      <form className="auth-screen-panel" onSubmit={handleSubmit}>
        <h1>RF Web</h1>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus disabled={isLoggingIn} />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={isLoggingIn}
          />
        </label>
        <button type="submit" disabled={isLoggingIn}>
          {isLoggingIn ? 'Logging in…' : 'Log in'}
        </button>
        {error && <p className="auth-screen-error">{error}</p>}
        <button type="button" className="auth-screen-switch" onClick={onSwitchToRegister} disabled={isLoggingIn}>
          Don't have an account? Register
        </button>
        <p className="auth-screen-hint">Demo login - any username/password logs in.</p>
      </form>
    </div>
  );
}
