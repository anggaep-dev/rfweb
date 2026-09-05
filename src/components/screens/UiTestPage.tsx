import { useState } from 'react';
import { Button, Card, Dialog } from '../ui';
import type { ButtonVariant, ButtonSize } from '../ui';
import './UiTestPage.css';

export default function UiTestPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogLoading, setDialogLoading] = useState(false);
  const [draggableCardOpen, setDraggableCardOpen] = useState(true);
  const [confirmLoading, setConfirmLoading] = useState(false);

  const variants: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger'];
  const sizes: ButtonSize[] = ['sm', 'md', 'lg'];

  const handleDialogConfirm = () => {
    setDialogLoading(true);
    setTimeout(() => {
      setDialogLoading(false);
      setDialogOpen(false);
    }, 1500);
  };

  const handleConfirm = () => {
    setConfirmLoading(true);
    setTimeout(() => {
      setConfirmLoading(false);
      alert('Confirmed!');
    }, 1200);
  };

  return (
    <div className="uitest">
      <div className="uitest-header">
        <h1>Aether Mech HUD</h1>
        <span className="uitest-badge">UI TEST PAGE</span>
      </div>

      {/* ── Button Showcase ── */}
      <Card title="BUTTON" statusLed className="uitest-section">
        <div className="uitest-block">
          <h2 className="uitest-block-title">Variants × Sizes</h2>
          <table className="uitest-table">
            <thead>
              <tr>
                <th />
                {sizes.map((s) => (
                  <th key={s}>{s.toUpperCase()}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {variants.map((v) => (
                <tr key={v}>
                  <td className="uitest-label">{v}</td>
                  {sizes.map((s) => (
                    <td key={s}>
                      <Button variant={v} size={s}>
                        {v}
                      </Button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="uitest-block">
          <h2 className="uitest-block-title">States</h2>
          <div className="uitest-row">
            <Button variant="primary" disabled>
              Disabled
            </Button>
            <Button variant="secondary" loading>
              Loading
            </Button>
            <Button variant="primary" icon={<span>⚔</span>}>
              With Icon
            </Button>
            <Button variant="danger" size="sm">
              Delete
            </Button>
          </div>
        </div>
      </Card>

      {/* ── Card Showcase ── */}
      <Card title="CARD" statusLed className="uitest-section">
        <div className="uitest-block">
          <h2 className="uitest-block-title">Elevation Variants</h2>
          <div className="uitest-card-row">
            <Card variant="default" title="PANEL" className="uitest-demo-card">
              <p>Level 1 — Window substrate.</p>
              <p>Standard container for HUD panels.</p>
            </Card>
            <Card variant="elevated" title="ELEVATED" className="uitest-demo-card">
              <p>Level 2 — Gold glow border.</p>
              <p>Active / selected state.</p>
            </Card>
            <Card variant="recessed" title="RECESSED" className="uitest-demo-card">
              <p>Level 0 — Recessed slot.</p>
              <p>Equipment / inventory grid cells.</p>
            </Card>
          </div>
        </div>

        <div className="uitest-block">
          <h2 className="uitest-block-title">Card with Close & Actions</h2>
          <Card
            title="INVENTORY"
            statusLed
            headerActions={<Button variant="ghost" size="sm">Sort</Button>}
            onClose={() => alert('Close clicked')}
            className="uitest-demo-card-wide"
          >
            <p>Header with status LED, action slot, and close button.</p>
            <p>Capacity: <span className="uitest-mono">12 / 20</span></p>
          </Card>
        </div>

        <div className="uitest-block">
          <h2 className="uitest-block-title">Draggable + Confirm</h2>
          <div className="uitest-row">
            <Button variant="primary" size="sm" onClick={() => setDraggableCardOpen(true)}>
              Show Draggable Card
            </Button>
          </div>
        </div>
      </Card>

      {/* ── Draggable card (renders outside flow via position: fixed) ── */}
      {draggableCardOpen && (
        <Card
          title="DRAGGABLE PANEL"
          statusLed
          draggable
          defaultPosition={{ x: 80, y: 200 }}
          onClose={() => setDraggableCardOpen(false)}
          confirmLabel="Apply"
          onConfirm={handleConfirm}
          confirmLoading={confirmLoading}
        >
          <p>Drag this panel by its header to reposition it.</p>
          <p>Close button in the top-right corner.</p>
          <p>Confirm button at the bottom-right.</p>
          <hr className="uitest-divider" />
          <p className="uitest-muted">Try dragging it around the screen.</p>
        </Card>
      )}

      {/* ── Dialog Showcase ── */}
      <Card title="DIALOG" statusLed className="uitest-section">
        <div className="uitest-block">
          <h2 className="uitest-block-title">Trigger</h2>
          <div className="uitest-row">
            <Button variant="primary" onClick={() => setDialogOpen(true)}>
              Open Dialog
            </Button>
            <Button variant="secondary" onClick={() => setDialogOpen(true)}>
              Open Same
            </Button>
          </div>
        </div>
      </Card>

      {/* ── Dialog instance ── */}
      <Dialog
        open={dialogOpen}
        title="CONFIRM ACTION"
        onClose={() => {
          if (!dialogLoading) setDialogOpen(false);
        }}
        actions={[
          { label: 'Cancel', onClick: () => setDialogOpen(false), variant: 'secondary', disabled: dialogLoading },
          { label: 'Confirm', onClick: handleDialogConfirm, variant: 'primary', loading: dialogLoading },
        ]}
      >
        <p>This is an Aether Mech HUD dialog window.</p>
        <p>It features a window frame header with status LED, a scrollable body, and action buttons in the footer.</p>
        <p>Press <strong>Escape</strong> or click the backdrop to dismiss.</p>
        <hr className="uitest-divider" />
        <p className="uitest-muted">The confirm button simulates a 1.5s async operation with loading state.</p>
      </Dialog>
    </div>
  );
}