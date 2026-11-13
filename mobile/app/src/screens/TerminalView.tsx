/**
 * A session's real terminal: xterm.js in a web view (the terminal page),
 * fed by the session's stream from Rust. It only watches until this phone
 * holds typing control, and dims with typing off while the link is down.
 * Its size is the computer's: it never resizes the session there.
 */
import {
  type ComponentType,
  type RefAttributes,
  useEffect,
  useRef,
  useState,
} from "react";
import { Pressable, Text, View } from "react-native";
import { WebView, type WebViewProps } from "react-native-webview";
import { linkLine, noteLine } from "../../../../src/remote/remoteScreen.ts";
import { KriyonNative } from "../../modules/kriyon-native/index.ts";
import { toBase64, usePhone } from "../state/phone.ts";
import { TERMINAL_PAGE } from "../terminal/page.generated.ts";
import { readPageMessage } from "../terminal/protocol.ts";
import { colors, ui } from "../ui.ts";

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

  useEffect(() => {
    const frames = KriyonNative.addListener("onScreenFrame", (event) => {
      if (event.hostId === hostId && event.sessionId === sessionId) {
        runIn(
          { fresh, page, ready, waiting },
          `window.kriyon.frame("${toBase64(event.frame)}")`
        );
      }
    });
    const { closeSession, openSession } = usePhone.getState();
    openSession(hostId, sessionId).catch((error: unknown) =>
      setNote(reasonOf(error))
    );
    return () => {
      frames.remove();
      closeSession(hostId, sessionId).catch(() => undefined);
    };
  }, [hostId, sessionId]);

  useEffect(() => {
    runIn({ fresh, page, ready, waiting }, `window.kriyon.typing(${typing})`);
  }, [typing]);

  /** The page loaded (again): send what waited, or the session afresh. */
  const pageReady = () => {
    loads.current += 1;
    ready.current = true;
    const queued = waiting.current.splice(0);
    if (loads.current > 1 || fresh.current) {
      // A new page, or frames dropped: ask for the whole screen again.
      fresh.current = false;
      const { closeSession, openSession } = usePhone.getState();
      closeSession(hostId, sessionId).catch(() => undefined);
      openSession(hostId, sessionId).catch((error: unknown) =>
        setNote(reasonOf(error))
      );
      page.current?.injectJavaScript(`window.kriyon.typing(${typing});true;`);
      return;
    }
    for (const script of queued) {
      page.current?.injectJavaScript(`${script};true;`);
    }
  };

  return (
    <View style={{ flex: 1, gap: 8 }}>
      <View style={{ alignItems: "center", flexDirection: "row", gap: 10 }}>
        {connected ? (
          <Text style={[ui.hint, { flex: 1 }]}>
            {roleLine(typing, controller)}
          </Text>
        ) : (
          <Text style={[ui.hint, { color: colors.statusWaiting, flex: 1 }]}>
            {linkLine(host?.link ?? "connecting")}
          </Text>
        )}
        {connected && controller && session && session.typing !== "you" ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              KriyonNative.takeControl(hostId, sessionId).catch(
                (error: unknown) => setNote(reasonOf(error))
              );
            }}
            style={ui.ghostButton}
          >
            <Text style={ui.ghostButtonText}>Take control</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={{ flex: 1, opacity: connected ? 1 : 0.5 }}>
        <Page
          hideKeyboardAccessoryView
          keyboardDisplayRequiresUserAction={false}
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
            } else if (message?.type === "input") {
              KriyonNative.input(
                hostId,
                sessionId,
                utf8.encode(message.data)
              ).catch((error: unknown) => setNote(reasonOf(error)));
            } else if (message?.type === "note") {
              setNote(noteLine(message.note));
            }
          }}
          originWhitelist={["about:blank"]}
          ref={page}
          source={PAGE_SOURCE}
          style={{ backgroundColor: colors.chromeWindow }}
        />
      </View>
      {note ? <Text style={ui.hint}>{note}</Text> : null}
    </View>
  );
}
