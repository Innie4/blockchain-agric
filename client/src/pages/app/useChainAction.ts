import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/errors";
import type { Prepared } from "../../api/types";
import type { TransactionPhase } from "../../components/states";
import {
  deserializeTransaction,
  useSignAndSerialize,
  walletErrorToApiError,
} from "../../context/WalletContext";

/**
 * The two-phase blockchain write, as a state machine.
 *
 * The server never holds a private key, so every write to the chain is three
 * steps: the server prepares an unsigned transaction against a live blockhash,
 * the participant's wallet signs it, and the server submits it and waits for
 * real confirmation. This hook owns those steps and every way they can end:
 * the wallet refuses, the wallet dialog is closed without an answer, the
 * blockhash expires, Solana rejects the transaction, confirmation takes too
 * long, or the network drops.
 *
 * Each of those is a distinct phase rather than one generic error, because each
 * one needs a different thing said to the participant and a different recovery
 * step. `TransactionState` renders whatever phase this reports.
 */

export interface ChainActionPreparation<TRecord> {
  /** The unsigned transaction and its deadline. */
  prepared: Prepared;
  /** Whatever the prepare call created, needed by the submit call. */
  record: TRecord;
}

export interface ChainActionSubmitInput<TRecord> {
  /**
   * The signed transaction, base64. An empty string means the action needed no
   * on-chain instruction at all, and the submit call is still made so the
   * server can close the record.
   */
  signedTransaction: string;
  record: TRecord;
}

export interface UseChainActionOptions<TRecord, TConfirmed> {
  /** Phase one. */
  prepare(): Promise<ChainActionPreparation<TRecord>>;
  /** Phase two. */
  submit(input: ChainActionSubmitInput<TRecord>): Promise<TConfirmed>;
  /** The signature to show, for pages that return one. */
  signatureOf?(confirmed: TConfirmed): string | null;
  /** The slot it confirmed in, when the server reports it. */
  slotOf?(confirmed: TConfirmed): number | null;
  /** Called once, after the submit call has succeeded. */
  onConfirmed?(confirmed: TConfirmed): void;
  /**
   * Called when the participant abandons a prepared action. It is the only
   * chance to tell the server the draft is being dropped.
   */
  onAbandon?(record: TRecord | null): void | Promise<void>;
}

export interface ChainAction<TRecord, TConfirmed> {
  phase: TransactionPhase;
  prepared: Prepared | null;
  /** What the prepare call created, for pages that need its identifier. */
  record: TRecord | null;
  /** What the submit call returned. */
  confirmed: TConfirmed | null;
  signature: string | null;
  slot: number | null;
  error: unknown;
  isBusy: boolean;
  /**
   * True when the last prepare produced no on-chain instruction, so no
   * signature is being asked for and none is needed.
   */
  isOffChainOnly: boolean;
  /** Phase one. */
  run(): void;
  /** The wallet prompt. */
  sign(): void;
  /** A fresh transaction, for a declined signature, an expiry or a failure. */
  retry(): void;
  /** Abandon the prepared action. */
  cancel(): void;
  /** Return to idle, keeping nothing. */
  reset(): void;
}

/** A message a provider uses when a blockhash has gone stale. */
const EXPIRED_BLOCKHASH = /blockhash|block hash|expired|has expired|stale/i;

/**
 * Decides which phase a thrown value belongs to.
 *
 * A declined signature and an expired blockhash are both ordinary outcomes of
 * asking a person to sign something, so neither is dressed up as a server
 * failure. Everything else is treated as a failure and left to the server's
 * own error vocabulary.
 */
