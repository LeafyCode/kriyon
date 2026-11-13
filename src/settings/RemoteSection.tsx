/**
 * The Remote access page (ADR 0057): the switch with its consent screen, the
 * pairing of a new device, and the paired devices. A thin view over
 * `state/remote.ts`; Rust decides, checks and draws the QR code.
 */
import {
  type CSSProperties,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  onRemoteCodeWanted,
  type QrGrid,
  type RemoteDevice,
  type RemotePairing,
  type RemoteRole,
} from "../ipc/bridge.ts";
import {
  CONSENT_LINES,
  codeResultLine,
  countdownText,
  useRemote,
} from "../state/remote.ts";
import { button, inputBox } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import {
  ConfirmDialog,
  DialogPanel,
  dialogBodyStyle,
} from "../ui/ConfirmDialog.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { Switch } from "../ui/Switch.tsx";
import {
  errorTextStyle,
  rowHintStyle,
  SectionPage,
  SettingGroup,
  SettingRow,
} from "./SettingParts.tsx";

const ROLE_OPTIONS = [
  { label: "Viewer", value: "viewer" },
  { label: "Controller", value: "controller" },
] as const;

/** Said again where a Controller is chosen, not only on the consent screen. */
const CONTROLLER_WARNING =
  "A Controller can do anything you can do in a terminal: full shell access as you.";

const VIEWER_NOTE =
  "A Viewer sees every session's screen, including any secret printed there, but can't type.";

/** Modules of light margin around a QR code, as scanners expect. */
const QUIET_ZONE = 4;

const consentListStyle: CSSProperties = {
  ...dialogBodyStyle,
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.sm,
  paddingLeft: "18px",
};

const pairingStyle: CSSProperties = {
  alignItems: "flex-start",
  display: "flex",
  flexWrap: "wrap",
  gap: tokens.space.xl,
  padding: "14px 18px",
};

const pairingTextStyle: CSSProperties = {
  display: "flex",
  flex: "1 1 240px",
  flexDirection: "column",
  gap: tokens.space.md,
  minWidth: 0,
};

const qrStyle: CSSProperties = {
  borderRadius: tokens.radius.md,
  flex: "none",
  height: "196px",
  width: "196px",
};

const countdownStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontFamily: tokens.font.mono,
  fontSize: "13px",
};

const deviceNameStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontSize: "13px",
  fontWeight: 500,
};

const actionsStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: tokens.space.sm,
};

const codeInputStyle: CSSProperties = {
  ...inputBox(),
  color: tokens.color.ink.bright,
  fontFamily: tokens.font.mono,
  fontSize: "15px",
  letterSpacing: "0.2em",
  padding: "6px 10px",
  width: "11ch",
};

const nameInputStyle: CSSProperties = {
  ...inputBox(),
  color: tokens.color.ink.bright,
  fontSize: "13px",
  padding: "4px 8px",
};

/** A pairing invite's QR code, from the grid Rust drew. */
function QrCode({ grid }: { grid: QrGrid }) {
  const span = grid.size + QUIET_ZONE * 2;
  const modules: { x: number; y: number }[] = [];
  for (let index = 0; index < grid.dark.length; index += 1) {
    if (grid.dark[index] === "1") {
      modules.push({
        x: (index % grid.size) + QUIET_ZONE,
        y: Math.floor(index / grid.size) + QUIET_ZONE,
      });
    }
  }
  return (
    <svg
      aria-label="QR code for pairing a device"
      role="img"
      shapeRendering="crispEdges"
      style={qrStyle}
      viewBox={`0 0 ${span} ${span}`}
    >
      <rect fill={tokens.qr.light} height={span} width={span} />
      {modules.map(({ x, y }) => (
        <rect
          data-dark
          fill={tokens.qr.dark}
          height={1}
          key={`${x}:${y}`}
          width={1}
          x={x}
          y={y}
        />
      ))}
    </svg>
  );
}

