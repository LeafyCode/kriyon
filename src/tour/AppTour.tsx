import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTour } from "../state/tour.ts";
import { button } from "../theme/recipes.ts";
import { accentAlpha, tokens } from "../theme/tokens.ts";
import { Kbd } from "../ui/Kbd.tsx";
import { type Box, placeCard, type Size, spotlightRect } from "./placement.ts";
import { TOUR_STEPS, type TourStep, tourTarget } from "./steps.ts";

/** How long a first run waits for the window to settle before starting. */
const FIRST_RUN_DELAY_MS = 900;
/** Panels slide open over about this long; measure again once they have. */
const SETTLE_MS = 340;
/** The card's width; its height follows its text. */
const CARD_WIDTH = 344;
/** The glide between steps, shared by the spotlight and the card. */
const GLIDE = "460ms cubic-bezier(0.22, 1, 0.36, 1)";

const layerStyle: CSSProperties = {
  inset: 0,
  position: "fixed",
  zIndex: tokens.z.overlay,
};

/** Takes every click outside the card, so the tour is never half-dismissed
 *  by a stray press on the app below. */
const blockerStyle: CSSProperties = { inset: 0, position: "absolute" };

function spotlightStyle(rect: Box, found: boolean): CSSProperties {
  return {
    borderRadius: found ? tokens.radius.xl : "50%",
    boxShadow: found
      ? `0 0 0 9999px ${tokens.color.scrim}, 0 0 0 1.5px ${tokens.color.accent}, 0 0 28px 2px ${accentAlpha(0.35)}`
      : `0 0 0 9999px ${tokens.color.scrim}`,
    height: rect.height,
    left: rect.left,
    pointerEvents: "none",
    position: "absolute",
    top: rect.top,
    transition: `top ${GLIDE}, left ${GLIDE}, width ${GLIDE}, height ${GLIDE}, border-radius ${GLIDE}, box-shadow ${GLIDE}`,
    width: rect.width,
  };
}

const ringStyle: CSSProperties = {
  animation: "kr-tour-ring 1.8s cubic-bezier(0.22, 1, 0.36, 1) infinite",
  border: `1.5px solid ${tokens.color.accent}`,
  borderRadius: "inherit",
  inset: 0,
  position: "absolute",
};

function cardStyle(left: number, top: number): CSSProperties {
  return {
    animation: "kr-pop-in 0.28s cubic-bezier(0.22, 1, 0.36, 1) both",
    background: tokens.color.chrome.overlay,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.xl,
    boxShadow: tokens.shadow.pop,
    color: tokens.color.text,
    display: "flex",
    flexDirection: "column",
    fontFamily: tokens.font.sans,
    gap: "14px",
    left,
    padding: "18px",
    position: "absolute",
    top,
    transition: `top ${GLIDE}, left ${GLIDE}`,
    width: CARD_WIDTH,
  };
}

const headStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: "12px",
  justifyContent: "space-between",
};

const iconTileStyle: CSSProperties = {
  alignItems: "center",
  animation: "kr-tour-icon 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both",
  background: accentAlpha(0.16),
  border: `1px solid ${accentAlpha(0.32)}`,
  borderRadius: tokens.radius.lg,
  color: tokens.color.accentBright,
  display: "flex",
  height: "34px",
  justifyContent: "center",
  width: "34px",
};

const counterStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
  letterSpacing: "0.04em",
};

const stepBodyStyle: CSSProperties = {
  animation: "kr-fade-up 0.36s cubic-bezier(0.22, 1, 0.36, 1) both",
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const titleStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontSize: "15px",
  fontWeight: 600,
  letterSpacing: "-0.01em",
  margin: 0,
};

const textStyle: CSSProperties = {
  color: tokens.color.ink.secondary,
  fontSize: "12.5px",
  lineHeight: 1.55,
  margin: 0,
};

const keysStyle: CSSProperties = {
  display: "flex",
  gap: "6px",
  marginTop: "4px",
};

/** Skip on the left, Back and Next on the right — three short buttons, so
 *  they always fit the card with room to spare. */
const footStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: "8px",
  justifyContent: "flex-end",
  marginTop: "2px",
};

/** The dots and the "3 of 14" count, together in the header's right side. */
const progressStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: "10px",
  minWidth: 0,
};

const dotsStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: "4px",
};

type DotState = "done" | "current" | "ahead";

function dotState(at: number, current: number): DotState {
  if (at === current) {
    return "current";
  }
  return at < current ? "done" : "ahead";
}

function dotStyle(state: DotState): CSSProperties {
  return {
    background:
      state === "ahead" ? tokens.color.line.strong : tokens.color.accent,
    borderRadius: tokens.radius.pill,
    height: "5px",
    opacity: state === "done" ? 0.45 : 1,
    transition: `width ${GLIDE}, background ${GLIDE}, opacity ${GLIDE}`,
    width: state === "current" ? "16px" : "5px",
  };
}

const skipStyle: CSSProperties = {
  ...button("ghost", "sm"),
  // Pushes Back and Next to the right edge.
  marginRight: "auto",
};
const secondaryStyle = button("secondary", "sm");
const primaryStyle = button("primary", "sm");

/** The on-screen box of the step's target, or null when it has none or the
 *  target is not showing (absent, `display: none`, collapsed to nothing).
 *  Several elements may carry one target — the Details panel and its
 *  collapsed rail — and the one showing wins. */