function phaseForError(error: unknown): { phase: TransactionPhase; error: unknown } {
  const apiError = walletErrorToApiError(error);
  if (apiError.code === "WALLET_SIGNATURE_REJECTED") {
    return { phase: "signature-rejected", error: apiError };
  }
  if (
    apiError.code === "PRODUCT_STATE_INVALID" ||
    apiError.code === "BLOCKCHAIN_TRANSACTION_FAILED" ||
    apiError.code === "BLOCKCHAIN_ACCOUNT_NOT_FOUND"
  ) {
    if (EXPIRED_BLOCKHASH.test(apiError.message)) {
      return { phase: "timed-out", error: apiError };
    }
  }
  return { phase: "failed", error: apiError };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function useChainAction<TRecord, TConfirmed>(
  options: UseChainActionOptions<TRecord, TConfirmed>,
): ChainAction<TRecord, TConfirmed> {
  const signAndSerialize = useSignAndSerialize();

  const [phase, setPhase] = useState<TransactionPhase>("idle");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [record, setRecord] = useState<TRecord | null>(null);
  const [confirmed, setConfirmed] = useState<TConfirmed | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [isOffChainOnly, setIsOffChainOnly] = useState(false);

  const controllerRef = useRef<AbortController | null>(null);
  const expiryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // The latest options, so the callbacks below never close over a stale one.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      if (expiryRef.current !== null) clearTimeout(expiryRef.current);
    };
  }, []);

  const clearExpiry = useCallback((): void => {
    if (expiryRef.current !== null) {
      clearTimeout(expiryRef.current);
      expiryRef.current = null;
    }
  }, []);

  const startRequest = useCallback((): AbortController => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return controller;
  }, []);

  /**
   * Phase two. Signs with the wallet when there is anything to sign, then hands
   * the signed bytes to the server and waits for confirmation.
   */
  const submitPrepared = useCallback(
    async (preparation: ChainActionPreparation<TRecord>, signal: AbortSignal): Promise<void> => {
      const current = optionsRef.current;
      const needsSignature = preparation.prepared.transaction.trim().length > 0;

      if (!needsSignature) {
        setIsOffChainOnly(true);
      } else {
        setIsOffChainOnly(false);
      }

      let signedTransaction = "";
      if (needsSignature) {
        clearExpiry();
        setPhase("awaiting-signature");
        try {
          const transaction = deserializeTransaction(preparation.prepared.transaction);
          signedTransaction = await signAndSerialize(transaction);
        } catch (failure) {
          if (signal.aborted || isAbort(failure)) return;
          const classified = phaseForError(failure);
          setError(classified.error);
          setPhase(classified.phase);
          return;
        }
        if (signal.aborted) return;
        setPhase("submitted");
      }

      setPhase("confirming");
      try {
        const result = await current.submit({
          signedTransaction,
          record: preparation.record,
        });
        if (signal.aborted || !mountedRef.current) return;
        clearExpiry();
        setConfirmed(result);
        setSignature(current.signatureOf?.(result) ?? null);
        setSlot(current.slotOf?.(result) ?? null);
        setError(null);
        setPhase("confirmed");
        current.onConfirmed?.(result);
      } catch (failure) {
        if (signal.aborted || isAbort(failure)) return;
        const classified = phaseForError(failure);
        setError(classified.error);
        setPhase(classified.phase);
      }
    },
    [clearExpiry, signAndSerialize],
  );

  const run = useCallback((): void => {
    const current = optionsRef.current;
    const controller = startRequest();
    clearExpiry();
    setPhase("preparing");
    setError(null);
    setConfirmed(null);
    setSignature(null);
    setSlot(null);
    setIsOffChainOnly(false);
    setPrepared(null);
    setRecord(null);

    void current
      .prepare()
      .then((preparation) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        setPrepared(preparation.prepared);
        setRecord(preparation.record);

        // A transaction is only valid while its blockhash is live, and the
        // participant may take a while to reach their wallet. The deadline is
        // the server's `validForSeconds`, and reaching it is its own state
        // rather than a silent stall.
        const seconds = preparation.prepared.validForSeconds;
        if (seconds > 0 && preparation.prepared.transaction.trim().length > 0) {
          expiryRef.current = setTimeout(() => {
            expiryRef.current = null;
            if (!mountedRef.current) return;
            setError(
              new ApiError({
                code: "BLOCKCHAIN_TRANSACTION_FAILED",
                status: 0,
                message:
                  `This transaction was valid for about ${seconds} seconds and that time has ` +
                  "passed, so it can no longer be signed. Nothing was recorded.",
              }),
            );
            setPhase("timed-out");
          }, seconds * 1000);
        }

        void submitPrepared(preparation, controller.signal);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted || isAbort(failure)) return;
        const classified = phaseForError(failure);
        setError(classified.error);
        setPhase(classified.phase);
      });
  }, [clearExpiry, startRequest, submitPrepared]);

  const sign = useCallback((): void => {
    if (prepared === null || record === null) return;
    const controller = startRequest();
    void submitPrepared({ prepared, record }, controller.signal);
  }, [prepared, record, startRequest, submitPrepared]);

  const cancel = useCallback((): void => {
    const current = optionsRef.current;
    const abandoned = record;
    controllerRef.current?.abort();
    clearExpiry();
    setPrepared(null);
    setRecord(null);
    setConfirmed(null);
    setSignature(null);
    setSlot(null);
    setError(null);
    setIsOffChainOnly(false);
    setPhase("idle");
    if (abandoned !== null) {
      void Promise.resolve(current.onAbandon?.(abandoned)).catch(() => {
        // Abandoning is a local decision. If the server does not hear about it,
        // the draft is simply abandoned when its blockhash expires.
      });
    }
  }, [clearExpiry, record]);

  const reset = useCallback((): void => {
    controllerRef.current?.abort();
    clearExpiry();
    setPrepared(null);
    setRecord(null);
    setConfirmed(null);
    setSignature(null);
    setSlot(null);
    setError(null);
    setIsOffChainOnly(false);
    setPhase("idle");
  }, [clearExpiry]);

  return {
    phase,
    prepared,
    record,
    confirmed,
    signature,
    slot,
    error,
    isBusy: phase === "preparing" || phase === "submitted" || phase === "confirming",
    isOffChainOnly,
    run,
    sign,
    retry: run,
    cancel,
    reset,
  };
}
