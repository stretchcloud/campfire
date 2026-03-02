import { useState, useRef, useCallback, useEffect } from "react";

/**
 * Hook for browser-native speech-to-text via the Web Speech API.
 * Returns transcript text, listening state, and toggle controls.
 * Automatically restarts recognition on silence to support long dictation.
 */

// Type declarations for the Web Speech API (not in all TS libs)
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  }
}

export interface UseSpeechToTextReturn {
  /** Whether the browser supports the Web Speech API */
  isSupported: boolean;
  /** Whether we're currently listening */
  isListening: boolean;
  /** The most recent interim (partial) transcript */
  interimText: string;
  /** Start or stop listening */
  toggle: () => void;
  /** Force stop listening */
  stop: () => void;
}

export function useSpeechToText(
  onTranscript: (text: string) => void,
): UseSpeechToTextReturn {
  const SpeechRecognition =
    typeof window !== "undefined"
      ? window.SpeechRecognition || window.webkitSpeechRecognition
      : undefined;

  const isSupported = !!SpeechRecognition;
  const [isListening, setIsListening] = useState(false);
  const [interimText, setInterimText] = useState("");
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const shouldRestartRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const startRecognition = useCallback(() => {
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let final = "";
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
      if (final) {
        onTranscriptRef.current(final);
        setInterimText("");
      } else {
        setInterimText(interim);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // "no-speech" and "aborted" are expected during normal use
      if (event.error === "no-speech" || event.error === "aborted") return;
      console.warn("[SpeechToText] error:", event.error);
      shouldRestartRef.current = false;
      setIsListening(false);
      setInterimText("");
    };

    recognition.onend = () => {
      if (shouldRestartRef.current) {
        // Restart on silence to support long dictation
        try {
          recognition.start();
        } catch {
          shouldRestartRef.current = false;
          setIsListening(false);
          setInterimText("");
        }
      } else {
        setIsListening(false);
        setInterimText("");
      }
    };

    recognitionRef.current = recognition;
    shouldRestartRef.current = true;
    try {
      recognition.start();
      setIsListening(true);
    } catch {
      shouldRestartRef.current = false;
      setIsListening(false);
    }
  }, [SpeechRecognition]);

  const stop = useCallback(() => {
    shouldRestartRef.current = false;
    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }
    setIsListening(false);
    setInterimText("");
  }, []);

  const toggle = useCallback(() => {
    if (isListening) {
      stop();
    } else {
      startRecognition();
    }
  }, [isListening, stop, startRecognition]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      shouldRestartRef.current = false;
      recognitionRef.current?.abort();
    };
  }, []);

  return { isSupported, isListening, interimText, toggle, stop };
}
