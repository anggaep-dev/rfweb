import './DebugPanel.css';

export interface CommandConsoleProps {
  commandInput: string;
  onCommandInputChange: (value: string) => void;
  onCommandSubmit: () => void;
  commandFeedback: string;
}

/** Bottom-right GM command bar (e.g. "%addbot 5") - see ViewerScene.runCommand for the supported commands. */
export default function CommandConsole({
  commandInput,
  onCommandInputChange,
  onCommandSubmit,
  commandFeedback,
}: CommandConsoleProps) {
  return (
    <div className="debug-panel-command-bar">
      <input
        type="text"
        className="debug-panel-command-input"
        placeholder="GM command, e.g. %addbot 5"
        value={commandInput}
        onChange={(e) => onCommandInputChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCommandSubmit();
        }}
      />
      {commandFeedback && <span className="debug-panel-command-feedback">{commandFeedback}</span>}
    </div>
  );
}
