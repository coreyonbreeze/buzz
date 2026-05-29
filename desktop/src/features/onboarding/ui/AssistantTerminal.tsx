import * as React from "react";

import type { LocalMessage } from "../lib/assistantSetupHelpers";
import type { AssistantQuickReply } from "../lib/personalAssistantProfile";

export function TerminalChoices({
  disabled,
  replies,
  onChoose,
}: {
  disabled: boolean;
  replies: AssistantQuickReply[];
  onChoose: (reply: AssistantQuickReply) => void;
}) {
  React.useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (disabled) {
        return;
      }
      const index = Number.parseInt(event.key, 10) - 1;
      const reply = replies[index];
      if (!reply) {
        return;
      }
      event.preventDefault();
      onChoose(reply);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [disabled, onChoose, replies]);

  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1">
      {replies.map((reply, index) => (
        <button
          className="text-left hover:text-white disabled:cursor-not-allowed disabled:text-white/35"
          disabled={disabled}
          key={reply.id}
          onClick={() => onChoose(reply)}
          type="button"
        >
          {index + 1}. {reply.label}
        </button>
      ))}
    </div>
  );
}

export function TerminalConversation({
  assistantName,
  messages,
}: {
  assistantName: string;
  messages: LocalMessage[];
}) {
  return (
    <div className="flex w-full flex-col gap-1 text-sm leading-6">
      <p className="text-white/70">sprout onboarding</p>
      <p className="text-white/70">agent: {assistantName}</p>
      {messages.map((message) => (
        <div key={message.id}>
          {message.role === "assistant" ? (
            <StreamedAssistantText id={message.id} text={message.text} />
          ) : (
            <>
              <span className="mr-2 text-white/70">you:</span>
              <span className="whitespace-pre-wrap text-white/70">
                {message.text}
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function StreamedAssistantText({ id, text }: { id: string; text: string }) {
  const [visibleText, setVisibleText] = React.useState("");
  const previousIdRef = React.useRef(id);

  React.useEffect(() => {
    if (previousIdRef.current !== id) {
      previousIdRef.current = id;
      setVisibleText("");
      return;
    }

    setVisibleText((current) => {
      if (text.startsWith(current)) {
        return current;
      }
      return "";
    });
  }, [id, text]);

  React.useEffect(() => {
    if (visibleText.length >= text.length) {
      return;
    }

    const interval = window.setInterval(() => {
      setVisibleText((current) => {
        if (current.length >= text.length) {
          window.clearInterval(interval);
          return current;
        }
        return text.slice(0, Math.min(text.length, current.length + 3));
      });
    }, 18);

    return () => window.clearInterval(interval);
  }, [text, visibleText.length]);

  return <span className="whitespace-pre-wrap text-white">{visibleText}</span>;
}
