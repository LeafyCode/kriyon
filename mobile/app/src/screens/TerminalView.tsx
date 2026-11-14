/**
 * A session's real terminal: xterm.js in a web view (the terminal page),
 * fed by the session's stream from Rust, in the phone's light or dark. It
 * only watches until this phone holds typing control; then the type field
 * and the extra keys (esc, tab, ctrl, arrows) send to the computer. It dims
 * with typing off while the link is down. Its size is the computer's: it
 * never resizes the session there.
 */
import {
  type ComponentType,
  type RefAttributes,
  useEffect,
  useRef,
  useState,
} from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { WebView, type WebViewProps } from "react-native-webview";
import { linkLine, noteLine } from "../../../../src/remote/remoteScreen.ts";
import { KriyonNative } from "../../modules/kriyon-native/index.ts";
import { Button, IconButton, KEY_TEXT_MAX, useLook } from "../kit.tsx";
import { KEYS, typedLine } from "../state/keys.ts";
import { toBase64, usePhone } from "../state/phone.ts";
import { TERMINAL_PAGE } from "../terminal/page.generated.ts";
import { readPageMessage } from "../terminal/protocol.ts";
import { fonts, useMode } from "../theme.ts";

/** What the page's web view lets the app do. */
interface PageHandle {
  injectJavaScript: (script: string) => void;
  reload: () => void;
}

/**
 * The web view, with its ref typed. react-native-webview 14 declares it a
 * function component without one, but it takes a ref, which is how
 * injectJavaScript is reached.
 */
const Page = WebView as unknown as ComponentType<
  WebViewProps & RefAttributes<PageHandle>
>;

/** One source for every render, so the page is never loaded again by it. */
const PAGE_SOURCE = { html: TERMINAL_PAGE };

/**
 * Scripts kept for a page still loading. Past this many, they are dropped
 * and the session opened again once the page is ready: a fresh screen says
 * everything the dropped frames would have.
 */
const MAX_WAITING = 256;

/** The page and the scripts waiting for it. */
interface PageScripts {
  /** Frames were dropped: ask for the session afresh once ready. */
  fresh: { current: boolean };
  page: { current: PageHandle | null };
  ready: { current: boolean };
  waiting: { current: string[] };
}

/** Run `script` in the page now, or once it says it is ready. */
function runIn(scripts: PageScripts, script: string): void {
  const { fresh, page, ready, waiting } = scripts;
  if (ready.current && page.current) {
    page.current.injectJavaScript(`${script};true;`);
    return;
  }
  if (waiting.current.length >= MAX_WAITING) {
    waiting.current = [];
    fresh.current = true;
  }
  waiting.current.push(script);
}