function measureTarget(step: TourStep): Box | null {
  const selector = tourTarget(step);
  if (!selector) {
    return null;
  }
  for (const element of document.querySelectorAll(selector)) {
    const rect = element.getBoundingClientRect();
    if (rect.width >= 1 && rect.height >= 1) {
      return {
        height: rect.height,
        left: rect.left,
        top: rect.top,
        width: rect.width,
      };
    }
  }
  return null;
}

function viewportSize(): Size {
  return { height: window.innerHeight, width: window.innerWidth };
}

function sameBox(a: Box | null, b: Box | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.top === b.top &&
      a.left === b.left &&
      a.width === b.width &&
      a.height === b.height)
  );
}

/** Measure the step's target now, again once panels settle, and on resize. */
function useStepGeometry(step: TourStep) {
  const [target, setTarget] = useState<Box | null>(() => measureTarget(step));
  const [viewport, setViewport] = useState<Size>(viewportSize);

  const measure = useCallback(() => {
    const next = measureTarget(step);
    setTarget((prev) => (sameBox(prev, next) ? prev : next));
    setViewport((prev) => {
      const size = viewportSize();
      return prev.width === size.width && prev.height === size.height
        ? prev
        : size;
    });
  }, [step]);

  useLayoutEffect(() => {
    measure();
    const settle = window.setTimeout(measure, SETTLE_MS);
    window.addEventListener("resize", measure);
    return () => {
      window.clearTimeout(settle);
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  return { target, viewport };
}

function TourLayer({ index }: { index: number }) {
  const step = TOUR_STEPS[index] as TourStep;
  const isFirst = index === 0;
  const isLast = index === TOUR_STEPS.length - 1;
  const { target, viewport } = useStepGeometry(step);
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [cardHeight, setCardHeight] = useState(0);

  // The card's height follows its text; read it back so placement can keep
  // the whole card on screen.
  useLayoutEffect(() => {
    setCardHeight(cardRef.current?.offsetHeight ?? 0);
  });

  // Keep the keyboard on the card: the primary button takes focus, so Enter
  // moves on and nothing types into the terminal underneath. It is the same
  // button on every step, so it keeps focus as the steps change.
  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const tour = useTour.getState();
      const actions: Record<string, () => void> = {
        ArrowLeft: tour.back,
        ArrowRight: tour.next,
        Escape: tour.finish,
      };
      const action = actions[event.key];
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        action();
      }
    };
    // Capture, so the keys reach the tour before a focused terminal or editor.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const placement = placeCard(
    target,
    { height: cardHeight, width: CARD_WIDTH },
    viewport,
    step.side ?? "right"
  );
  const Icon = step.icon;
  const titleId = `tour-title-${step.id}`;
  const { back, finish, next } = useTour.getState();

  return (
    <div data-testid="app-tour" style={layerStyle}>
      <div aria-hidden="true" style={blockerStyle} />
      <div
        aria-hidden="true"
        data-found={target ? "true" : "false"}
        data-testid="tour-spotlight"
        style={spotlightStyle(spotlightRect(target, viewport), target !== null)}
      >
        {target ? <span style={ringStyle} /> : null}
      </div>
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        data-side={placement.side}
        ref={cardRef}
        role="dialog"
        style={cardStyle(placement.left, placement.top)}
      >
        {/* The header outlives the steps, so the dots glide from one step to
            the next; only the icon is keyed, to land afresh each step. */}
        <div style={headStyle}>
          <span key={step.id} style={iconTileStyle}>
            <Icon size={17} strokeWidth={1.75} />
          </span>
          <div style={progressStyle}>
            <div aria-hidden="true" style={dotsStyle}>
              {TOUR_STEPS.map((dot, at) => (
                <span key={dot.id} style={dotStyle(dotState(at, index))} />
              ))}
            </div>
            <span style={counterStyle}>
              {index + 1} of {TOUR_STEPS.length}
            </span>
          </div>
        </div>
        <div key={step.id} style={stepBodyStyle}>
          <h2 id={titleId} style={titleStyle}>
            {step.title}
          </h2>
          <p style={textStyle}>{step.body}</p>
          {step.keys ? (
            <div style={keysStyle}>
              {step.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </div>
          ) : null}
        </div>
        <div style={footStyle}>
          {isLast ? null : (
            <button
              className="kr-hover-surface"
              onClick={finish}
              style={skipStyle}
              type="button"
            >
              Skip tour
            </button>
          )}
          {isFirst ? null : (
            <button
              className="kr-hover-surface"
              onClick={() => {
                back();
                // Back is gone on the first step; don't drop focus with it.
                primaryRef.current?.focus();
              }}
              style={secondaryStyle}
              type="button"
            >
              Back
            </button>
          )}
          <button
            className="kr-hover-accent"
            onClick={next}
            ref={primaryRef}
            style={primaryStyle}
            type="button"
          >
            {isLast ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The [App tour]: a spotlight that glides from one part of the window to the
 * next, with a card saying what each part is for. Opens on its own once for
 * anyone who has never seen it; any time after, from Help → Kriyon Tour, the
 * command palette or Settings.
 */
export function AppTour() {
  const stepIndex = useTour((state) => state.stepIndex);
  const layoutLoaded = useTour((state) => state.layoutLoaded);

  useEffect(() => {
    if (!layoutLoaded) {
      return;
    }
    const timer = window.setTimeout(
      () => useTour.getState().startIfUnseen(),
      FIRST_RUN_DELAY_MS
    );
    return () => window.clearTimeout(timer);
  }, [layoutLoaded]);

  return stepIndex === null ? null : <TourLayer index={stepIndex} />;
}
