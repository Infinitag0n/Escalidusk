import { useEffect, useRef, useState } from "react";
import { appPath } from "./paths.js";

// The server's own limit; see MAX_FEEDBACK_CHARS in server/index.js.
const MAX_LENGTH = 4000;

/** The speech-bubble icon of the feedback button. */
export const feedbackIcon = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M8 9h8" />
    <path d="M8 13h6" />
    <path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z" />
  </svg>
);

/**
 * A small dialog over the editor for writing to whoever runs this server.
 * Only the words are sent: nothing about the diagram or the person.
 */
export function FeedbackDialog({ dark, onClose }) {
  const [message, setMessage] = useState("");
  // "writing", "sending", "sent", or "failed"
  const [state, setState] = useState("writing");
  const sent = state === "sent";
  const ref = useRef(null);
  // The Send button loses the keyboard while it is disabled for sending, so
  // hand it on: to Close once sent, back to the text after a failure.
  const settled = state !== "sending";
  useEffect(() => {
    if (settled) ref.current?.querySelector(sent ? ".feedback__actions button" : "textarea")?.focus();
  }, [sent, settled]);

  const send = async (event) => {
    event.preventDefault();
    setState("sending");
    try {
      const response = await fetch(appPath("/api/feedback"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
        redirect: "manual",
      });
      setState(response.ok ? "sent" : "failed");
    } catch {
      setState("failed");
    }
  };

  return (
    <div className="picker-backdrop" onPointerDown={onClose}>
      <div
        ref={ref}
        className={`picker feedback${dark ? " picker--dark" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Send feedback"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation(); // keep Excalidraw's shortcuts out of it
          if (event.key === "Escape") onClose();
        }}
      >
        <header>
          <h2>Send feedback</h2>
          <button type="button" className="picker__close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        {sent ? (
          <>
            <p className="feedback__thanks" role="status">
              Thank you. Your feedback was sent.
            </p>
            <div className="feedback__actions">
              <button type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={send}>
            <p className="picker__hint">
              What works, what does not, what is missing. It is sent without your name.
            </p>
            <textarea
              aria-label="Your feedback"
              rows={6}
              maxLength={MAX_LENGTH}
              value={message}
              onChange={(event) => {
                setMessage(event.target.value);
                if (state === "failed") setState("writing");
              }}
            />
            <div className="feedback__actions">
              {state === "failed" && (
                <span className="feedback__error" role="alert">
                  Could not send. Try again.
                </span>
              )}
              <button type="submit" disabled={!message.trim() || state === "sending"}>
                Send
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