/** What this phone may do here while the link is up. */
function roleLine(typing: boolean, controller: boolean): string {
  if (typing) {
    return "You have control. Type below.";
  }
  return controller ? "Watching." : "This phone may only watch.";
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Typed text as the bytes the terminal expects. */
const utf8 = new TextEncoder();

export function TerminalView({
  hostId,
  sessionId,
}: {
  hostId: string;
  sessionId: string;
}) {
  const page = useRef<PageHandle>(null);
  const ready = useRef(false);
  const waiting = useRef<string[]>([]);
  const fresh = useRef(false);
  const loads = useRef(0);
  const [note, setNote] = useState<string | null>(null);
  const host = usePhone((state) => state.states[hostId]);
  const session = host?.sessions.find((one) => one.id === sessionId);
  const typing = Boolean(session?.mayType);
  const connected = host?.link === "connected";
  const controller = host?.role === "controller";
  const mode = useMode();
  const { t, text } = useLook();
  const [line, setLine] = useState("");
  const [ctrl, setCtrl] = useState(false);
  const themeScript = `window.kriyon.theme("${mode}", "${t.bg}")`;

  useEffect(() => {
    const frames = KriyonNative.addListener("onScreenFrame", (event) => {
      if (event.hostId === hostId && event.sessionId === sessionId) {
        runIn(
          { fresh, page, ready, waiting },
          `window.kriyon.frame("${toBase64(event.frame)}")`
        );
      }
    });
    // The session is open already (its screen's): this turns its screen on
    // while shown, off when it goes.
    const { hideScreen, showScreen } = usePhone.getState();
    showScreen(hostId, sessionId).catch((error: unknown) =>
      setNote(reasonOf(error))
    );
    return () => {
      frames.remove();
      hideScreen(hostId, sessionId).catch(() => undefined);
    };
  }, [hostId, sessionId]);

  // The page follows the phone's light or dark.
  useEffect(() => {
    runIn({ fresh, page, ready, waiting }, themeScript);
  }, [themeScript]);

  /**
   * The field's line: with ctrl held, its control key; else typed, then
   * Enter after a beat, as the desktop sends a prompt.
   */
  const submit = () => {
    const text = line;
    setLine("");
    if (ctrl) {
      setCtrl(false);
      send(typedLine(text, true));
      return;
    }
    usePhone
      .getState()
      .sendMessage(hostId, sessionId, text)
      .catch((error: unknown) => setNote(reasonOf(error)));
  };

  /** Send `bytes` to the session, saying why if it can't go. */
  const send = (bytes: Uint8Array) => {
    if (bytes.length === 0) {
      return;
    }
    KriyonNative.input(hostId, sessionId, bytes).catch((error: unknown) =>
      setNote(reasonOf(error))
    );
  };

  /** The page loaded (again): send what waited, or the session afresh. */
  const pageReady = () => {
    loads.current += 1;
    ready.current = true;
    const queued = waiting.current.splice(0);
    if (loads.current > 1 || fresh.current) {
      // A new page, or frames dropped: ask for the whole screen again, on
      // the same open session.
      fresh.current = false;
      usePhone
        .getState()
        .showScreen(hostId, sessionId)
        .catch((error: unknown) => setNote(reasonOf(error)));
      page.current?.injectJavaScript(`${themeScript};true;`);
      return;
    }
    for (const script of queued) {
      page.current?.injectJavaScript(`${script};true;`);
    }
  };

  const key = (label: string, bytes: string, accessibilityLabel: string) => (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      key={label}
      onPress={() => send(utf8.encode(bytes))}
      style={({ pressed }) => ({
        alignItems: "center",
        backgroundColor: pressed ? t.lineStrong : t.overlay,
        borderColor: t.lineStrong,
        borderRadius: 8,
        borderWidth: 1,
        flex: 1,
        justifyContent: "center",
        minHeight: 44,
      })}
    >
      <Text
        maxFontSizeMultiplier={KEY_TEXT_MAX}
        numberOfLines={1}
        style={{ color: t.ink1, fontFamily: fonts.mono, fontSize: 13 }}
      >
        {label}
      </Text>
    </Pressable>
  );

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          alignItems: "center",
          flexDirection: "row",
          gap: 10,
          minHeight: 44,
          paddingHorizontal: 16,
          paddingVertical: 4,
        }}
      >
        <Text
          style={[
            text.caption,
            { color: connected ? t.ink2 : t.amberInk, flex: 1 },
          ]}
        >
          {connected
            ? roleLine(typing, controller)
            : linkLine(host?.link ?? "connecting")}
        </Text>
        {connected && controller && session && session.typing !== "you" ? (
          <Button
            kind="ghost"
            label="Take control"
            onPress={() => {
              KriyonNative.takeControl(hostId, sessionId).catch(
                (error: unknown) => setNote(reasonOf(error))
              );
            }}
          />
        ) : null}
      </View>
      <View
        style={{
          backgroundColor: t.bg,
          flex: 1,
          opacity: connected ? 1 : 0.5,
          paddingHorizontal: 10,
        }}
      >
        <Page
          accessibilityLabel="Terminal screen"
          hideKeyboardAccessoryView
          onContentProcessDidTerminate={() => {
            // iOS ended the page's process: load it again.
            ready.current = false;
            page.current?.reload();
          }}
          onLoadStart={() => {
            ready.current = false;
          }}
          onMessage={(event) => {
            const message = readPageMessage(event.nativeEvent.data);
            if (message?.type === "ready") {
              pageReady();
            } else if (message?.type === "note") {
              setNote(noteLine(message.note));
            }
          }}
          originWhitelist={["about:blank"]}
          ref={page}
          source={PAGE_SOURCE}
          style={{ backgroundColor: t.bg }}
          // The terminal's grid is measured in its own font: Android's
          // text zoom (the phone's text size) would overlap its rows.
          textZoom={100}
        />
      </View>
      {note ? (
        <Text
          style={[text.caption, { paddingHorizontal: 16, paddingVertical: 6 }]}
        >
          {note}
        </Text>
      ) : null}
      {typing ? (
        <>
          <View
            accessibilityLabel="Keys"
            accessibilityRole="toolbar"
            style={{
              backgroundColor: t.card,
              borderTopColor: t.line,
              borderTopWidth: 1,
              flexDirection: "row",
              gap: 6,
              padding: 8,
            }}
          >
            {KEYS.slice(0, 2).map((k) =>
              key(k.label, k.bytes, k.accessibilityLabel)
            )}
            <Pressable
              accessibilityLabel="Control"
              accessibilityRole="switch"
              accessibilityState={{ checked: ctrl }}
              onPress={() => setCtrl((held) => !held)}
              style={{
                alignItems: "center",
                backgroundColor: ctrl ? t.accentSoft : t.overlay,
                borderColor: ctrl ? t.accentLine : t.lineStrong,
                borderRadius: 8,
                borderWidth: 1,
                flex: 1,
                justifyContent: "center",
                minHeight: 44,
              }}
            >
              <Text
                maxFontSizeMultiplier={KEY_TEXT_MAX}
                numberOfLines={1}
                style={{
                  color: ctrl ? t.accentInk : t.ink1,
                  fontFamily: fonts.mono,
                  fontSize: 13,
                }}
              >
                ctrl
              </Text>
            </Pressable>
            {KEYS.slice(2).map((k) =>
              key(k.label, k.bytes, k.accessibilityLabel)
            )}
          </View>
          <View
            style={{
              alignItems: "center",
              backgroundColor: t.rail,
              borderTopColor: t.overlay,
              borderTopWidth: 1,
              flexDirection: "row",
              gap: 8,
              paddingHorizontal: 12,
              paddingVertical: 10,
            }}
          >
            <TextInput
              accessibilityLabel="Type into the terminal"
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setLine}
              onSubmitEditing={submit}
              placeholder={ctrl ? "A letter for ctrl-…" : "Type, then Enter"}
              placeholderTextColor={t.muted}
              returnKeyType="send"
              style={{
                backgroundColor: t.card,
                borderColor: t.accentLine,
                borderRadius: 22,
                borderWidth: 1,
                color: t.ink,
                flex: 1,
                fontFamily: fonts.mono,
                fontSize: 15,
                minHeight: 44,
                minWidth: 0,
                paddingHorizontal: 14,
              }}
              submitBehavior="submit"
              value={line}
            />
            <IconButton
              color={t.onAccent}
              icon="enter"
              label="Enter"
              onPress={submit}
              tint={t.accent}
            />
          </View>
        </>
      ) : null}
    </View>
  );
}