/** "4:59" until `expiresAtMs`; asks Rust again once it passes. */
function Countdown({ expiresAtMs }: { expiresAtMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  const refresh = useRemote((state) => state.refresh);
  const over = now >= expiresAtMs;
  useEffect(() => {
    if (over) {
      refresh().catch(() => undefined);
      return;
    }
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [over, refresh]);
  return <span style={countdownStyle}>{countdownText(expiresAtMs, now)}</span>;
}

/** The consent screen: what changes, before anything does. */
function ConsentDialog() {
  const { cancelConsent, turnOn } = useRemote.getState();
  return (
    <DialogPanel
      actions={
        <>
          <button
            className="kr-hover-surface"
            onClick={cancelConsent}
            style={button("secondary")}
            type="button"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              turnOn().catch(() => undefined);
            }}
            style={button("primary")}
            type="button"
          >
            Turn on
          </button>
        </>
      }
      label="Cancel turning on remote access"
      onClose={cancelConsent}
      title="Turn on remote access?"
      wide
    >
      <ul style={consentListStyle}>
        {CONSENT_LINES.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </DialogPanel>
  );
}

/** The code field for the device that took the pairing. */
function CodeEntry({
  deviceName,
  expiresAtMs,
}: {
  deviceName: string;
  expiresAtMs: number;
}) {
  const [code, setCode] = useState("");
  const codeError = useRemote((state) => state.codeError);
  const codeResult = useRemote((state) => state.codeResult);
  const { enterCode, stopPairing } = useRemote.getState();
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    enterCode(code.trim()).catch(() => undefined);
    setCode("");
  };
  const line = codeError ?? (codeResult ? codeResultLine(codeResult) : null);
  return (
    <div style={pairingTextStyle}>
      <span>
        <span style={deviceNameStyle}>{deviceName}</span>{" "}
        <span style={rowHintStyle}>(named by the device)</span>
      </span>
      <span style={rowHintStyle}>
        Type the six-digit code it shows.{" "}
        <Countdown expiresAtMs={expiresAtMs} />
      </span>
      <form onSubmit={submit} style={actionsStyle}>
        <input
          aria-label="Pairing code"
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={6}
          onChange={(event) => setCode(event.target.value)}
          style={codeInputStyle}
          value={code}
        />
        <button style={button("primary")} type="submit">
          Confirm code
        </button>
        <button
          className="kr-hover-surface"
          onClick={() => {
            stopPairing().catch(() => undefined);
          }}
          style={button("secondary")}
          type="button"
        >
          Cancel
        </button>
      </form>
      {line ? <span style={rowHintStyle}>{line}</span> : null}
    </div>
  );
}

/** Choosing a role and starting a pairing, with why the last one ended. */
function StartPairing({ ended }: { ended: string | null }) {
  const [role, setRole] = useState<RemoteRole>("viewer");
  const { startPairing } = useRemote.getState();
  const note = role === "controller" ? CONTROLLER_WARNING : VIEWER_NOTE;
  return (
    <div style={pairingTextStyle}>
      {ended ? <span style={rowHintStyle}>{ended}</span> : null}
      <Segmented
        ariaLabel="Role for the new device"
        onChange={setRole}
        options={ROLE_OPTIONS}
        value={role}
      />
      <span style={rowHintStyle}>{note}</span>
      <div style={actionsStyle}>
        <button
          className="kr-hover-surface"
          onClick={() => {
            startPairing(role).catch(() => undefined);
          }}
          style={button("secondary")}
          type="button"
        >
          Pair a device
        </button>
      </div>
    </div>
  );
}

/** Why the last pairing ended, if it ended without pairing. */
function endedLine(pairing: RemotePairing): string | null {
  switch (pairing.state) {
    case "expired":
      return "The QR code expired. Pair again for a new one.";
    case "burned":
      return "Too many wrong codes. Pair again for a new QR code.";
    default:
      return null;
  }
}

function PairingGroup({ pairing }: { pairing: RemotePairing }) {
  const qr = useRemote((state) => state.qr);
  const { stopPairing } = useRemote.getState();
  if (pairing.state === "waiting") {
    return (
      <SettingGroup label="Pair a device">
        <div style={pairingStyle}>
          {qr ? <QrCode grid={qr} /> : null}
          <div style={pairingTextStyle}>
            <span style={rowHintStyle}>
              Scan this with the Kriyon app on the other device, as a{" "}
              {pairing.role === "controller" ? "Controller" : "Viewer"}. It
              shows a code to type here.
            </span>
            <Countdown expiresAtMs={pairing.expiresAtMs} />
            <div style={actionsStyle}>
              <button
                className="kr-hover-surface"
                onClick={() => {
                  stopPairing().catch(() => undefined);
                }}
                style={button("secondary")}
                type="button"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </SettingGroup>
    );
  }
  if (pairing.state === "codeWanted") {
    return (
      <SettingGroup label="Pair a device">
        <div style={pairingStyle}>
          <CodeEntry
            deviceName={pairing.deviceName}
            expiresAtMs={pairing.expiresAtMs}
          />
        </div>
      </SettingGroup>
    );
  }
  return (
    <SettingGroup label="Pair a device">
      <div style={pairingStyle}>
        <StartPairing ended={endedLine(pairing)} />
      </div>
    </SettingGroup>
  );
}

