import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { LoginScene } from './LoginScene';
import type { SceneManager } from './SceneManager';
import './LoginScreen.css';

export interface LoginScreenProps {
  sceneManager: SceneManager;
  onLoggedIn: () => void;
}

export default function LoginScreen({ sceneManager, onLoggedIn }: LoginScreenProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

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
    // No real auth backend here - any non-empty username is accepted. This
    // screen exists to demonstrate the login -> character-select -> viewer
    // scene flow, not to authenticate anyone.
    if (!username.trim()) return;
    onLoggedIn();
  };

  return (
    <div className="login-screen">
      <form className="login-screen-panel" onSubmit={handleSubmit}>
        <h1>RF Web</h1>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button type="submit">Log in</button>
        <p className="login-screen-hint">Demo login - any username logs in.</p>
      </form>
    </div>
  );
}
