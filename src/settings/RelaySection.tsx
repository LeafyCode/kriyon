/**
 * Our relay (paid), inside Remote access: device sign-in, the switch, the
 * subscription from the relay account, and its devices. Hidden in a build
 * without a relay. A thin view over `state/relay.ts`; Rust signs in, keeps
 * the pass and decides.
 */
import { type CSSProperties, useEffect, useState } from "react";
import { onRelayChanged, type RelayDevice } from "../ipc/bridge.ts";
import {
  SAME_ACCOUNT_NOTE,
  subscribeLabel,
  subscriptionLine,
  useRelay,
} from "../state/relay.ts";
import { button } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { Switch } from "../ui/Switch.tsx";
import {
  errorTextStyle,
  rowHintStyle,
  SettingGroup,
  SettingRow,
} from "./SettingParts.tsx";

const blockStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.md,
  padding: "14px 18px",
};

const actionsStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: tokens.space.sm,
};

const userCodeStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontFamily: tokens.font.mono,
  fontSize: "18px",
  letterSpacing: "0.15em",
};

const monoStyle: CSSProperties = {
  fontFamily: tokens.font.mono,
};

/** Signed out: the device sign-in, or the code while it waits. */
function SignInBlock() {
  const signIn = useRelay((state) => state.view?.signIn ?? null);
  const { cancelSignIn, signIn: start } = useRelay.getState();
  if (signIn) {
    return (
      <div style={blockStyle}>
        <span style={rowHintStyle}>
          Your browser opened the sign-in page. Check it shows this code, then
          approve:
        </span>
        <span style={userCodeStyle}>{signIn.userCode}</span>
        <span style={rowHintStyle}>
          No browser? Go to{" "}
          <span style={monoStyle}>{signIn.verificationUri}</span> and type the
          code.
        </span>
        <div style={actionsStyle}>
          <button
            className="kr-hover-surface"
            onClick={() => {
              cancelSignIn().catch(() => undefined);
            }}
            style={button("secondary")}
            type="button"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <div style={blockStyle}>
      <span style={rowHintStyle}>
        When no direct path works, devices can reach this computer through our
        relay. It needs a subscription.
      </span>
      <span style={rowHintStyle}>{SAME_ACCOUNT_NOTE}</span>
      <div style={actionsStyle}>
        <button
          className="kr-hover-accent"
          onClick={() => {
            start().catch(() => undefined);
          }}
          style={button("primary")}
          type="button"
        >
          Sign in
        </button>
      </div>
    </div>
  );
}

/** The relay account's devices, this computer marked. */
function RelayDevices() {
  const account = useRelay((state) => state.account);
  const mine = useRelay((state) => state.thisDeviceKey);
  const [removing, setRemoving] = useState<RelayDevice | null>(null);
  const { removeDevice } = useRelay.getState();
  if (!account) {
    return null;
  }
  return (
    <>
      {account.devices.map((device) => (
        <SettingRow
          control={
            <button
              aria-label={`Remove ${device.name}`}
              className="kr-hover-surface"
              onClick={() => setRemoving(device)}
              style={button("ghost", "sm")}
              type="button"
            >
              Remove
            </button>
          }
          hint={`${device.name}${device.deviceKey === mine ? " (this computer)" : ""}, ${device.platform}.`}
          key={device.deviceId}
          label="Relay device"
        />
      ))}
      <SettingRow
        control={null}
        hint={`${account.devices.length} of ${account.deviceLimit} devices.`}
        label="Devices on the relay account"
      />
      {removing ? (
        <ConfirmDialog
          body={`${removing.name} stops using our relay within about a minute. It stays paired: same Wi-Fi and Tailscale links keep working until you unpair it.`}
          confirmLabel="Remove"
          label="Cancel removing the relay device"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            removeDevice(removing.deviceId).catch(() => undefined);
            setRemoving(null);
          }}
          title={`Remove ${removing.name} from our relay?`}
        />
      ) : null}
    </>
  );
}

/** Signed in: the switch, the subscription and the devices. */
function SignedInBlock({ on }: { on: boolean }) {
  const account = useRelay((state) => state.account);
  const { openSubscriptions, setOn, signOut } = useRelay.getState();
  return (
    <>
      <SettingRow
        control={
          <Switch
            ariaLabel="Our relay"
            checked={on}
            onChange={(next) => {
              setOn(next).catch(() => undefined);
            }}
          />
        }
        hint={
          on
            ? "On: devices that can't reach this computer directly go through our relay."
            : "Off: devices reach this computer directly only."
        }
        label="Our relay"
      />
      <SettingRow
        control={
          <div style={actionsStyle}>
            <button
              className="kr-hover-surface"
              onClick={() => {
                openSubscriptions().catch(() => undefined);
              }}
              style={button("secondary", "sm")}
              type="button"
            >
              {subscribeLabel(account)}
            </button>
            <button
              className="kr-hover-surface"
              onClick={() => {
                signOut().catch(() => undefined);
              }}
              style={button("ghost", "sm")}
              type="button"
            >
              Sign out
            </button>
          </div>
        }
        hint={
          <>
            {account ? subscriptionLine(account) : "Reading the subscription…"}{" "}
            {SAME_ACCOUNT_NOTE}
          </>
        }
        label="Subscription"
      />
      <RelayDevices />
    </>
  );
}

export function RelaySection() {
  const view = useRelay((state) => state.view);
  const error = useRelay((state) => state.error);
  useEffect(() => {
    const { load } = useRelay.getState();
    load().catch(() => undefined);
    const unlisten = onRelayChanged(() => {
      load().catch(() => undefined);
    });
    return () => {
      unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, []);
  if (!view?.available) {
    return null;
  }
  const problem = error ?? view.problem;
  return (
    <SettingGroup label="Our relay (paid)">
      {view.signedIn ? <SignedInBlock on={view.on} /> : <SignInBlock />}
      {problem ? <span style={errorTextStyle}>{problem}</span> : null}
    </SettingGroup>
  );
}