/** One paired device: its name (renamed in place), role, date and removal. */
function DeviceRow({
  device,
  onRemove,
}: {
  device: RemoteDevice;
  onRemove: (device: RemoteDevice) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const { rename, setRole } = useRemote.getState();
  const isEditing = editing !== null;
  // The field the person just asked for gets the keyboard.
  useEffect(() => {
    if (isEditing) {
      field.current?.focus();
    }
  }, [isEditing]);
  const paired = new Date(device.pairedAt).toLocaleDateString();
  const name =
    editing === null ? (
      <span style={deviceNameStyle}>{device.name}</span>
    ) : (
      <input
        aria-label={`Name for ${device.name}`}
        onChange={(event) => setEditing(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            rename(device.id, editing.trim()).catch(() => undefined);
            setEditing(null);
          } else if (event.key === "Escape") {
            setEditing(null);
          }
        }}
        ref={field}
        style={nameInputStyle}
        value={editing}
      />
    );
  return (
    <SettingRow
      control={
        <div style={actionsStyle}>
          <Segmented
            ariaLabel={`Role of ${device.name}`}
            onChange={(role) => {
              setRole(device.id, role).catch(() => undefined);
            }}
            options={ROLE_OPTIONS}
            value={device.role}
          />
          <button
            aria-label={`Rename ${device.name}`}
            className="kr-hover-surface"
            onClick={() => setEditing(device.name)}
            style={button("ghost", "sm")}
            type="button"
          >
            Rename
          </button>
          <button
            aria-label={`Remove ${device.name}`}
            className="kr-hover-surface"
            onClick={() => onRemove(device)}
            style={button("danger", "sm")}
            type="button"
          >
            Remove
          </button>
        </div>
      }
      hint={
        <>
          {name} Paired {paired}. Changing its role reconnects it.
        </>
      }
      label="Paired device"
    />
  );
}

function DevicesGroup({ devices }: { devices: RemoteDevice[] }) {
  const [removing, setRemoving] = useState<RemoteDevice | null>(null);
  const { remove } = useRemote.getState();
  if (devices.length === 0) {
    return (
      <SettingGroup label="Paired devices">
        <SettingRow control={null} hint="None yet." label="Paired devices" />
      </SettingGroup>
    );
  }
  return (
    <SettingGroup label="Paired devices">
      {devices.map((device) => (
        <DeviceRow device={device} key={device.id} onRemove={setRemoving} />
      ))}
      {removing ? (
        <ConfirmDialog
          body={`${removing.name} is cut off at once and forgotten. To use it again, pair it again.`}
          confirmLabel="Remove"
          label="Cancel removing the device"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            remove(removing.id).catch(() => undefined);
            setRemoving(null);
          }}
          title={`Remove ${removing.name}?`}
        />
      ) : null}
    </SettingGroup>
  );
}

export function RemoteSection() {
  const status = useRemote((state) => state.status);
  const devices = useRemote((state) => state.devices);
  const error = useRemote((state) => state.error);
  const consentOpen = useRemote((state) => state.consentOpen);
  useEffect(() => {
    const { load, refresh } = useRemote.getState();
    load().catch(() => undefined);
    const unlisten = onRemoteCodeWanted(() => {
      refresh().catch(() => undefined);
    });
    return () => {
      unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, []);
  const enabled = status?.enabled === true;
  const { askToTurnOn, turnOff } = useRemote.getState();
  return (
    <SectionPage
      id="remote"
      lead="Watch and type into your sessions from a phone or another computer you pair. Off by default."
    >
      <SettingGroup hideLabel label="Remote access">
        <SettingRow
          control={
            <Switch
              ariaLabel="Remote access"
              checked={enabled}
              onChange={(on) => {
                if (on) {
                  askToTurnOn();
                } else {
                  turnOff().catch(() => undefined);
                }
              }}
            />
          }
          hint={
            enabled
              ? "On: devices you paired can reach this computer."
              : "Off: this computer accepts no connections."
          }
          label="Remote access"
        />
        {error ? <span style={errorTextStyle}>{error}</span> : null}
      </SettingGroup>
      {enabled && status ? <PairingGroup pairing={status.pairing} /> : null}
      {enabled ? <DevicesGroup devices={devices} /> : null}
      {consentOpen ? <ConsentDialog /> : null}
    </SectionPage>
  );
}
